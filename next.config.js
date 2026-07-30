/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin file tracing to this directory. Without it, Next walks up looking for a
  // lockfile and can pick one from a parent directory (a home-directory
  // pnpm-lock.yaml, another checkout), which both prints a warning and roots
  // the trace in the wrong place.
  outputFileTracingRoot: import.meta.dirname,
  // The brain's persona loader reads the prompt-parts/*.md files via fs at
  // runtime; fs reads aren't auto-traced, so bundle them explicitly.
  outputFileTracingIncludes: {
    // Both routes call loadPersona() (reads prompt-parts/*.md via fs). Each App
    // Router route is its own serverless function on Vercel and fs reads aren't
    // auto-traced, so bundle the files into BOTH or the untraced one
    // 500s/ENOENTs. Glob (not a fixed list) so adding a part needs no config
    // change. An operator overriding PROMPT_PARTS_DIR is responsible for
    // getting their own parts into the deployment.
    '/api/chat/completions': ['./src/lib/ai-sales/brain/prompt-parts/**/*.md'],
    '/api/ai-sales/session-end': ['./src/lib/ai-sales/brain/prompt-parts/**/*.md'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // This app is meant to be visited directly, not embedded. Denying all
          // framing is both the correct posture and clickjacking protection —
          // note that omitting the header entirely would leave the app
          // frameable by anyone, since Next sets no X-Frame-Options by default.
          // If you do want to embed it, replace 'none' with the parent origins.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          // Required for the avatar session: the page needs mic capture and
          // autoplay of the avatar's video/audio track.
          {
            key: 'Permissions-Policy',
            value: 'microphone=(self), camera=(self), autoplay=(self)',
          },
        ],
      },
    ];
  },
};
export default nextConfig;
