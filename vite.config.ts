import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Gera um único index.html com tudo embutido (JS, CSS e amostras de piano),
// que é o formato publicado como Artifact.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000 },
});
