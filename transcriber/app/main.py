"""API de importação: link do YouTube ou arquivo de áudio → MIDI que o jogo já sabe abrir.

Uma música por vez, numa fila. Quem transcreve depende de MODO_TRANSCRICAO:

- `auto` (padrão): se o Mac do dono está ligado e pedindo trabalho (app/mac.py),
  a fila fica para ele, que é bem mais rápido e baixa do YouTube com IP de casa.
  Sem contato do Mac há MAC_ATIVO_S segundos, a própria VPS transcreve.
- `mac`: só o Mac transcreve; sem ele, a música espera na fila.
- `vps`: só a VPS transcreve, como antes.

Na VPS a transcrição ocupa os dois núcleos por minutos; duas em paralelo só
deixariam as duas mais lentas, além de disputar memória com os outros apps.

Os MIDI prontos ficam em disco (DADOS/midi), indexados pelo id do vídeo:
importar de novo o mesmo vídeo devolve o resultado na hora. Arquivos enviados
usam como id o começo do sha256 do conteúdo, com o mesmo formato de um id do
YouTube, para dividir a mesma fila, o mesmo cache e as mesmas rotas.
"""
import collections
import contextlib
import hashlib
import hmac
import json
import logging
import os
import tempfile
import threading
import time

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from yt_dlp.utils import DownloadError

from . import contas, musicas, youtube
from .comum import ErroParaPessoa, conferir_limite, duracao, explicar_download, iniciar_transcricao, \
    resultado_transcricao
from .contas import Usuario, exigir_usuario

DADOS = os.environ.get('DADOS', '/data')
PASTA_MIDI = os.path.join(DADOS, 'midi')
PASTA_ENVIOS = os.path.join(DADOS, 'envios')
MAX_MB_ENVIO = int(os.environ.get('MAX_MB_ENVIO', '60'))
MAX_MINUTOS = float(os.environ.get('MAX_MINUTOS', '15'))
MAX_FILA = int(os.environ.get('MAX_FILA', '5'))
# Medido: o Transkun leva perto de 2x a duração da música em 2 núcleos.
FATOR_TEMPO = float(os.environ.get('FATOR_TEMPO', '2.2'))

MODO = os.environ.get('MODO_TRANSCRICAO', 'auto')
TOKEN_MAC = os.environ.get('MAC_TOKEN', '')
# O Mac pede trabalho a cada poucos segundos; sem pedido nesse intervalo, ele está desligado.
MAC_ATIVO_S = float(os.environ.get('MAC_ATIVO_S', '45'))
# Música entregue ao Mac sem notícia dele nesse intervalo volta para a fila.
MAC_PRAZO_S = float(os.environ.get('MAC_PRAZO_S', '180'))

log = logging.getLogger('piano-api')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
os.makedirs(PASTA_MIDI, exist_ok=True)
os.makedirs(PASTA_ENVIOS, exist_ok=True)

contas.iniciar()
musicas.iniciar()

app = FastAPI(title='Piano Cascata: importação', docs_url=None, redoc_url=None)
app.include_router(contas.router)
app.include_router(musicas.router)


class Pedido(BaseModel):
    link: str


class Trabalho:
    def __init__(self, video_id: str, arquivo: str = ''):
        self.id = video_id
        self.arquivo = arquivo    # áudio enviado pela pessoa; vazio = baixar do YouTube
        self.estado = 'na_fila'   # na_fila | baixando | transcrevendo | pronto | erro
        self.onde = ''            # '' (na fila) | vps | mac
        self.titulo = ''
        self.duracao = 0.0
        self.inicio_transcricao = 0.0
        self.estimativa = 0.0
        self.erro = ''
        self.atualizado = time.time()
        self.donos: set[int] = set()  # quem pediu: cada um ganha a música quando ficar pronta

    def json(self) -> dict:
        d = {'id': self.id, 'estado': self.estado, 'titulo': self.titulo, 'duracao': self.duracao}
        if self.onde:
            d['onde'] = self.onde
        if self.estado == 'na_fila':
            d['posicao'] = _posicao(self.id)
        if self.estado == 'transcrevendo':
            d['decorrido'] = round(time.time() - self.inicio_transcricao)
            d['estimativa'] = round(self.estimativa or self.duracao * FATOR_TEMPO)
        if self.estado == 'erro':
            d['erro'] = self.erro
        return d


