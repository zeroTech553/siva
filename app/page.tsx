import { LandingPage } from '@/components/landing/landing-page'

/**
 * The landing page. It is a client component (the machine on it boots, its
 * windows drag, its terminal types) rendered from a server component so the
 * first paint and the metadata stay on the server.
 *
 * /console is the same OS with a paired laptop; see app/console/page.tsx.
 */
export default function Page() {
  return <LandingPage />
}
