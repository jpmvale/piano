"""Transcreve um arquivo de áudio de piano para MIDI com o Transkun.

Roda como processo separado (python -m app.transcrever entrada saida.mid) para
a memória do modelo (cerca de 2 GB no pico) voltar ao sistema ao fim de cada
música, em vez de ficar presa no servidor entre uma importação e outra.
"""
import os
import subprocess
import sys

import numpy as np


def ler_audio(caminho: str, taxa: int) -> np.ndarray:
    # ffmpeg em vez do pydub que o transkun usa: o pydub depende do módulo
    # audioop, que saiu do Python 3.13.
    bruto = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', caminho, '-f', 'f32le', '-ac', '2', '-ar', str(taxa), '-'],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(bruto, np.float32).reshape(-1, 2).copy()


def transcrever(entrada: str, saida: str) -> int:
    import moduleconf
    import torch
    import transkun
    from transkun.Data import writeMidi

    torch.set_num_threads(int(os.environ.get('THREADS', '2')))
    torch.set_grad_enabled(False)

    pasta = os.path.join(os.path.dirname(transkun.__file__), 'pretrained')
    conf = moduleconf.parseFromFile(os.path.join(pasta, '2.0.conf'))['Model']
    modelo = conf.module.TransKun(conf=conf.config)
    pesos = torch.load(os.path.join(pasta, '2.0.pt'), map_location='cpu')
    modelo.load_state_dict(pesos.get('best_state_dict', pesos.get('state_dict')), strict=False)
    modelo.eval()

    audio = ler_audio(entrada, modelo.fs)
    notas = modelo.transcribe(torch.from_numpy(audio), discardSecondHalf=False)
    midi = writeMidi(notas)
    midi.write(saida)
    return sum(len(i.notes) for i in midi.instruments)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('uso: python -m app.transcrever <áudio> <saída.mid>')
    print(transcrever(sys.argv[1], sys.argv[2]), 'notas')
