#!/usr/bin/env node
// Build public/sprites/*.png from the pixel maps in sprites.mjs.
//
//   pnpm sprites
//
// No image libraries: PNGs are assembled by hand (zlib from node:zlib) so the
// pipeline works offline and the output is deterministic. Each pixel becomes
// a SCALE×SCALE block; browsers keep edges crisp via image-rendering:
// pixelated in CSS.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PALETTE, SPRITES } from './sprites.mjs'

const SCALE = 4 // 16px grid -> 64px PNG
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sprites')

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function buildPng(grid, scale) {
  const rows = grid.length
  const cols = grid[0].length
  for (const [index, row] of grid.entries()) {
    if (row.length !== cols) throw new Error(`row ${index} is ${row.length} wide, expected ${cols}`)
  }
  const width = cols * scale
  const height = rows * scale

  // Raw RGBA scanlines, each prefixed with filter byte 0.
  const raw = Buffer.alloc(height * (1 + width * 4))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    const row = grid[Math.floor(y / scale)]
    for (let x = 0; x < width; x += 1) {
      const symbol = row[Math.floor(x / scale)]
      if (symbol !== '.') {
        const color = PALETTE[symbol]
        if (!color) throw new Error(`unknown palette symbol '${symbol}'`)
        const [r, g, b] = hexToRgb(color)
        raw[offset] = r
        raw[offset + 1] = g
        raw[offset + 2] = b
        raw[offset + 3] = 255
      }
      offset += 4
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, grid] of Object.entries(SPRITES)) {
  const png = buildPng(grid, SCALE)
  writeFileSync(join(OUT_DIR, `${name}.png`), png)
  console.log(`sprites/${name}.png  ${grid[0].length * SCALE}×${grid.length * SCALE}  ${png.length} bytes`)
}

// The favicon is the computer sprite (Next.js app/icon.png convention).
const ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icon.png')
writeFileSync(ICON_PATH, buildPng(SPRITES.computer, 2))
console.log('app/icon.png  32×32 (favicon)')
