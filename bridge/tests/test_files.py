"""File-service tests, with an emphasis on containment: the browser gets a file
API on a machine it does not own, so escaping the root must be impossible.
"""

from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from forge_audit import AuditLog  # noqa: E402
from forge_files import FileError, FileService  # noqa: E402


class FileServiceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name).resolve()
        (self.root / "src").mkdir()
        (self.root / "src" / "app.ts").write_text("export const a = 1\nexport const b = 2\n")
        (self.root / "README.md").write_text("# Forge\nhello world\n")
        (self.root / "big.log").write_text("\n".join("line %d" % i for i in range(1, 1001)))
        (self.root / "crlf.txt").write_bytes(b"alpha\r\nbeta\r\ngamma\r\n")
        (self.root / "binary.bin").write_bytes(b"\x00\x01\x02\xff" * 10)
        self.audit = AuditLog(self.root / ".audit.log")
        self.files = FileService(roots=[str(self.root)], audit=self.audit)

    def tearDown(self):
        self._tmp.cleanup()

    # -- containment -------------------------------------------------------
    def test_dotdot_escape_is_refused(self):
        with self.assertRaises(FileError) as ctx:
            self.files.list(str(self.root / ".." / ".."))
        self.assertEqual(ctx.exception.code, "FS_OUTSIDE_ROOT")
        self.assertEqual(ctx.exception.status, 403)

    def test_symlink_escape_is_refused(self):
        outside = Path(tempfile.gettempdir()) / "forge-outside-target"
        outside.write_text("secret")
        link = self.root / "escape"
        try:
            os.symlink(str(outside), str(link))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaises(FileError) as ctx:
            self.files.read(str(link))
        self.assertEqual(ctx.exception.code, "FS_OUTSIDE_ROOT")

    def test_empty_and_nul_paths_are_refused(self):
        for bad in ("", "   "):
            with self.assertRaises(FileError):
                self.files.stat(bad)
        with self.assertRaises(FileError):
            self.files.stat(str(self.root / "x\x00y"))

    def test_relative_paths_resolve_inside_the_root(self):
        result = self.files.read("README.md")
        self.assertEqual(result["path"], str(self.root / "README.md"))

    def test_roots_are_reported(self):
        info = self.files.roots_info()
        self.assertEqual(info["roots"][0]["path"], str(self.root))
        self.assertIn("separator", info)

    # -- reading -----------------------------------------------------------
    def test_list_sorts_directories_first_and_reports_truncation(self):
        result = self.files.list(str(self.root))
        names = [entry["name"] for entry in result["entries"]]
        self.assertEqual(names[0], "src", "directories should sort first: %s" % names)
        self.assertIn("README.md", names)
        limited = self.files.list(str(self.root), limit=2)
        self.assertTrue(limited["truncated"])
        self.assertEqual(len(limited["entries"]), 2)

    def test_read_returns_numbered_lines_and_a_window(self):
        result = self.files.read(str(self.root / "big.log"), offset=10, limit=5)
        self.assertEqual(result["count"], 5)
        self.assertEqual(result["lines"][0]["number"], 11)
        self.assertEqual(result["lines"][0]["text"], "line 11")
        self.assertEqual(result["totalLines"], 1000)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["nextOffset"], 15)

    def test_read_detects_binary_instead_of_mojibake(self):
        result = self.files.read(str(self.root / "binary.bin"))
        self.assertEqual(result["encoding"], "binary")
        self.assertEqual(result["content"], "")
        self.assertTrue(result["previewBase64"])

    def test_read_reports_crlf(self):
        result = self.files.read(str(self.root / "crlf.txt"))
        self.assertEqual(result["eol"], "\r\n")

    def test_missing_file_is_a_404_shaped_error(self):
        with self.assertRaises(FileError) as ctx:
            self.files.read(str(self.root / "nope.txt"))
        self.assertEqual(ctx.exception.code, "FS_NOT_FOUND")
        self.assertEqual(ctx.exception.status, 404)

    def test_reading_a_directory_is_refused(self):
        with self.assertRaises(FileError) as ctx:
            self.files.read(str(self.root / "src"))
        self.assertEqual(ctx.exception.code, "FS_IS_DIR")

    def test_glob_finds_nested_matches_and_skips_node_modules(self):
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules" / "dep.ts").write_text("x")
        result = self.files.glob(str(self.root), "*.ts")
        self.assertIn(str(self.root / "src" / "app.ts"), result["matches"])
        self.assertNotIn(str(self.root / "node_modules" / "dep.ts"), result["matches"])

    def test_grep_finds_text_with_line_numbers(self):
        result = self.files.grep(str(self.root), "hello world")
        self.assertTrue(result["matches"])
        match = result["matches"][0]
        self.assertEqual(match["line"], 2)
        self.assertEqual(Path(match["path"]).name, "README.md")
        self.assertIn(result["engine"], ("rg", "python"))

    def test_grep_without_a_pattern_is_refused(self):
        with self.assertRaises(FileError):
            self.files.grep(str(self.root), "")

    # -- writing -----------------------------------------------------------
    def test_write_creates_parents_and_leaves_no_temp_file(self):
        target = self.root / "deep" / "nested" / "note.txt"
        result = self.files.write(str(target), "hello")
        self.assertEqual(result["bytes"], 5)
        self.assertEqual(target.read_text(), "hello")
        self.assertFalse(list(target.parent.glob("*.forge-tmp")))

    def test_edit_requires_a_unique_match(self):
        path = self.root / "src" / "app.ts"
        with self.assertRaises(FileError) as ctx:
            self.files.edit(str(path), "export const", "const")
        self.assertEqual(ctx.exception.code, "FS_EDIT_AMBIGUOUS")
        self.assertEqual(ctx.exception.status, 409)

        result = self.files.edit(str(path), "export const a = 1", "export const a = 42")
        self.assertEqual(result["replacements"], 1)
        self.assertIn("a = 42", path.read_text())

    def test_edit_replace_all_counts_every_replacement(self):
        path = self.root / "src" / "app.ts"
        result = self.files.edit(str(path), "export const", "const", replace_all=True)
        self.assertEqual(result["replacements"], 2)
        self.assertNotIn("export const", path.read_text())

    def test_edit_preserves_crlf_endings(self):
        path = self.root / "crlf.txt"
        self.files.edit(str(path), "beta", "BETA")
        self.assertEqual(path.read_bytes(), b"alpha\r\nBETA\r\ngamma\r\n")

    def test_edit_rejects_missing_and_identical(self):
        path = self.root / "README.md"
        with self.assertRaises(FileError) as ctx:
            self.files.edit(str(path), "not present", "x")
        self.assertEqual(ctx.exception.code, "FS_EDIT_NOT_FOUND")
        with self.assertRaises(FileError):
            self.files.edit(str(path), "# Forge", "# Forge")

    def test_upload_download_round_trip(self):
        payload = bytes(range(256)) * 4
        target = self.root / "round.bin"
        self.files.upload(
            str(target), base64.b64encode(payload).decode("ascii")
        )
        result = self.files.download(str(target))
        self.assertEqual(base64.b64decode(result["contentBase64"]), payload)
        self.assertEqual(result["size"], len(payload))

    def test_upload_append(self):
        target = self.root / "append.txt"
        self.files.upload(str(target), base64.b64encode(b"one").decode())
        self.files.upload(str(target), base64.b64encode(b"two").decode(), append=True)
        self.assertEqual(target.read_text(), "onetwo")

    def test_upload_rejects_bad_base64(self):
        with self.assertRaises(FileError) as ctx:
            self.files.upload(str(self.root / "x.bin"), "!!!not base64!!!")
        self.assertEqual(ctx.exception.code, "FS_BAD_BASE64")

    def test_delete_refuses_the_root(self):
        with self.assertRaises(FileError) as ctx:
            self.files.delete(str(self.root))
        self.assertEqual(ctx.exception.code, "FS_FORBIDDEN")

    def test_delete_removes_file_and_tree(self):
        self.files.delete(str(self.root / "README.md"))
        self.assertFalse((self.root / "README.md").exists())
        self.files.delete(str(self.root / "src"))
        self.assertFalse((self.root / "src").exists())

    # -- audit -------------------------------------------------------------
    def test_mutations_are_audited_and_reads_are_not_content_logged(self):
        self.files.write(str(self.root / "audit.txt"), "super secret content")
        self.files.list(str(self.root))
        entries = self.audit.recent(20)
        actions = [entry["action"] for entry in entries]
        self.assertIn("fs.write", actions)
        self.assertIn("fs.list", actions)
        blob = "\n".join(str(entry) for entry in entries)
        self.assertNotIn("super secret content", blob)

    def test_audit_log_records_one_json_line_per_action(self):
        self.files.write(str(self.root / "one.txt"), "1")
        self.files.write(str(self.root / "two.txt"), "2")
        entries = self.audit.recent(10)
        writes = [entry for entry in entries if entry["action"] == "fs.write"]
        self.assertGreaterEqual(len(writes), 2)
        for entry in writes:
            self.assertIn("ts", entry)
            self.assertIn("path", entry)


if __name__ == "__main__":
    unittest.main(verbosity=2)