trabalhos: dict[str, Trabalho] = {}
pendentes: collections.deque[str] = collections.deque()
trava = threading.Lock()
mudou = threading.Condition(trava)
ultimo_contato_mac = 0.0


def _posicao(video_id: str) -> int:
    itens = list(pendentes)
    return itens.index(video_id) + 1 if video_id in itens else 0


def _mac_ligado() -> bool:
    return time.time() - ultimo_contato_mac < MAC_ATIVO_S


def _vps_pode() -> bool:
    return MODO == 'vps' or (MODO == 'auto' and not _mac_ligado())


def _devolver_esquecidos() -> None:
    """Músicas que o Mac pegou e largou (desligou, perdeu a rede) voltam para o começo da fila."""
    for t in trabalhos.values():
        if t.onde == 'mac' and t.estado in ('na_fila', 'baixando', 'transcrevendo') \
                and time.time() - t.atualizado > MAC_PRAZO_S:
            log.warning('%s: sem notícia do Mac há %.0fs, volta para a fila', t.id, MAC_PRAZO_S)
            t.onde, t.estado, t.atualizado = '', 'na_fila', time.time()
            pendentes.appendleft(t.id)
            mudou.notify_all()


def _enfileirar(t: Trabalho) -> None:
    trabalhos[t.id] = t
    pendentes.append(t.id)
    mudou.notify_all()


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


def _guardar(t: Trabalho, midi_tmp: str, notas: int) -> None:
    midi, meta = _arquivos(t.id)
    os.replace(midi_tmp, midi)
    with open(meta, 'w', encoding='utf-8') as f:
        json.dump({'titulo': t.titulo, 'duracao': t.duracao, 'notas': notas}, f, ensure_ascii=False)


def _encerrar(t: Trabalho, estado: str, erro: str = '') -> None:
    t.estado, t.erro, t.atualizado = estado, erro, time.time()
    if estado == 'pronto':
        musicas.guardar_transcricao(t.donos, t.id)
    if t.arquivo:
        with contextlib.suppress(OSError):
            os.unlink(t.arquivo)


# ---------------------------------------------------------------------------
# Transcrição na própria VPS
# ---------------------------------------------------------------------------
def _processar(t: Trabalho) -> None:
    with tempfile.TemporaryDirectory(dir=DADOS) as tmp:
        if t.arquivo:
            audio = t.arquivo
            t.duracao = duracao(audio)
            conferir_limite(t.duracao, MAX_MINUTOS, 'O áudio')
        else:
            t.estado = 'baixando'
            try:
                info = youtube.informacoes(t.id)
            except DownloadError as e:
                raise ErroParaPessoa(explicar_download(e)) from e
            t.titulo, t.duracao = info['titulo'], info['duracao']
            if info['ao_vivo']:
                raise ErroParaPessoa('Transmissões ao vivo não podem ser importadas.')
            conferir_limite(t.duracao, MAX_MINUTOS, 'O vídeo')
            try:
                audio = youtube.baixar_audio(t.id, tmp)
            except DownloadError as e:
                raise ErroParaPessoa(explicar_download(e)) from e

        t.estado, t.inicio_transcricao = 'transcrevendo', time.time()
        saida = os.path.join(tmp, 'saida.mid')
        proc = iniciar_transcricao(audio, saida)
        notas = resultado_transcricao(proc, max(600, t.duracao * FATOR_TEMPO * 3), t.id)
        _guardar(t, saida, notas)
    log.info('%s pronto na VPS: %d notas em %.0fs', t.id, notas, time.time() - t.inicio_transcricao)


