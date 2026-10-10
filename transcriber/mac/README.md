# Transcrever no Mac

A VPS tem 2 núcleos: uma música de 15 minutos leva cerca de meia hora para transcrever lá. Com o
Mac ligado, a fila vai para ele, que é bem mais rápido (usa a GPU do chip Apple quando dá) e
ainda baixa do YouTube pelo IP de casa, que o YouTube não bloqueia. Com o Mac desligado, a VPS
volta a transcrever sozinha.

```
jogo ──link/arquivo──▶ VPS (fila) ◀──"tem trabalho?" a cada 5 s── Mac
                                   ──música──────────────────────▶ transcreve
                                   ◀──MIDI pronto─────────────────
```

O Mac é quem chama a VPS, então não precisa abrir porta no roteador. Se ele dormir ou perder a
rede no meio de uma música, ela volta para a fila depois de 3 minutos sem notícia.

## Ligar (uma vez)

1. Gere um token na sua máquina: `openssl rand -hex 24`.
2. Coloque o token na VPS e recrie o container (o arquivo fica fora do repositório):
   ```bash
   ssh vps 'umask 077 && printf "MAC_TOKEN=%s\n" "SEU_TOKEN" > ~/apps/piano-api.env'
   ```
   e rode o workflow **deploy** (o `env_file` só é lido quando o container é criado).
3. No Mac, com `ffmpeg` (`brew install ffmpeg`) e Python 3.10+ instalados, na pasta do repositório
   atualizada (`git pull`):
   ```bash
   transcriber/mac/instalar.sh SEU_TOKEN --sempre
   ```
   O `--sempre` deixa o trabalhador ligado sozinho sempre que você entrar no Mac (launchd). Sem
   ele, rode `transcriber/mac/rodar.sh` quando quiser.
4. Confira em `https://piano.imp-software.cloud/api/health`: `"mac": true`.

Enquanto uma música é transcrita, o Mac não entra em repouso (`caffeinate`); fora disso, nada
muda no uso normal. Log em `~/.piano-mac/mac.log`.

## Modos (na VPS, `MODO_TRANSCRICAO` em `~/apps/piano-api.env`)

- `auto` (padrão): Mac quando ele está ligado, VPS quando não está.
- `mac`: só o Mac. Sem ele, as músicas esperam na fila.
- `vps`: só a VPS, como era antes.
