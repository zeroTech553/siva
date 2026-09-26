/**
 * zero-logo.tsx — the Zero OS mark, drawn as inline SVG.
 *
 * Inline rather than a PNG on purpose: it inherits `currentColor`, stays sharp
 * at every size (the CRT is 190 px wide on a phone and 900 px on a laptop), and
 * costs no extra request. `image-rendering: pixelated` is applied by the CSS of
 * the bitmap sprites in public/sprites/, never here.
 *
 * The mark is a slashed zero — the "0" of Zero OS — inside a soft square.
 */

export function ZeroMark({
  size = 32,
  className = '',
  title = 'Zero OS',
}: {
  size?: number | string
  className?: string
  title?: string
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      focusable="false"
    >
      {/* bezel */}
      <rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="none" stroke="currentColor" strokeWidth="2.5" />
      {/* the zero */}
      <ellipse cx="16" cy="16" rx="7" ry="9.5" fill="none" stroke="currentColor" strokeWidth="3" />
      {/* the slash */}
      <path d="M10.5 22.5 L21.5 9.5" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
      {/* power LED */}
      <circle cx="26" cy="26" r="1.8" fill="currentColor" opacity="0.85" />
    </svg>
  )
}

export function ZeroLogo({
  scale = 1,
  tagline = '',
  className = '',
}: {
  /** 1 = compact (title bars, footer), 2 = splash screen. */
  scale?: number
  tagline?: string
  className?: string
}) {
  return (
    <span className={`zos-logo zos-logo-${scale} ${className}`.trim()}>
      <ZeroMark size={20 * scale} className="zos-logo-mark" />
      <span className="zos-logo-text">
        <strong>Zero&nbsp;OS</strong>
        {tagline ? <em>{tagline}</em> : null}
      </span>
    </span>
  )
}

/**
 * The four-pane loader mark shown during the OS-loader boot stage — an homage
 * to 90s boot screens, drawn from scratch in the Zero palette (no trademarks).
 */
export function LoaderPanes({ className = '' }: { className?: string }) {
  const panes = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ]
  return (
    <svg viewBox="0 0 44 34" width="44" height="34" className={className} aria-hidden="true" focusable="false">
      <g transform="skewX(-9)">
        {panes.map((pane, index) => (
          <rect
            key={index}
            x={4 + pane.x * 19}
            y={2 + pane.y * 16}
            width="16"
            height="13"
            rx="1.5"
            className={`zos-pane zos-pane-${index + 1}`}
          />
        ))}
      </g>
    </svg>
  )
}
