"""Lê o link do YouTube, confere a duração e baixa só o áudio, com o yt-dlp."""
import contextlib
import os
import re
import shutil
import tempfile

import yt_dlp

# 11 caracteres de [A-Za-z0-9_-]: é o formato de todo id de vídeo do YouTube.
_ID = r'([A-Za-z0-9_-]{11})'
_PADROES = [
    re.compile(r'^https?://(?:www\.|m\.|music\.)?youtube\.com/watch\?(?:.*&)?v=' + _ID + r'(?:[&#].*)?$'),
    re.compile(r'^https?://(?:www\.|m\.)?youtube\.com/(?:shorts|embed|live)/' + _ID + r'(?:[/?#].*)?$'),
    re.compile(r'^https?://youtu\.be/' + _ID + r'(?:[/?#].*)?$'),
]


def id_valido(texto: str) -> bool:
    return re.fullmatch(_ID, texto) is not None


def id_do_video(link: str) -> str | None:
    """Devolve o id do vídeo, ou None se o texto não for um link do YouTube."""
    link = link.strip()
    if not link.startswith(('http://', 'https://')):
        link = 'https://' + link
    for p in _PADROES:
        m = p.match(link)
        if m:
            return m.group(1)
    return None


@contextlib.contextmanager
def _opcoes(extra: dict):
    opcoes = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'noprogress': True}
    # O YouTube pede login para downloads vindos de IPs de datacenter ("confirme
    # que você não é um robô"). Um arquivo de cookies exportado do navegador
    # resolve. O yt-dlp regrava o arquivo ao terminar, então ele trabalha numa
    # cópia: o original pode ficar montado só para leitura.
    cookies = os.environ.get('YTDLP_COOKIES')
    copia = None
    if cookies and os.path.isfile(cookies):
        fd, copia = tempfile.mkstemp(suffix='.txt')
        with os.fdopen(fd, 'wb') as dst, open(cookies, 'rb') as src:
            shutil.copyfileobj(src, dst)
        opcoes['cookiefile'] = copia
    try:
        yield {**opcoes, **extra}
    finally:
        if copia:
            os.unlink(copia)


def tem_cookies() -> bool:
    cookies = os.environ.get('YTDLP_COOKIES')
    return bool(cookies and os.path.isfile(cookies))


def informacoes(video_id: str) -> dict:
    with _opcoes({'skip_download': True}) as opcoes, yt_dlp.YoutubeDL(opcoes) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
    return {'titulo': info.get('title') or video_id, 'duracao': float(info.get('duration') or 0),
            'ao_vivo': bool(info.get('is_live'))}


def baixar_audio(video_id: str, pasta: str) -> str:
    """Baixa o melhor áudio disponível e devolve o caminho do arquivo."""
    modelo = os.path.join(pasta, f'{video_id}.%(ext)s')
    with _opcoes({'format': 'bestaudio/best', 'outtmpl': modelo}) as opcoes, yt_dlp.YoutubeDL(opcoes) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=True)
        return ydl.prepare_filename(info)
