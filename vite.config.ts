import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Gera um único index.html com tudo embutido (JS, CSS e amostras de piano),
// que é o formato publicado como Artifact.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000 },
  // `npm run dev` com o serviço de importação rodando na porta 8000 (transcriber/README.md)
  server: { proxy: { '/api': 'http://localhost:8000' } },
});
