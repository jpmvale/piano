// Converte dist/index.html (documento completo) no formato de página do Artifact:
// <title>, estilos e scripts do <head> seguidos do conteúdo do <body>.
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = /<head>([\s\S]*?)<\/head>/i.exec(html)[1];
const body = /<body>([\s\S]*?)<\/body>/i.exec(html)[1];
const keep = head.match(/<title>[\s\S]*?<\/title>|<link[^>]*>|<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi) ?? [];
const title = keep.filter(t => /^<title/i.test(t));
const rest = keep.filter(t => !/^<title/i.test(t));
writeFileSync('dist/artifact.html', [...title, ...rest, body].join('\n'));
console.log('dist/artifact.html', (readFileSync('dist/artifact.html').length / 1024).toFixed(0) + ' KB');
