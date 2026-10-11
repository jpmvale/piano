"""Trabalhador que roda no Mac: pega músicas da fila da VPS, transcreve aqui e devolve o MIDI.

O Mac fica atrás do roteador de casa, então é ele quem chama a VPS (e não o
contrário): pede trabalho a cada poucos segundos em /api/mac/proximo. Isso
também resolve o bloqueio do YouTube, que barra o IP da VPS mas não o de casa.

Uso (ver transcriber/mac/README.md):
    python -m app.mac --servidor https://piano.imp-software.cloud --token <MAC_TOKEN>
"""
import argparse
import json
import logging
import os
import subprocess
import tempfile
import threading
import time

import requests
from yt_dlp.utils import DownloadError

from . import youtube
from .comum import ErroParaPessoa, conferir_limite, duracao, explicar_download, iniciar_transcricao, \
    resultado_transcricao

log = logging.getLogger('piano-mac')
CONFIG = os.path.expanduser('~/.piano-mac/estado.json')


class Perdido(Exception):
    """A VPS devolveu a música para a fila (409): parar sem avisar erro."""


class Cliente:
    def __init__(self, servidor: str, token: str):
        self.base = servidor.rstrip('/') + '/api/mac'
        self.s = requests.Session()
        self.s.headers['Authorization'] = f'Bearer {token}'

    def _r(self, metodo: str, caminho: str, **kw) -> requests.Response:
        r = self.s.request(metodo, self.base + caminho, timeout=kw.pop('timeout', 30), **kw)
        if r.status_code == 409:
            raise Perdido()
        if r.status_code == 401:
            raise SystemExit('A VPS recusou o token. Confira o MAC_TOKEN dos dois lados.')
        if r.status_code == 404 and caminho == '/proximo':
            raise SystemExit('A VPS não aceita o Mac: MAC_TOKEN não está configurado lá.')
        r.raise_for_status()
        return r

    def proximo(self) -> dict | None:
        r = self._r('POST', '/proximo')
        return None if r.status_code == 204 else r.json()

    def baixar_audio(self, tid: str, destino: str) -> None:
        with self._r('GET', f'/{tid}/audio', stream=True, timeout=120) as r, open(destino, 'wb') as f:
            for bloco in r.iter_content(1 << 20):
                f.write(bloco)

    def estado(self, tid: str, **campos) -> None:
        self._r('POST', f'/{tid}/estado', json=campos)

    def midi(self, tid: str, caminho: str, notas: int) -> None:
        with open(caminho, 'rb') as f:
            self._r('POST', f'/{tid}/midi', files={'midi': ('saida.mid', f, 'audio/midi')},
                    data={'notas': str(notas)}, timeout=60)

    def erro(self, tid: str, mensagem: str) -> None:
        self._r('POST', f'/{tid}/erro', json={'mensagem': mensagem})


