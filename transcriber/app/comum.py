"""Peças usadas tanto pelo servidor (main.py) quanto pelo trabalhador do Mac (mac.py)."""
import logging
import os
import subprocess
import sys

from yt_dlp.utils import DownloadError

log = logging.getLogger('piano-api')
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ErroParaPessoa(Exception):
    """Erro com mensagem pronta para mostrar na tela."""


def duracao(arquivo: str) -> float:
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', arquivo],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        raise ErroParaPessoa('Esse arquivo não parece ser de áudio.') from None


def conferir_limite(segundos: float, max_minutos: float, o_que: str) -> None:
    if segundos > max_minutos * 60:
        raise ErroParaPessoa(f'{o_que} tem {segundos / 60:.1f} minutos. O limite é {max_minutos:.0f} minutos por música.')


def explicar_download(e: DownloadError) -> str:
    msg = str(e)
    log.warning('yt-dlp: %s', msg)
    if 'Sign in' in msg or 'bot' in msg:
        return ('O YouTube bloqueou o download a partir do servidor. '
                'Enquanto isso, você pode enviar o arquivo de áudio da música.')
    if 'Private video' in msg or 'unavailable' in msg.lower():
        return 'Esse vídeo é privado ou não está disponível.'
    return 'Não consegui baixar o áudio desse vídeo.'


def iniciar_transcricao(audio: str, saida: str, env: dict | None = None) -> subprocess.Popen:
    """Roda app.transcrever num processo à parte (a memória do modelo volta ao sistema no fim)."""
    return subprocess.Popen([sys.executable, '-m', 'app.transcrever', audio, saida],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            cwd=RAIZ, env={**os.environ, **(env or {})})


def resultado_transcricao(proc: subprocess.Popen, timeout: float, quem: str) -> int:
    """Espera o processo e devolve o número de notas, ou levanta ErroParaPessoa."""
    try:
        saida, erro = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise ErroParaPessoa('A transcrição demorou demais e foi interrompida.') from None
    if proc.returncode != 0:
        log.error('transcrição de %s falhou: %s', quem, (erro or '')[-2000:])
        raise ErroParaPessoa('Não consegui transcrever esse áudio.')
    notas = int((saida.split() or ['0'])[0])
    if notas == 0:
        raise ErroParaPessoa('Não encontrei notas de piano nesse áudio.')
    return notas
