import type { Metadata, Viewport } from 'next';

import { agentIdentity } from '@/lib/ai-sales/brain/agent-identity';
import { sans } from './fonts';
import './globals.css';

export const viewport: Viewport = {
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

// Built from the configured identity so renaming the agent renames the tab
// title and share cards too. `generateMetadata` rather than a static export
// because the env vars are read at request time.
export function generateMetadata(): Metadata {
  const { name, product } = agentIdentity();
  const title = `Talk to ${name} — ${product}`;
  const description = `Ask ${product}'s live AI guide anything about the platform, the products, and how to get started.`;
  return { title, description, openGraph: { title, description } };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={sans.variable}>{children}</body>
    </html>
  );
}
