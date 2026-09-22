/** @type {import('next').NextConfig} */

/**
 * Public, copy-pasteable URLs live here as rewrites so the `app/` tree can stay
 * organised by concern instead of by filename. Adding a new short URL = one line.
 *
 *   /install          bash stub        → /api/install/sh
 *   /install.py       real installer   → /api/install/py
 *   /install.cmd      Windows wrapper  → /api/install/cmd
 *   /bridge.py        laptop bridge    → /api/bridge
 *   /share            upstream web client (read-only share view)
 */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/share', destination: '/ar/share.html' },
        { source: '/install', destination: '/api/install/sh' },
        { source: '/install.py', destination: '/api/install/py' },
        { source: '/install.cmd', destination: '/api/install/cmd' },
        { source: '/bridge.py', destination: '/api/bridge/forge_bridge.py' },
      ],
    }
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
      // Self-hosted fonts are immutable, content-hashed by the build.
      {
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },
}

export default nextConfig