def _trabalhador() -> None:
    while True:
        with mudou:
            while True:
                _devolver_esquecidos()
                if pendentes and _vps_pode():
                    t = trabalhos[pendentes.popleft()]
                    t.onde = 'vps'
                    break
                mudou.wait(timeout=5)
        try:
            _processar(t)
            with trava:  # quem pede a mesma música agora entra em t.donos sob esta trava
                _encerrar(t, 'pronto')
        except ErroParaPessoa as e:
            _encerrar(t, 'erro', str(e))
        except Exception:  # noqa: BLE001 — qualquer falha vira mensagem, e a fila segue
            log.exception('falha inesperada em %s', t.id)
            _encerrar(t, 'erro', 'Algo deu errado na importação. Tente de novo.')


threading.Thread(target=_trabalhador, daemon=True).start()


# ---------------------------------------------------------------------------
# Rotas do jogo
# ---------------------------------------------------------------------------
@app.get('/api/health')
def saude() -> dict:
    return {'ok': True, 'fila': len(pendentes), 'cookies': youtube.tem_cookies(), 'modo': MODO,
            'mac': _mac_ligado()}


def _ja_existe(trabalho_id: str, u: Usuario) -> Trabalho | None:
    t = trabalhos.get(trabalho_id)
    if not t or t.estado == 'erro':
        t = _pronto_em_disco(trabalho_id)
        if t:
            trabalhos[trabalho_id] = t
    if t and t.estado == 'pronto':
        musicas.guardar_transcricao({u.id}, t.id)
    elif t:
        t.donos.add(u.id)
    return t


def _resposta(t: Trabalho, u: Usuario) -> dict:
    d = t.json()
    if t.estado == 'pronto':
        d['musica'] = musicas.musica_da_importacao(u.id, t.id)
    return d


@app.post('/api/importar')
def importar(p: Pedido, u: Usuario = Depends(exigir_usuario)) -> dict:
    video_id = youtube.id_do_video(p.link)
    if not video_id:
        raise HTTPException(400, 'Esse não parece um link de vídeo do YouTube.')
    with trava:
        t = _ja_existe(video_id, u)
        if t:
            return _resposta(t, u)
        if len(pendentes) >= MAX_FILA:
            raise HTTPException(429, 'Muitas músicas na fila agora. Tente de novo em alguns minutos.')
        t = Trabalho(video_id)
        t.donos.add(u.id)
        _enfileirar(t)
        return t.json()


@app.post('/api/enviar')
def enviar(arquivo: UploadFile = File(...), u: Usuario = Depends(exigir_usuario)) -> dict:
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
        t = _ja_existe(trabalho_id, u)
        if t:
            os.unlink(caminho)
            return _resposta(t, u)
        if len(pendentes) >= MAX_FILA:
            os.unlink(caminho)
            raise HTTPException(429, 'Muitas músicas na fila agora. Tente de novo em alguns minutos.')
        t = Trabalho(trabalho_id, arquivo=caminho)
        t.titulo = titulo
        t.donos.add(u.id)
        _enfileirar(t)
        return t.json()


@app.get('/api/importar/{video_id}')
def situacao(video_id: str, u: Usuario = Depends(exigir_usuario)) -> dict:
    if not youtube.id_valido(video_id):
        raise HTTPException(404, 'Importação não encontrada.')
    with trava:
        t = trabalhos.get(video_id) or _pronto_em_disco(video_id)
        if not t:
            raise HTTPException(404, 'Importação não encontrada.')
        return _resposta(t, u)


@app.get('/api/importar/{video_id}/midi')
def baixar_midi(video_id: str, u: Usuario = Depends(exigir_usuario)) -> FileResponse:
    if not youtube.id_valido(video_id):
        raise HTTPException(404)
    midi, _ = _arquivos(video_id)
    if not os.path.exists(midi):
        raise HTTPException(404, 'Essa música ainda não está pronta.')
    return FileResponse(midi, media_type='audio/midi', filename=f'{video_id}.mid')


# ---------------------------------------------------------------------------
# Rotas do Mac (app/mac.py). Todas exigem o MAC_TOKEN; sem ele configurado, não existem.
# ---------------------------------------------------------------------------
def _autorizar(authorization: str | None) -> None:
    if not TOKEN_MAC:
        raise HTTPException(404)
    if not hmac.compare_digest(authorization or '', f'Bearer {TOKEN_MAC}'):
        raise HTTPException(401, 'Token do Mac inválido.')


