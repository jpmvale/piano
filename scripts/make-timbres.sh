#!/usr/bin/env bash
# Gera os timbres extras (além do piano, que vai embutido na página) a partir dos
# pacotes npm tonejs-instrument-<nome>-mp3 (amostras CC BY 3.0, de tonejs-instruments,
# por Nicholaus Brosowsky). Ficam em public/timbres/<id>/ e só são baixados quando a
# pessoa escolhe o timbre.
#
# Uso: scripts/make-timbres.sh <pasta com os pacotes extraídos, um subdiretório por nome>
#   ex.: for p in guitar-nylon organ; do npm pack tonejs-instrument-$p-mp3; mkdir $p; tar xzf tonejs-instrument-$p-mp3-*.tgz -C $p; done
#
# Cada amostra sai mono, curta, com fade, e com o volume igualado (loudnorm) para a
# troca de timbre não mudar o volume. Instrumentos de som contínuo (órgão, cordas,
# sopro) ficam um pouco mais longos e um pouco mais baixos, porque soam mais fortes.
set -euo pipefail
SRC="${1:?uso: make-timbres.sh <pasta com os pacotes>}"
OUT="$(dirname "$0")/../public/timbres"

# id   pacote           segundos  LUFS
TIMBRES="
violao      guitar-nylon     3  -21
guitarra    guitar-electric  3  -22
harpa       harp             3  -21
xilofone    xylophone        3  -21
orgao       organ            4  -25
violino     violin           4  -25
violoncelo  cello            4  -25
flauta      flute            4  -25
"

echo "$TIMBRES" | while read -r id pacote seg lufs; do
  [ -n "$id" ] || continue
  dir="$SRC/$pacote/package"
  [ -d "$dir" ] || { echo "faltou $dir" >&2; exit 1; }
  rm -rf "${OUT:?}/$id" && mkdir -p "$OUT/$id"
  notas=()
  for f in "$dir"/*.mp3; do
    nome=$(basename "$f" .mp3)
    [[ "$nome" =~ ^[A-G]s?[0-9]$ ]] || continue   # pula variações como "F2 v2"
    fade=$(echo "$seg - 0.8" | bc)
    ffmpeg -nostdin -loglevel error -y -i "$f" -t "$seg" \
      -af "loudnorm=I=$lufs:TP=-2:LRA=11,afade=t=out:st=$fade:d=0.8" \
      -ac 1 -ar 32000 -b:a 48k "$OUT/$id/$nome.mp3"
    notas+=("\"$nome\"")
  done
  (IFS=,; echo "[${notas[*]}]") > "$OUT/$id/notas.json"
  echo "$id: ${#notas[@]} notas, $(du -sh "$OUT/$id" | cut -f1)"
done
