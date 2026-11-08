import { defineConfig } from 'vite';
import { generateComponents } from './scripts/generate-components.mjs';

const server = {
  host: '127.0.0.1',
  port: Number(process.env.PORT ?? 5233),
  strictPort: true,
  watch: { ignored: ['**/.cache/**'] },
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
};

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    {
      name: 'hakei-components',
      async buildStart() {
        await generateComponents();
      },
    },
  ],
  server,
  preview: server,
  build: {
    target: 'es2022',
    emptyOutDir: false,
    sourcemap: true,
  },
  worker: { format: 'es' },
});
