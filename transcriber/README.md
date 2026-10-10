# Importação pelo YouTube

Serviço pequeno que transcreve um vídeo do YouTube ou um arquivo de áudio para MIDI. Fica ao lado do jogo na VPS (container `piano-api`). O nginx do jogo
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
- Limite de 15 minutos por música e 5 vídeos na fila (`MAX_MINUTOS`, `MAX_FILA`).

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

## Envio de arquivo de áudio

`POST /api/enviar` (campo `arquivo`, multipart, até `MAX_MB_ENVIO` = 60 MB) põe um áudio na mesma
fila. O id é o começo do sha256 do arquivo, então reenviar o mesmo áudio devolve o MIDI já pronto.
É a saída para quando o YouTube barra o servidor, e para gravações que não estão no YouTube.

## Quando o YouTube bloqueia o servidor (cookies)

O YouTube pede login ("confirme que você não é um robô") para downloads vindos de IPs de
datacenter, como o da VPS. A resposta é dar ao yt-dlp os cookies de uma conta do YouTube:

1. Use uma conta **secundária**: o YouTube pode suspender contas que baixam muito.
2. Numa janela anônima do navegador, entre nessa conta, abra o YouTube e exporte os cookies no
   formato Netscape (extensão "Get cookies.txt LOCALLY" ou similar). Feche a janela anônima sem
   sair da conta, para os cookies continuarem válidos.
3. Na sua máquina:
   ```bash
   ssh vps 'mkdir -p ~/apps/piano-cookies'
   scp youtube.txt vps:~/apps/piano-cookies/youtube.txt
   ssh vps 'chmod 644 ~/apps/piano-cookies/youtube.txt && docker restart piano-api'
   ```
   (644 porque o processo do container roda com outro usuário; a pasta fica fora do repositório.)
4. `https://piano.imp-software.cloud/api/health` passa a mostrar `"cookies": true`.

Crie a pasta (`mkdir -p ~/apps/piano-cookies`, como o usuário `deploy`) antes do primeiro deploy
com o volume: se ela não existir, o Docker a cria como root e o `scp` deixa de conseguir gravar nela.

O container lê `~/apps/piano-cookies/youtube.txt` só para leitura (`YTDLP_COOKIES` no
`docker-compose.prod.yml`) e o yt-dlp trabalha numa cópia. Quando os cookies expirarem, o erro
de bloqueio volta: exporte de novo e repita o passo 3. Atualizar o yt-dlp também ajuda: um deploy
novo recompila a imagem com a versão mais recente.

Baixar áudio do YouTube vai contra os termos de uso do YouTube; use com vídeos que você tem direito
de usar.