def _do_mac(video_id: str) -> Trabalho:
    """O trabalho, desde que ainda esteja com o Mac (pode ter voltado para a fila)."""
    t = trabalhos.get(video_id) if youtube.id_valido(video_id) else None
    if not t or t.onde != 'mac' or t.estado in ('pronto', 'erro'):
        raise HTTPException(409, 'Essa música não está mais com o Mac.')
    return t


class Estado(BaseModel):
    estado: str
    titulo: str = ''
    duracao: float = 0
    estimativa: float = 0


class Falha(BaseModel):
    mensagem: str


@app.post('/api/mac/proximo')
def mac_proximo(authorization: str | None = Header(None)):
    """O Mac pede trabalho (e avisa que está ligado). 204 = nada na fila."""
    global ultimo_contato_mac
    _autorizar(authorization)
    with mudou:
        ultimo_contato_mac = time.time()
        _devolver_esquecidos()
        if MODO == 'vps' or not pendentes:
            return Response(status_code=204)
        t = trabalhos[pendentes.popleft()]
        t.onde, t.atualizado = 'mac', time.time()
        log.info('%s entregue ao Mac', t.id)
        return {'id': t.id, 'tipo': 'arquivo' if t.arquivo else 'youtube', 'titulo': t.titulo,
                'max_minutos': MAX_MINUTOS}


@app.get('/api/mac/{video_id}/audio')
def mac_audio(video_id: str, authorization: str | None = Header(None)) -> FileResponse:
    _autorizar(authorization)
    with trava:
        t = _do_mac(video_id)
        t.atualizado = time.time()
        if not t.arquivo:
            raise HTTPException(404, 'Essa música vem do YouTube, não de um arquivo.')
        return FileResponse(t.arquivo, media_type='application/octet-stream')


@app.post('/api/mac/{video_id}/estado')
def mac_estado(video_id: str, e: Estado, authorization: str | None = Header(None)) -> dict:
    """Progresso e sinal de vida: o Mac manda a cada etapa e a cada 30 s durante a transcrição."""
    global ultimo_contato_mac
    _autorizar(authorization)
    if e.estado not in ('baixando', 'transcrevendo'):
        raise HTTPException(400, 'Estado inválido.')
    with trava:
        t = _do_mac(video_id)
        ultimo_contato_mac = t.atualizado = time.time()
        if e.estado == 'transcrevendo' and t.estado != 'transcrevendo':
            t.inicio_transcricao = time.time()
        t.estado = e.estado
        t.titulo = e.titulo[:200] or t.titulo
        t.duracao = e.duracao or t.duracao
        t.estimativa = e.estimativa or t.estimativa
        return {'ok': True}


@app.post('/api/mac/{video_id}/midi')
def mac_midi(video_id: str, midi: UploadFile = File(...), notas: int = Form(...),
             authorization: str | None = Header(None)) -> dict:
    _autorizar(authorization)
    with trava:
        t = _do_mac(video_id)
    fd, tmp = tempfile.mkstemp(dir=DADOS, suffix='.mid')
    with os.fdopen(fd, 'wb') as f:
        # Um MIDI de 15 minutos tem dezenas de KB; 5 MB é folga, não limite real.
        dados = midi.file.read(5 * 1024 * 1024 + 1)
        f.write(dados)
    if not dados.startswith(b'MThd') or len(dados) > 5 * 1024 * 1024:
        os.unlink(tmp)
        raise HTTPException(400, 'Isso não é um arquivo MIDI.')
    with trava:
        t = _do_mac(video_id)
        _guardar(t, tmp, notas)
        _encerrar(t, 'pronto')
    log.info('%s pronto no Mac: %d notas', t.id, notas)
    return {'ok': True}


@app.post('/api/mac/{video_id}/erro')
def mac_erro(video_id: str, f: Falha, authorization: str | None = Header(None)) -> dict:
    _autorizar(authorization)
    with trava:
        t = _do_mac(video_id)
        _encerrar(t, 'erro', f.mensagem[:300] or 'A importação falhou.')
    return {'ok': True}
