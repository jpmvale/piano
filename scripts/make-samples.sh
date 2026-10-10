#!/usr/bin/env bash
# Gera amostras de piano leves (mono, 3 s, com fade) a partir do pacote
# tonejs-instrument-piano-mp3 (amostras CC-BY 3.0, de tonejs-instruments, por Nicholaus Brosowsky).
# Uma amostra a cada terça menor; o resto é afinado no navegador.
set -euo pipefail
SRC="${1:?uso: make-samples.sh <pasta com C4.mp3 etc.>}"
OUT="$(dirname "$0")/../src/samples"
mkdir -p "$OUT"
for o in 1 2 3 4 5 6; do
  for n in C Ds Fs A; do
    f="$SRC/$n$o.mp3"
    [ -f "$f" ] || continue
    ffmpeg -loglevel error -y -i "$f" -t 3 -af "afade=t=out:st=2.2:d=0.8" -ac 1 -ar 32000 -b:a 48k "$OUT/$n$o.mp3"
  done
done
ffmpeg -loglevel error -y -i "$SRC/C7.mp3" -t 3 -af "afade=t=out:st=2.2:d=0.8" -ac 1 -ar 32000 -b:a 48k "$OUT/C7.mp3"
du -ch "$OUT"/*.mp3 | tail -1
