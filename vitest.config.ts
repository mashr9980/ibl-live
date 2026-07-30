import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { configDefaults, defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    exclude: [...configDefaults.exclude],
  },
  resolve: {
    alias: {
      // `server-only` is Next.js's poison-pill module that throws if imported
      // outside a server context. For vitest, stub it to a no-op since tests
      // intentionally exercise server-only code paths (e.g. session-end).
      'server-only': path.resolve(__dirname, './src/lib/__test-stubs__/server-only.ts'),
    },
  },
});
