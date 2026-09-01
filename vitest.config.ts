import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@context-tree/core': r('./packages/core/src/index.ts'),
      '@context-tree/mcp': r('./packages/mcp/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/*/test/**/*.test.ts', 'eval/test/**/*.test.ts', 'eval-resumption/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20_000,
    // Native better-sqlite3 + tree-sitter are happiest in forks, not threads.
    pool: 'forks',
  },
});
