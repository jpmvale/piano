import { defineConfig } from 'vite';

// Build da WEB: JS, CSS e amostras como arquivos separados, servidos pelo nginx.
//
// Era single-file até 23/10/2026, e o que o tirou de lá foi a CSP: com o bundle
// inteiro embutido no HTML, `script-src` só passaria com `'unsafe-inline'` —
// justamente o que desliga a proteção contra XSS. Hash no proxy não serve,
// porque muda a cada build e o seguinte deixaria a tela branca sem erro nenhum
// do lado do servidor.
//
// O single-file não acabou: virou `vite.artifact.config.ts`, porque o formato
// de Artifact precisa de um arquivo só. São dois alvos sobre o mesmo código.
//
// De quebra, conserta o cache. Embutido, o navegador rebaixava ~690 KB a cada
// mudança de HTML — e as 25 amostras do piano, que nunca mudam, iam junto toda
// vez. Separadas e com nome hasheado, ficam no cache e o deploy só traz o que
// mudou. (Os timbres extras em `public/timbres` já eram separados.)
export default defineConfig({
  // `npm run dev` com o serviço de importação rodando na porta 8000 (transcriber/README.md)
  server: { proxy: { '/api': 'http://localhost:8000' } },
});
