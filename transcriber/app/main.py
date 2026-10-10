"""API de importação: link do YouTube ou arquivo de áudio → MIDI que o jogo já sabe abrir.

Uma música por vez, numa fila: a transcrição ocupa os dois núcleos da VPS por
alguns minutos e duas em paralelo só deixariam as duas mais lentas, além de
disputar memória com os outros apps da máquina.

Os MIDI prontos ficam em disco (DADOS/midi), indexados pelo id do vídeo:
importar de novo o mesmo vídeo devolve o resultado na hora. Arquivos enviados
usam como id o começo do sha256 do conteúdo, com o mesmo formato de um id do
YouTube, para dividir a mesma fila, o mesmo cache e as mesmas rotas.
"""
import contextlib
import hashlib
import json
import logging
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from yt_dlp.utils import DownloadError

from . import youtube

DADOS = os.environ.get('DADOS', '/data')
PASTA_MIDI = os.path.join(DADOS, 'midi')
PASTA_ENVIOS = os.path.join(DADOS, 'envios')
MAX_MB_ENVIO = int(os.environ.get('MAX_MB_ENVIO', '40'))
MAX_MINUTOS = float(os.environ.get('MAX_MINUTOS', '8'))
MAX_FILA = int(os.environ.get('MAX_FILA', '5'))
# Medido: o Transkun leva perto de 2x a duração da música em 2 núcleos.
FATOR_TEMPO = float(os.environ.get('FATOR_TEMPO', '2.2'))

log = logging.getLogger('piano-api')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
os.makedirs(PASTA_MIDI, exist_ok=True)
os.makedirs(PASTA_ENVIOS, exist_ok=True)

app = FastAPI(title='Piano Cascata: importação', docs_url=None, redoc_url=None)


class Pedido(BaseModel):
    link: str


class Trabalho:
    def __init__(self, video_id: str, arquivo: str = ''):
        self.id = video_id
        self.arquivo = arquivo    # áudio enviado pela pessoa; vazio = baixar do YouTube
        self.estado = 'na_fila'   # na_fila | baixando | transcrevendo | pronto | erro
        self.titulo = ''
        self.duracao = 0.0
        self.inicio_transcricao = 0.0
        self.erro = ''
        self.atualizado = time.time()

    def json(self) -> dict:
        d = {'id': self.id, 'estado': self.estado, 'titulo': self.titulo, 'duracao': self.duracao}
        if self.estado == 'na_fila':
            d['posicao'] = _posicao(self.id)
        if self.estado == 'transcrevendo':
            d['decorrido'] = round(time.time() - self.inicio_transcricao)
            d['estimativa'] = round(self.duracao * FATOR_TEMPO)
        if self.estado == 'erro':
            d['erro'] = self.erro
        return d


trabalhos: dict[str, Trabalho] = {}
fila: 'queue.Queue[str]' = queue.Queue()
trava = threading.Lock()


def _posicao(video_id: str) -> int:
    with fila.mutex:
        itens = list(fila.queue)
    return itens.index(video_id) + 1 if video_id in itens else 0


def _arquivos(video_id: str) -> tuple[str, str]:
    return os.path.join(PASTA_MIDI, f'{video_id}.mid'), os.path.join(PASTA_MIDI, f'{video_id}.json')


def _pronto_em_disco(video_id: str) -> Trabalho | None:
    midi, meta = _arquivos(video_id)
    if not (os.path.exists(midi) and os.path.exists(meta)):
        return None
    t = Trabalho(video_id)
    with open(meta, encoding='utf-8') as f:
        info = json.load(f)
    t.titulo, t.duracao, t.estado = info.get('titulo', ''), info.get('duracao', 0), 'pronto'
    return t


class ErroParaPessoa(Exception):
    """Erro com mensagem pronta para mostrar na tela."""


def _duracao(arquivo: str) -> float:
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', arquivo],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        raise ErroParaPessoa('Esse arquivo não parece ser de áudio.') from None


def _limite(duracao: float, o_que: str) -> None:
    if duracao > MAX_MINUTOS * 60:
        raise ErroParaPessoa(f'{o_que} tem {duracao / 60:.0f} minutos. O limite é {MAX_MINUTOS:.0f} minutos por música.')


def _processar(t: Trabalho) -> None:
    with tempfile.TemporaryDirectory(dir=DADOS) as tmp:
        if t.arquivo:
            audio = t.arquivo
            t.duracao = _duracao(audio)
            _limite(t.duracao, 'O áudio')
        else:
            t.estado = 'baixando'
            try:
                info = youtube.informacoes(t.id)
            except DownloadError as e:
                raise ErroParaPessoa(_explicar_download(e)) from e
            t.titulo, t.duracao = info['titulo'], info['duracao']
            if info['ao_vivo']:
                raise ErroParaPessoa('Transmissões ao vivo não podem ser importadas.')
            _limite(t.duracao, 'O vídeo')
            try:
                audio = youtube.baixar_audio(t.id, tmp)
            except DownloadError as e:
                raise ErroParaPessoa(_explicar_download(e)) from e

        t.estado, t.inicio_transcricao = 'transcrevendo', time.time()
        saida = os.path.join(tmp, 'saida.mid')
        limite = max(600, t.duracao * FATOR_TEMPO * 3)
        try:
            r = subprocess.run([sys.executable, '-m', 'app.transcrever', audio, saida],
                               capture_output=True, text=True, timeout=limite,
                               cwd=os.path.dirname(os.path.dirname(__file__)))
        except subprocess.TimeoutExpired as e:
            raise ErroParaPessoa('A transcrição demorou demais e foi interrompida.') from e
        if r.returncode != 0:
            log.error('transcrição de %s falhou: %s', t.id, r.stderr[-2000:])
            raise ErroParaPessoa('Não consegui transcrever esse áudio.')
        notas = int((r.stdout.split() or ['0'])[0])
        if notas == 0:
            raise ErroParaPessoa('Não encontrei notas de piano nesse vídeo.')

        midi, meta = _arquivos(t.id)
        os.replace(saida, midi)
        with open(meta, 'w', encoding='utf-8') as f:
            json.dump({'titulo': t.titulo, 'duracao': t.duracao, 'notas': notas}, f, ensure_ascii=False)
    log.info('%s pronto: %d notas em %.0fs', t.id, notas, time.time() - t.inicio_transcricao)


