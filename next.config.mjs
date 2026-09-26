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
/** Browsers keep assets for a day; the CDN keeps them for a week and serves
 *  stale for a month while it revalidates. */
const ASSET_CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000'

const nextConfig = {
  /**
   * `pnpm build` and `next dev` share this directory, which means a production
   * build left in `.next` silently poisons the dev server the end-to-end tests
   * spawn (it never serves a route, and the test times out with an empty log).
   * Those tests set FORGE_DIST_DIR so they get their own.
   */
  distDir: process.env.FORGE_DIST_DIR || '.next',
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
      // Sprites (pixel/build.mjs), CLI logos and the bundled share client are
      // NOT content-hashed, so they get a long edge cache with stale-while-
      // revalidate instead of `immutable`: a redeploy can take up to a day to
      // reach every edge, but it never needs a function invocation to serve
      // them. Everything under /_next/static is already immutable via Next.
      {
        source: '/sprites/:path*',
        headers: [{ key: 'Cache-Control', value: ASSET_CACHE }],
      },
      {
        source: '/logos/:path*',
        headers: [{ key: 'Cache-Control', value: ASSET_CACHE }],
      },
      {
        source: '/ar/:path*',
        headers: [{ key: 'Cache-Control', value: ASSET_CACHE }],
      },
    ]
  },
}

export default nextConfig
