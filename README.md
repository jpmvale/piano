# Piano Cascata

"Guitar Hero do piano" para iniciantes, inspirado no canal PHianonize: notas caindo sobre o teclado,
com controle total da linha do tempo, modo espera e entrada pelo teclado do computador, pela tela ou por teclado MIDI.

## Publicação

Cada push na `main` passa pelo CI e, se estiver verde, o workflow `deploy` publica a imagem `ghcr.io/jpmvale/piano` e pede para a VPS (a mesma do coda) trocar o container. O Caddy do coda serve o jogo com HTTPS. Detalhes da parte da VPS em [docs/deploy-vps.md](docs/deploy-vps.md).

## Rodar

```bash
npm install
npm run dev      # servidor local com recarga
npm run build    # gera dist/index.html (arquivo único) e dist/artifact.html (formato publicado)
```

## Estrutura

- `src/songs.ts`: músicas fixas (escritas como texto `NOTA:tempos`) e o formato interno `{midi, time, duration, hand}`, compatível com @tonejs/midi.
- `src/player.ts`: relógio único da música (play, pause, parar, compassos, velocidade, trecho A–B, modo espera, pontuação).
- `src/renderer.ts`: desenho em Canvas 2D (pista, notas, teclado, brilhos).
- `src/audio.ts`: piano com amostras reais embutidas (`src/samples`), com timbre sintetizado de reserva.
- `src/input.ts`: teclado do computador e Web MIDI.
- `src/midiImport.ts`: abrir arquivos `.mid`.
- `scripts/make-samples.sh`: regenera as amostras a partir do pacote `tonejs-instrument-piano-mp3`.

Amostras de piano: tonejs-instruments, de Nicholaus Brosowsky (CC BY 3.0).
