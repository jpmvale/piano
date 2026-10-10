# Importação pelo YouTube

Serviço pequeno que fica ao lado do jogo na VPS (container `piano-api`). O nginx do jogo
encaminha `/api/` para cá.

1. `POST /api/importar {"link": "..."}` aceita o link e põe o vídeo na fila.
2. Um único trabalhador baixa só o áudio com o **yt-dlp** e transcreve com o
   **[Transkun](https://github.com/Yujia-Yan/Transkun)** (modelo de transcrição de piano, roda na CPU).
3. `GET /api/importar/<id>` diz em que pé está (`na_fila`, `baixando`, `transcrevendo`, `pronto`, `erro`).
4. `GET /api/importar/<id>/midi` entrega o MIDI, que o jogo abre com o mesmo importador de arquivos `.mid`.

Os MIDI prontos ficam no volume `/data/midi`, então importar o mesmo vídeo de novo é instantâneo.

## Números (medidos com 2 núcleos)

- Cerca de **2x a duração da música**: 40 s de áudio levam ~95 s. Uma música de 3 minutos, ~6 minutos.
- Pico de **~2 GB de memória** durante a transcrição, devolvida ao fim (cada música roda num processo separado).
- Limite de 8 minutos por vídeo e 5 vídeos na fila (`MAX_MINUTOS`, `MAX_FILA`).

## Rodar na sua máquina

```bash
cd transcriber
python3 -m venv .venv && . .venv/bin/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
DADOS=./dados uvicorn app.main:app --port 8000
# em outro terminal, na raiz do repositório: npm run dev (o Vite encaminha /api para a porta 8000)
```

Testes: `python -m unittest` (links aceitos e recusados). Transcrição de um trecho:
`python -m app.transcrever tests/trecho.mp3 /tmp/trecho.mid`.

## Se o YouTube bloquear o servidor

O YouTube às vezes pede login para downloads feitos de IPs de datacenter. Se isso acontecer, exporte
os cookies do YouTube do navegador (formato Netscape), coloque o arquivo na VPS e aponte
`YTDLP_COOKIES` para ele no `docker-compose.prod.yml`. Também vale atualizar o yt-dlp: um deploy
novo recompila a imagem com a versão mais recente.

Baixar áudio do YouTube vai contra os termos de uso do YouTube; use com vídeos que você tem direito
de usar.
