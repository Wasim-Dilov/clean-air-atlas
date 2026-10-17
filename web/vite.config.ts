import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so the site works under https://<user>.github.io/<repo>/
  base: './',
  server: {
    // data/static/ lives one level up and is imported at build time
    fs: { allow: ['..'] },
  },
  // Serve MapLibre unbundled in dev so it can resolve its worker module next to itself.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
