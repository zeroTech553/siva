import type { Metadata, Viewport } from 'next'
import { Archivo, IBM_Plex_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-ibm',
})

export const metadata: Metadata = {
  title: 'Forge',
  description:
    'Visit the site, run one command on your laptop, control Claude Code from your phone. No signup.',
  generator: 'v0.app',
  applicationName: 'Forge',
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#16a6c8',
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
    <html lang="en" className={`${archivo.variable} ${ibmPlexMono.variable} light bg-background`}>
      <body className="min-h-svh bg-background font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
