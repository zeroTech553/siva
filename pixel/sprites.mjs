// Hand-authored pixel art. Every sprite is a character grid you can edit in
// place — one character per pixel, palette beside it. Run `pnpm sprites` to
// rebuild public/sprites/*.png (committed, so the app never draws at runtime).
//
// Conventions:
//   .  transparent
//   grids are 16×16 unless noted; scale is set per sprite in build.mjs
//
// Win95-ish palette shared by most icons:
//   k #071e28 (ink)     w #ffffff (white)   g #b8b8b8 (silver)
//   d #6e6e6e (shadow)  b #2456a8 (blue)    c #3fa7c4 (cyan)
//   y #e8c34a (amber)   r #c44536 (red)     n #2d5b46 (green)
//   t #58d858 (terminal green)              m #8a5a2b (manila dark)
//   f #e0b96a (manila)

export const PALETTE = {
  k: '#071e28',
  w: '#ffffff',
  g: '#b8b8b8',
  d: '#6e6e6e',
  b: '#2456a8',
  c: '#3fa7c4',
  y: '#e8c34a',
  r: '#c44536',
  n: '#2d5b46',
  t: '#58d858',
  m: '#8a5a2b',
  f: '#e0b96a',
}

export const SPRITES = {
  // A CRT monitor on a base — "My Computer".
  computer: [
    '................',
    '.kkkkkkkkkkkkk..',
    '.kggggggggggdk..',
    '.kgbbbbbbbbbdk..',
    '.kgbccbbbbbbdk..',
    '.kgbbbbbbbbbdk..',
    '.kgbbbbbbwbbdk..',
    '.kgbbbbbbbbbdk..',
    '.kgddddddddddk..',
    '.kkkkkkkkkkkkk..',
    '....kggggk......',
    '..kkkkkkkkkk....',
    '.kggggggggggk...',
    '.kgyk.....kgk...',
    '.kkkkkkkkkkkk...',
    '................',
  ],

  // Dark screen, green prompt — the Terminal.
  terminal: [
    '................',
    '.kkkkkkkkkkkkkk.',
    '.kggggggggggggk.',
    '.kgkkkkkkkkkkgk.',
    '.kgkttk.....kgk.',
    '.kgk.ttk....kgk.',
    '.kgk..ttk...kgk.',
    '.kgk.ttk....kgk.',
    '.kgkttk..tttkgk.',
    '.kgk........kgk.',
    '.kgkkkkkkkkkkgk.',
    '.kggggggggggggk.',
    '.kkkkkkkkkkkkkk.',
    '....kg....gk....',
    '..kkkkkkkkkkkk..',
    '................',
  ],

  // Manila folder with a lifted tab — the File Manager.
  files: [
    '................',
    '................',
    '.kkkkkk.........',
    'kffffffk........',
    'kfffffffkkkkkkk.',
    'kffffffffffffffk',
    'kfmmmmmmmmmmmmfk',
    'kffffffffffffffk',
    'kffffffffffffffk',
    'kffffffffffffffk',
    'kffffffffffffffk',
    'kffffffffffffffk',
    'kfmmmmmmmmmmmmfk',
    'kffffffffffffffk',
    '.kkkkkkkkkkkkkk.',
    '................',
  ],

  // A compact disc — the CD Player.
  player: [
    '................',
    '.....kkkkkk.....',
    '...kkggggggkk...',
    '..kggwggggggwk..',
    '.kgwggggggggggk.',
    '.kggggggggggcgk.',
    'kggggggkkggggcgk',
    'kgggggkwwkgggggk',
    'kgggggkwwkgggggk',
    'kgcggggkkggggggk',
    '.kgcggggggggggk.',
    '.kggggggggggwgk.',
    '..kwggggggggwk..',
    '...kkggggggkk...',
    '.....kkkkkk.....',
    '................',
  ],

  // Waste basket with the recycling chevrons.
  recycle: [
    '................',
    '....kkkkkkkk....',
    '...kggggggggk...',
    '..kkkkkkkkkkkk..',
    '..kggggggggggk..',
    '..kgnggggggngk..',
    '..kggnggggnggk..',
    '...kggngngngk...',
    '...kgggnnnggk...',
    '...kggngngngk...',
    '....kgngggnk....',
    '....kggggggk....',
    '....kggggggk....',
    '.....kkkkkk.....',
    '................',
    '................',
  ],

  // Sliders on a panel — the Control Panel.
  setup: [
    '................',
    '.kkkkkkkkkkkkkk.',
    '.kggggggggggggk.',
    '.kgkkkkkkkkkkgk.',
    '.kgggyggggggggk.',
    '.kgkkkkkkkkkkgk.',
    '.kggggggggygggk.',
    '.kgkkkkkkkkkkgk.',
    '.kggyggggggggk..',
    '.kgkkkkkkkkkkgk.',
    '.kggggggggggggk.',
    '.kgrgg.tgg.bggk.',
    '.kggggggggggggk.',
    '.kkkkkkkkkkkkkk.',
    '................',
    '................',
  ],

  // A friendly boxy robot head — the Agent.
  agent: [
    '................',
    '.......kk.......',
    '......kyyk......',
    '..kkkkkkkkkkkk..',
    '.kggggggggggggk.',
    '.kgkkgggggkkggk.',
    'kkgkckgggkckgkk.',
    'kggkkkgggkkkggk.',
    'kggggggggggggggk',
    'kggkkkkkkkkkkggk',
    '.kgkrrrrrrrrkgk.',
    '.kgkkkkkkkkkkgk.',
    '.kggggggggggggk.',
    '..kkkkkkkkkkkk..',
    '....kg....gk....',
    '................',
  ],
}