# ---------------------------------------------------------------------------
# Memória entre execuções: em que dispositivo o modelo roda e quão rápido.
# ---------------------------------------------------------------------------
def _ler_estado() -> dict:
    try:
        with open(CONFIG, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _gravar_estado(d: dict) -> None:
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump(d, f)


def _transcrever(cli: Cliente, tid: str, audio: str, saida: str, segundos: float, memoria: dict) -> int:
    """Roda o modelo mandando sinal de vida à VPS a cada 30 s. Tenta a GPU (mps) e cai para a CPU."""
    dispositivos = [memoria['dispositivo']] if memoria.get('dispositivo') else ['auto', 'cpu']
    for i, disp in enumerate(dispositivos):
        fator = memoria.get('fator', {}).get(disp, 1.0)
        cli.estado(tid, estado='transcrevendo', duracao=segundos, estimativa=segundos * fator)
        inicio = time.time()
        proc = iniciar_transcricao(audio, saida, {'DEVICE': disp, 'PYTORCH_ENABLE_MPS_FALLBACK': '1'})
        parar = threading.Event()

        def sinal_de_vida():
            while not parar.wait(30):
                try:
                    cli.estado(tid, estado='transcrevendo')
                except Perdido:
                    log.warning('%s voltou para a fila da VPS; interrompendo', tid)
                    proc.kill()
                    return
                except requests.RequestException as e:
                    log.warning('sem contato com a VPS: %s', e)

        threading.Thread(target=sinal_de_vida, daemon=True).start()
        try:
            notas = resultado_transcricao(proc, max(1800, segundos * 6), tid)
        except ErroParaPessoa:
            if i + 1 < len(dispositivos):
                log.warning('falhou com DEVICE=%s; tentando de novo na CPU', disp)
                continue
            raise
        finally:
            parar.set()
        memoria['dispositivo'] = disp
        # Trecho curto mede mais o carregamento do modelo que a velocidade: só aprende com músicas.
        if segundos >= 30:
            memoria.setdefault('fator', {})[disp] = round((time.time() - inicio) / segundos, 2)
        _gravar_estado(memoria)
        return notas
    raise ErroParaPessoa('Não consegui transcrever esse áudio.')


def processar(cli: Cliente, trabalho: dict) -> None:
    tid, max_min = trabalho['id'], float(trabalho.get('max_minutos') or 15)
    memoria = _ler_estado()
    with tempfile.TemporaryDirectory() as tmp:
        titulo = trabalho.get('titulo') or ''
        if trabalho['tipo'] == 'arquivo':
            audio = os.path.join(tmp, 'audio')
            cli.estado(tid, estado='baixando', titulo=titulo)
            cli.baixar_audio(tid, audio)
            segundos = duracao(audio)
            conferir_limite(segundos, max_min, 'O áudio')
        else:
            cli.estado(tid, estado='baixando')
            try:
                info = youtube.informacoes(tid)
                if info['ao_vivo']:
                    raise ErroParaPessoa('Transmissões ao vivo não podem ser importadas.')
                conferir_limite(info['duracao'], max_min, 'O vídeo')
                titulo = info['titulo']
                cli.estado(tid, estado='baixando', titulo=titulo, duracao=info['duracao'])
                audio = youtube.baixar_audio(tid, tmp)
            except DownloadError as e:
                raise ErroParaPessoa(explicar_download(e).replace('do servidor', 'do Mac')) from e
            segundos = duracao(audio)

        saida = os.path.join(tmp, 'saida.mid')
        inicio = time.time()
        notas = _transcrever(cli, tid, audio, saida, segundos, memoria)
        cli.midi(tid, saida, notas)
        log.info('%s pronto: %d notas, %.0f s de áudio em %.0f s (%s)', tid, notas, segundos,
                 time.time() - inicio, memoria.get('dispositivo'))


def main() -> None:
    p = argparse.ArgumentParser(description='Transcreve no Mac as músicas da fila do Piano Cascata.')
    p.add_argument('--servidor', default=os.environ.get('PIANO_SERVIDOR', 'https://piano.imp-software.cloud'))
    p.add_argument('--token', default=os.environ.get('MAC_TOKEN', ''))
    p.add_argument('--intervalo', type=float, default=5, help='segundos entre pedidos de trabalho')
    a = p.parse_args()
    if not a.token:
        raise SystemExit('Falta o token (--token ou MAC_TOKEN).')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    cli = Cliente(a.servidor, a.token)
    log.info('pedindo trabalho a %s a cada %.0f s', a.servidor, a.intervalo)
    while True:
        try:
            trabalho = cli.proximo()
        except requests.RequestException as e:
            log.warning('sem contato com a VPS: %s', e)
            time.sleep(30)
            continue
        if not trabalho:
            time.sleep(a.intervalo)
            continue
        tid = trabalho['id']
        log.info('%s: começando (%s)', tid, trabalho['tipo'])
        acordado = _manter_acordado()
        try:
            processar(cli, trabalho)
        except Perdido:
            pass
        except ErroParaPessoa as e:
            log.warning('%s: %s', tid, e)
            try:
                cli.erro(tid, str(e))
            except (Perdido, requests.RequestException):
                pass
        except requests.HTTPError as e:
            # Recusa da VPS (4xx): repetir daria o mesmo erro para sempre, então desiste da música.
            log.warning('%s: a VPS recusou (%s)', tid, e)
            if e.response is not None and 400 <= e.response.status_code < 500:
                try:
                    cli.erro(tid, 'Algo deu errado na importação. Tente de novo.')
                except (Perdido, requests.RequestException):
                    pass
        except requests.RequestException as e:
            # A VPS devolve a música para a fila sozinha depois do prazo.
            log.warning('%s: perdi o contato com a VPS no meio (%s)', tid, e)
        except Exception:  # noqa: BLE001 — o trabalhador não pode morrer por uma música
            log.exception('%s: falha inesperada', tid)
            try:
                cli.erro(tid, 'Algo deu errado na importação. Tente de novo.')
            except (Perdido, requests.RequestException):
                pass
        finally:
            if acordado:
                acordado.kill()


def _manter_acordado() -> subprocess.Popen | None:
    """Impede o Mac de dormir só enquanto uma música está sendo transcrita."""
    try:
        return subprocess.Popen(['caffeinate', '-i', '-w', str(os.getpid())])
    except OSError:
        return None


if __name__ == '__main__':
    main()
