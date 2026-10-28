import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Money and date formatting must not depend on the host time zone (plan §15.1 R5).
process.env.TZ = 'America/New_York';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    env: { TZ: 'America/New_York' },
    restoreMocks: true,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          // The first ESLint/Vite/TypeScript load in the arch tests takes several seconds when the whole
          // suite runs in parallel on a loaded host (OneDrive repo); same budget as integration.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['tests/components/**/*.test.tsx'],
        },
      },
    ],
  },
});
