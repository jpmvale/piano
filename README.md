# Piano Cascata

"Guitar Hero do piano" para iniciantes, inspirado no canal PHianonize: notas caindo sobre o teclado,
com controle total da linha do tempo, modo espera e entrada pelo teclado do computador, pela tela ou por teclado MIDI.
Músicas novas entram por arquivo `.mid` ou pelo link de um vídeo de piano do YouTube, transcrito no servidor.

## Publicação

O jogo fica em https://piano.imp-software.cloud, na mesma VPS do coda. Cada push na `main` passa pelo CI e, se estiver verde, o workflow `deploy` publica as imagens `ghcr.io/jpmvale/piano-web` (o jogo) e `ghcr.io/jpmvale/piano-api` (a importação pelo YouTube) e troca os containers na VPS. Detalhes e primeiro deploy em [docs/deploy-vps.md](docs/deploy-vps.md).

## Rodar

```bash
npm install
npm run dev      # servidor local com recarga
# com a importação: rode também o serviço de transcriber/README.md na porta 8000
npm run build    # gera dist/index.html (arquivo único) e dist/artifact.html (formato publicado)
```

## Estrutura

- `src/songs.ts`: músicas fixas (escritas como texto `NOTA:tempos`) e o formato interno `{midi, time, duration, hand}`, compatível com @tonejs/midi.
- `src/player.ts`: relógio único da música (play, pause, parar, compassos, velocidade, trecho A–B, modo espera, pontuação).
- `src/renderer.ts`: desenho em Canvas 2D (pista, notas, teclado, brilhos).
- `src/audio.ts`: piano com amostras reais embutidas (`src/samples`), com timbre sintetizado de reserva.
- `src/input.ts`: teclado do computador e Web MIDI.
- `src/midiImport.ts`: abrir arquivos `.mid` e separar as mãos quando o arquivo tem uma faixa só.
- `src/youtubeImport.ts`: janela "Importar do YouTube" (aviso de piano puro, fila, progresso).
- `transcriber/`: serviço da importação (yt-dlp + Transkun). Ver [transcriber/README.md](transcriber/README.md).
- `scripts/make-samples.sh`: regenera as amostras a partir do pacote `tonejs-instrument-piano-mp3`.

Amostras de piano: tonejs-instruments, de Nicholaus Brosowsky (CC BY 3.0).
