// Hand-authored pixel art. Every sprite is a character grid you can edit in
// place — one character per pixel, palette beside it. Run `pnpm sprites` to
// rebuild public/sprites/*.png (committed, so the app never draws at runtime).
//
// Conventions:
//   .  transparent
//   grids are 16×16 unless noted; scale is set per sprite in build.mjs
//
// Zero OS palette, shared by every icon (the same tokens as styles/tokens.css).
// Cool grey plastic + very light cyan. There is deliberately NO green and no
// lime: the phosphor and the "recycle" chevrons are cyan too.
//   k #10171b (ink)      w #ffffff (white)    g #dbe3e5 (plastic)
//   d #aab7bb (shade)    b #12788e (deep cyan) c #8fdfee (light cyan)
//   y #d9a441 (amber)    r #c4553f (red)      n #45bcd4 (mid cyan)
//   t #b6ecf6 (phosphor) m #8b9aa0 (faint ink) f #cdf1f8 (cyan fill)

export const PALETTE = {
  k: '#10171b',
  w: '#ffffff',
  g: '#dbe3e5',
  d: '#aab7bb',
  b: '#12788e',
  c: '#8fdfee',
  y: '#d9a441',
  r: '#c4553f',
  n: '#45bcd4',
  t: '#b6ecf6',
  m: '#8b9aa0',
  f: '#cdf1f8',
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

  // A mains plug with a cable — "Connect a laptop" (pairing).
  connect: [
    '................',
    '....kk....kk....',
    '....kk....kk....',
    '..kkkkkkkkkkkk..',
    '..kggggggggggk..',
    '..kgccccccccgk..',
    '..kgccccccccgk..',
    '..kggggggggggk..',
    '..kkkkkkkkkkkk..',
    '......kcck......',
    '......kcck......',
    '.......kk.......',
    '......kcck......',
    '......kcck......',
    '.......kk.......',
    '................',
  ],

  // A magnifier over a page — "Deep research".
  research: [
    '................',
    '.....kkkk.......',
    '...kkccccckk....',
    '..kccwwwwcck....',
    '..kcwwwwwwck....',
    '..kcwwbbwwck....',
    '..kcwwwwwwck....',
    '..kccwwwwcck....',
    '..kkccccckk.....',
    '.......kkk......',
    '.........kkk....',
    '...........kkk..',
    '.............kk.',
    '................',
    '................',
    '................',
  ],
}