def _explicar_download(e: DownloadError) -> str:
    msg = str(e)
    log.warning('yt-dlp: %s', msg)
    if 'Sign in' in msg or 'bot' in msg:
        return ('O YouTube bloqueou o download a partir do servidor. '
                'Enquanto isso, você pode enviar o arquivo de áudio da música.')
    if 'Private video' in msg or 'unavailable' in msg.lower():
        return 'Esse vídeo é privado ou não está disponível.'
    return 'Não consegui baixar o áudio desse vídeo.'


def _trabalhador() -> None:
    while True:
        video_id = fila.get()
        t = trabalhos[video_id]
        try:
            _processar(t)
            t.estado = 'pronto'
        except ErroParaPessoa as e:
            t.estado, t.erro = 'erro', str(e)
        except Exception:  # noqa: BLE001 — qualquer falha vira mensagem, e a fila segue
            log.exception('falha inesperada em %s', video_id)
            t.estado, t.erro = 'erro', 'Algo deu errado na importação. Tente de novo.'
        finally:
            if t.arquivo:
                with contextlib.suppress(OSError):
                    os.unlink(t.arquivo)
            t.atualizado = time.time()
            fila.task_done()


threading.Thread(target=_trabalhador, daemon=True).start()


@app.get('/api/health')
def saude() -> dict:
    return {'ok': True, 'fila': fila.qsize(), 'cookies': youtube.tem_cookies()}


@app.post('/api/importar')
def importar(p: Pedido) -> dict:
    video_id = youtube.id_do_video(p.link)
    if not video_id:
        raise HTTPException(400, 'Esse não parece um link de vídeo do YouTube.')
    with trava:
        t = trabalhos.get(video_id)
        if t and t.estado != 'erro':
            return t.json()
        pronto = _pronto_em_disco(video_id)
        if pronto:
            trabalhos[video_id] = pronto
            return pronto.json()
        if fila.qsize() >= MAX_FILA:
            raise HTTPException(429, 'Muitas músicas na fila agora. Tente de novo em alguns minutos.')
        t = Trabalho(video_id)
        trabalhos[video_id] = t
        fila.put(video_id)
        return t.json()


@app.post('/api/enviar')
def enviar(arquivo: UploadFile = File(...)) -> dict:
    """Recebe um arquivo de áudio (mp3, m4a, wav…) e põe na mesma fila do YouTube."""
    limite = MAX_MB_ENVIO * 1024 * 1024
    fd, caminho = tempfile.mkstemp(dir=PASTA_ENVIOS)
    soma, tamanho = hashlib.sha256(), 0
    try:
        with os.fdopen(fd, 'wb') as f:
            while bloco := arquivo.file.read(1 << 20):
                tamanho += len(bloco)
                if tamanho > limite:
                    raise HTTPException(413, f'O arquivo passa de {MAX_MB_ENVIO} MB.')
                soma.update(bloco)
                f.write(bloco)
        if tamanho == 0:
            raise HTTPException(400, 'O arquivo está vazio.')
    except BaseException:
        os.unlink(caminho)
        raise

    trabalho_id = soma.hexdigest()[:11]
    titulo = os.path.splitext(os.path.basename(arquivo.filename or ''))[0].strip()[:120] or 'Áudio enviado'
    with trava:
        t = trabalhos.get(trabalho_id)
        pronto = None if t and t.estado != 'erro' else _pronto_em_disco(trabalho_id)
        if (t and t.estado != 'erro') or pronto:
            os.unlink(caminho)
            if pronto:
                trabalhos[trabalho_id] = pronto
            return (pronto or t).json()
        if fila.qsize() >= MAX_FILA:
            os.unlink(caminho)
            raise HTTPException(429, 'Muitas músicas na fila agora. Tente de novo em alguns minutos.')
        t = Trabalho(trabalho_id, arquivo=caminho)
        t.titulo = titulo
        trabalhos[trabalho_id] = t
        fila.put(trabalho_id)
        return t.json()


@app.get('/api/importar/{video_id}')
def situacao(video_id: str) -> dict:
    if not youtube.id_valido(video_id):
        raise HTTPException(404, 'Importação não encontrada.')
    t = trabalhos.get(video_id) or _pronto_em_disco(video_id)
    if not t:
        raise HTTPException(404, 'Importação não encontrada.')
    return t.json()


@app.get('/api/importar/{video_id}/midi')
def baixar_midi(video_id: str) -> FileResponse:
    if not youtube.id_valido(video_id):
        raise HTTPException(404)
    midi, _ = _arquivos(video_id)
    if not os.path.exists(midi):
        raise HTTPException(404, 'Essa música ainda não está pronta.')
    return FileResponse(midi, media_type='audio/midi', filename=f'{video_id}.mid')
