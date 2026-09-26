import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

/**
 * Fonts are self-hosted from `assets/fonts` (SIL Open Font License, see the
 * LICENSE-*.txt files next to them) on purpose:
 *
 *   1. `next/font/google` downloads at build time, so a build fails whenever
 *      fonts.googleapis.com is unreachable (CI egress rules, air-gapped builds).
 *   2. Self-hosting removes a third-party request from every page view.
 *
 * Three faces, one job each — keep it that way:
 *   --font-os    Silkscreen      bitmap face for the retro OS chrome (titles, buttons, taskbar)
 *   --font-mono  IBM Plex Mono   terminal, paths, prompts, code
 *   --font-sans  Archivo         long-form copy and marketing text
 */
const osFont = localFont({
  src: [
    { path: '../assets/fonts/silkscreen-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../assets/fonts/silkscreen-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-silkscreen',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
})

const monoFont = localFont({
  src: [
    { path: '../assets/fonts/ibm-plex-mono-latin-400.woff2', weight: '400', style: 'normal' },
    { path: '../assets/fonts/ibm-plex-mono-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-ibm',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
})

const sansFont = localFont({
  src: [
    { path: '../assets/fonts/archivo-latin-variable.woff2', weight: '100 900', style: 'normal' },
    { path: '../assets/fonts/archivo-latin-variable-italic.woff2', weight: '100 900', style: 'italic' },
  ],
  variable: '--font-archivo',
  display: 'swap',
  fallback: ['Arial', 'sans-serif'],
})

export const metadata: Metadata = {
  title: 'Forge — your computer, in your pocket',
  description:
    'Run one command on your laptop, then drive its real terminal, its files and its coding CLIs — Claude Code, Codex, Cursor, OpenCode, Copilot or Antigravity — from any browser.',
  applicationName: 'Forge',
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#45bcd4',
  width: 'device-width',
  initialScale: 1,
  userScalable: false,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${sansFont.variable} ${monoFont.variable} ${osFont.variable} light bg-background`}
    >
      <body className="min-h-svh bg-background font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
