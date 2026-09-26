# `components/computer/` — the machine and the operating system on its screen

This folder is the whole "real computer" half of the product: a small **front-view** chassis with a
CRT, a keyboard that types, a mouse that moves a pointer, a boot sequence, and a 90s-style OS with a
real window manager. Nothing here is a picture of an interface — every pixel is React state.

It is used in two places, with the same component:

```tsx
// components/landing/hero-section.tsx  — small, on a pegboard, four windows
<ZeroComputer size="sm">{(machine) => <HeroOs machine={machine} … />}</ZeroComputer>

// components/console/console-frame.tsx — full size, the whole product
<ZeroComputer size="lg" busy={agent.working} functionRow>
  {(machine) => <ConsoleOs machine={machine} … />}
</ZeroComputer>
```

`ZeroComputer` owns power, boot, brightness, mute, the CD tray, the disk LED, the pointer and both
peripherals. What you pass back in (`children`) is what appears **inside the glass** once the boot
finishes — usually `ZeroOs`.

## The three layers

```
zero-computer.tsx        the composition root: chassis + screen + keyboard + mouse, and the
                         pointer plumbing (physical mouse deltas → screen percentages → real DOM clicks)
zero-logo.tsx            the Zero OS mark, inline SVG at any scale (boot splash, nav, footer)

boot/                    what happens between ⏻ and the desktop
  boot-stages.ts         PURE DATA: the stage list (off → bios → windows → zeroos → desktop, plus a
                         'safe' power-off screen), durations, POST lines, loader text, splash copy
  boot-screen.tsx        draws a stage: firmware POST → Zero OS loader → logo splash → desktop

hardware/                the physical machine
  use-machine.ts         power state machine (off/post/loader/splash/desktop), brightness, mute,
                         CD tray, disk LED, pointer mode, OSD, boot memory (sessionStorage),
                         reduced-motion fast boot. This is the "real hardware" behaviour.
  machine-shell.tsx      bezel, brand plate, bays (floppy/CD), knobs, LEDs, power + reset caps
  crt-screen.tsx         the tube: glass, scanlines, pixel grid, vignette, glare, the software pointer
  keyboard.tsx           every cap is a real button; Shift/Caps latch; window-level keydown listeners
                         mirror a physical keyboard onto those caps; typing goes into the focused field
  key-layout.ts          PURE DATA: the cap grid, labels, shift/alt values, the function row
  key-bus.ts             the pub/sub bus that lets a real keypress and an on-screen cap drive the
                         exact same code path (hardwareKeys.emit / .subscribe)
  dom-input.ts           how a cap press becomes text in whatever has focus (input, textarea, xterm)
  mouse.tsx              the physical mouse: drag to move, left/right buttons, wheel
  use-hardware-keys.ts   subscribe an app INSIDE the CRT to the physical keyboard; zero-os.tsx uses it
                         for Alt+Tab (cycle windows), Escape (close menus) and the arrow keys

os/                      the operating system inside the glass
  window-manager.ts      PURE REDUCER: (state, action) → state. open/close/focus/minimize/maximize/
                         move/resize/rename/cascade/tile/minimizeAll/restoreAll/cycle. No React, no
                         DOM, no timers — that is why tests/window-manager.test.mjs can exist.
  use-window-manager.ts  the reducer bound to React + drag/resize pointer handling
  zero-os.tsx            the desktop: icons, windows, taskbar, start menu, context menu, clock,
                         the shutdown dialog, and the OsApp context (useOsApp())
  os-window.tsx          title bar, caption buttons, body, resize grip
  os-taskbar.tsx         Start ▸ programs/arrange/shut down, task buttons, tray
  os-menu.tsx            start menu + the desktop right-click menu
  os-shutdown.tsx        the classic "Shut down / Restart / Cancel" dialog and the safe-to-power-off screen
  os-ui.tsx              the widgets every app uses: OsButton, OsCaptionButton, OsField, OsSelect,
                         OsTextarea, OsCheck, OsGroup, OsNote, OsPill, OsSprite
```

## Adding an app to the desktop

An app is a value, not a component tree — declare it where the machine is used
(`components/landing/hero-os.tsx`, `components/console/console-os.tsx`):

```ts
const apps: OsApp[] = [
  {
    id: 'terminal',            // stable; apps are single-instance by id
    title: 'Terminal — zero-os',
    short: 'Terminal',         // taskbar label
    sprite: 'terminal',        // public/sprites/<name>.png (see pixel/sprites.mjs)
    autostart: true,           // open itself once the desktop appears
    desktopIcon: true,         // default true
    rect: { x: 12, y: 8, w: 74, h: 72 },   // percent of the desktop area
    status: 'demo shell',      // shown in the window's status bar
    body: <MyApp />,           // anything
  },
]
```

Inside `body`, use `useOsApp()` to reach the window manager (`openApp('files')`, `closeApp(id)`,
`isOpen(id)`) — that is how the demo shell's `open files` command works. Geometry is in **percent**,
so the same `rect` is right on a 292px hero CRT and a 720px console CRT; everything inside the glass
is sized in `cqw` against the screen.

## The rules this folder keeps

- **Front view, small.** The chassis is drawn from the front (`size: sm | md | lg` = 292 / 400 /
  720px max width). It must fit a phone screen without scrolling.
- **Very slight pixelation.** The CRT overlays are faint on purpose (scanlines ~5%, pixel grid ~4%).
  Raise them and the text stops being readable; that is the whole point of the numbers.
- **No lime, no green.** The accent is a very light cyan (`--zero-cyan-1..5` in `styles/tokens.css`)
  and even the terminal phosphor is cyan. Sprites share that palette (`pixel/sprites.mjs`).
- **Pure state transitions.** Boot, windows, power, LEDs and sound are all state changes. No video,
  no canvas, no GIF, no image of a UI.
- **Real hardware affordances.** A cap you cannot click, a knob that does nothing, or a window that
  cannot be dragged is a bug — the machine has to behave like a machine.

## Where the pixels and the colours live

| You want to change… | Edit |
| --- | --- |
| a colour, a font, a shadow | `styles/tokens.css` (rethemes everything) |
| the chassis, CRT, keyboard, mouse | `styles/computer.css` (`.zc-*`, `.mk-*`, `.mm-*`) |
| desktop, windows, taskbar, menus, widgets | `styles/os.css` (`.zos-*`, `.os-*`) |
| an app's own content | `styles/apps.css` (`.pair-*`, `.cli-*`, `.prompt-*`, `.demo-term-*`, …) |
| an icon | `pixel/sprites.mjs` (a 16×16 character grid), then `pnpm sprites` |
| boot text, timings, stage order | `components/computer/boot/boot-stages.ts` |
| the keyboard's caps | `components/computer/hardware/key-layout.ts` |
| window behaviour | `components/computer/os/window-manager.ts` + `tests/window-manager.test.mjs` |

After any change here: `pnpm typecheck && pnpm test && pnpm build`. The build must still report
`○ /` and `○ /console` as static — see the cost rules in `docs/repo-layout.md`.
