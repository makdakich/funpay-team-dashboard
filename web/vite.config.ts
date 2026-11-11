import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
  const projectPages = repository && !repository.endsWith('.github.io');
  const base = env.VITE_BASE_PATH || (process.env.GITHUB_ACTIONS && projectPages ? `/${repository}/` : '/');

  return {
    base,
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts']
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true
    },
    resolve: {
      alias: {
        '@': resolve(process.cwd(), 'src')
      }
    }
  };
});
