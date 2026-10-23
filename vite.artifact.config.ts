import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Build do ARTIFACT: um index.html com tudo embutido (JS, CSS e as amostras do
// piano), que é o formato que a página de Artifact exige.
//
// Separado do `vite.config.ts` desde 23/10/2026. Os dois leem o mesmo código e
// só diferem no empacotamento: a web precisa de arquivo externo para a CSP
// poder recusar script embutido, e o Artifact precisa do oposto.
//
// Sai em `dist-artifact/` para não disputar a pasta com o build da web — com os
// dois em `dist/`, o último a rodar venceria, e qual foi parar na imagem
// dependeria da ordem do script.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { assetsInlineLimit: 100_000_000, outDir: 'dist-artifact' },
});
