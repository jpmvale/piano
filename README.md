# Piano Cascata

"Guitar Hero do piano" para iniciantes, inspirado no canal PHianonize: notas caindo sobre o teclado,
com controle total da linha do tempo, modo espera e entrada pelo teclado do computador, pela tela ou por teclado MIDI.
Músicas novas entram pelo botão + do canto: arquivo `.mid` ou áudio MP3 de piano solo, transcrito no servidor (ou no Mac, ver transcriber/mac).
O jogo pede login (cadastro com código de convite); as músicas ficam no servidor com dono, e a tela "Músicas" mostra a dificuldade de cada uma de 0 a 10.

## Publicação

O jogo fica em https://piano.imp-software.cloud, na mesma VPS do coda. Cada push na `main` passa pelo CI e, se estiver verde, o workflow `deploy` publica as imagens `ghcr.io/jpmvale/piano-web` (o jogo) e `ghcr.io/jpmvale/piano-api` (a transcrição de áudio) e troca os containers na VPS. Detalhes e primeiro deploy em [docs/deploy-vps.md](docs/deploy-vps.md).

## Rodar

```bash
npm install
npm run dev      # servidor local com recarga
# o jogo pede login: rode também o serviço de transcriber/README.md na porta 8000,
# com CODIGO_CONVITE=... para poder criar a primeira conta
npm run build    # gera dist/index.html (arquivo único) e dist/artifact.html (formato publicado)
```

## Estrutura

- `src/songs.ts`: músicas fixas (escritas como texto `NOTA:tempos`) e o formato interno `{midi, time, duration, hand}`, compatível com @tonejs/midi.
- `src/player.ts`: relógio único da música (play, pause, parar, compassos, velocidade, trecho A–B, modo espera, pontuação).
- `src/renderer.ts`: desenho em Canvas 2D (pista, notas, teclado, brilhos).
- `src/audio.ts`: piano com amostras reais embutidas (`src/samples`), os outros timbres sob demanda e um som sintetizado de reserva.
- `src/input.ts`: teclado do computador e Web MIDI.
- `src/midiImport.ts`: abrir arquivos `.mid` e separar as mãos quando o arquivo tem uma faixa só.
- `src/audioImport.ts`: janela "Importar áudio" (aviso de piano solo e músicas simples, fila, progresso).
- `src/auth.ts`, `src/api.ts`: tela de entrada (entrar / criar conta com convite) e as chamadas ao servidor.
- `src/library.ts`: tela de escolha de músicas (dificuldade 0 a 10, busca, renomear e apagar conforme a permissão).
- `transcriber/`: o servidor: contas, músicas e a importação (yt-dlp + Transkun). Ver [transcriber/README.md](transcriber/README.md).
- `scripts/make-samples.sh`: regenera as amostras a partir do pacote `tonejs-instrument-piano-mp3`.
- `scripts/make-timbres.sh`: gera os outros timbres (violão, órgão, violino…) em `public/timbres/`, baixados só quando escolhidos no seletor "Timbre".

Amostras de piano: tonejs-instruments, de Nicholaus Brosowsky (CC BY 3.0).
