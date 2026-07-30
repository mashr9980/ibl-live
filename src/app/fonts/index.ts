import { Inter } from 'next/font/google';

/**
 * Self-hosted at build time by `next/font/google` — no runtime request to
 * Google, no layout shift. Swap the import for any other family if you'd
 * rather brand this differently; only the `--font-sans` variable is
 * consumed downstream (see globals.css).
 */
export const sans = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});
