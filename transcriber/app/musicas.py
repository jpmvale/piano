"""Músicas salvas no servidor, cada uma com dono (quem enviou) ou sem dono (as da casa).

Quem pode o quê:
- ver e tocar: qualquer pessoa com conta;
- renomear: só ADMIN;
- apagar: ADMIN, ou o dono da música.

Origens:
- `casa`: as músicas escritas à mão em src/songs.ts. As notas ficam no próprio jogo; aqui só
  o título e os números da dificuldade, para o admin poder renomear ou tirar da lista.
- `midi`: arquivo .mid enviado pela pessoa (DADOS/musicas/<id>.mid).
- `audio`: transcrição de um áudio. Aponta para o MIDI em DADOS/midi, que é compartilhado por
  conteúdo (duas pessoas que enviam o mesmo áudio usam o mesmo arquivo), por isso apagar a
  música não apaga esse MIDI.

Dificuldade de 0 a 10 pelas notas por minuto (contando as duas mãos, da primeira nota ao fim
da última): um ponto a cada 40 notas por minuto, arredondado, com teto 10. As da casa ficam
entre 2 e 4; 400 notas por minuto ou mais (quase 7 por segundo) é 10.
"""
import json
import os
import secrets
import sqlite3
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .contas import DADOS, Usuario, banco, exigir_usuario

PASTA_MUSICAS = os.path.join(DADOS, 'musicas')
PASTA_MIDI = os.path.join(DADOS, 'midi')
MAX_MIDI = 2 * 1024 * 1024
NOTAS_POR_PONTO = 40

# Números calculados de src/songs.ts (notas, segundos da primeira nota ao fim da última).
CASA = [
    ('casa:brilha-brilha', 'Brilha, Brilha Estrelinha', 64, 31.30),
    ('casa:parabens', 'Parabéns pra Você', 34, 13.89),
    ('casa:ode-alegria', 'Ode à Alegria', 82, 38.40),
    ('casa:canone-re', 'Cânone em Ré (fácil)', 66, 56.67),
]

router = APIRouter(prefix='/api/musicas')

ESQUEMA = """
CREATE TABLE IF NOT EXISTS musicas (
    id TEXT PRIMARY KEY,
    titulo TEXT NOT NULL,
    origem TEXT NOT NULL CHECK (origem IN ('casa', 'midi', 'audio')),
    dono_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    arquivo TEXT,
    notas INTEGER NOT NULL,
    duracao REAL NOT NULL,
    criada_em REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT);
"""


def notas_por_minuto(notas: int, duracao: float) -> float:
    return notas / (max(duracao, 1.0) / 60)


def dificuldade(notas: int, duracao: float) -> int:
    return max(0, min(10, round(notas_por_minuto(notas, duracao) / NOTAS_POR_PONTO)))


def iniciar() -> None:
    """Cria a tabela e, só na primeira vez, põe as músicas da casa e as já transcritas.

    Só na primeira vez para que uma música da casa apagada pelo admin não volte a cada deploy.
    As transcrições feitas antes das contas existirem ficam sem dono (cuidadas pelo admin).
    """
    os.makedirs(PASTA_MUSICAS, exist_ok=True)
    with banco() as con:
        con.executescript(ESQUEMA)
        if con.execute("SELECT 1 FROM meta WHERE chave = 'semeado'").fetchone():
            return
        agora = time.time()
        for i, (mid, titulo, notas, duracao) in enumerate(CASA):
            con.execute('INSERT OR IGNORE INTO musicas (id, titulo, origem, notas, duracao, criada_em) '
                        "VALUES (?, ?, 'casa', ?, ?, ?)", (mid, titulo, notas, duracao, agora + i * 1e-3))
        for nome in sorted(os.listdir(PASTA_MIDI)) if os.path.isdir(PASTA_MIDI) else []:
            if not nome.endswith('.json'):
                continue
            tid = nome[:-5]
            try:
                with open(os.path.join(PASTA_MIDI, nome), encoding='utf-8') as f:
                    info = json.load(f)
            except (OSError, ValueError):
                continue
            if os.path.exists(os.path.join(PASTA_MIDI, f'{tid}.mid')):
                _inserir_audio(con, None, tid, info.get('titulo') or 'Áudio enviado',
                               int(info.get('notas') or 0), float(info.get('duracao') or 0))
        con.execute("INSERT INTO meta (chave, valor) VALUES ('semeado', '1')")


def _novo_id() -> str:
    return secrets.token_urlsafe(9)


def _inserir_audio(con: sqlite3.Connection, dono_id: int | None, trabalho_id: str, titulo: str,
                   notas: int, duracao: float) -> str:
    """Música de uma transcrição pronta. Não duplica se a pessoa importar o mesmo áudio de novo."""
    arquivo = f'midi/{trabalho_id}.mid'
    linha = con.execute('SELECT id FROM musicas WHERE arquivo = ? AND dono_id IS ?', (arquivo, dono_id)).fetchone()
    if linha:
        return linha['id']
    mid = _novo_id()
    con.execute('INSERT INTO musicas (id, titulo, origem, dono_id, arquivo, notas, duracao, criada_em) '
                "VALUES (?, ?, 'audio', ?, ?, ?, ?, ?)",
                (mid, titulo[:120] or 'Áudio enviado', dono_id, arquivo, notas, duracao, time.time()))
    return mid


def guardar_transcricao(donos: set[int], trabalho_id: str) -> None:
    """Chamado quando uma importação fica pronta: uma música para cada pessoa que pediu."""
    if not donos:
        return
    try:
        with open(os.path.join(PASTA_MIDI, f'{trabalho_id}.json'), encoding='utf-8') as f:
            info = json.load(f)
    except (OSError, ValueError):
        return
    with banco() as con:
        for dono in donos:
            # A conta pode ter sido apagada enquanto a música estava na fila.
            if con.execute('SELECT 1 FROM usuarios WHERE id = ?', (dono,)).fetchone():
                _inserir_audio(con, dono, trabalho_id, info.get('titulo') or 'Áudio enviado',
                               int(info.get('notas') or 0), float(info.get('duracao') or 0))


def musica_da_importacao(dono_id: int, trabalho_id: str) -> str | None:
    with banco() as con:
        linha = con.execute('SELECT id FROM musicas WHERE arquivo = ? AND dono_id = ?',
                            (f'midi/{trabalho_id}.mid', dono_id)).fetchone()
    return linha['id'] if linha else None


# ---------------------------------------------------------------------------
# Rotas
# ---------------------------------------------------------------------------
def _json(linha: sqlite3.Row, u: Usuario) -> dict:
    minha = linha['dono_id'] is not None and linha['dono_id'] == u.id
    return {
        'id': linha['id'],
        'titulo': linha['titulo'],
        'origem': linha['origem'],
        'dono': {'id': linha['dono_id'], 'nome': linha['dono_nome']} if linha['dono_id'] is not None else None,
        'minha': minha,
        'criada_em': round(linha['criada_em'], 3),
        'notas': linha['notas'],
        'duracao': round(linha['duracao'], 1),
        'notas_por_minuto': round(notas_por_minuto(linha['notas'], linha['duracao'])),
        'dificuldade': dificuldade(linha['notas'], linha['duracao']),
        'pode_renomear': u.admin,
        'pode_apagar': u.admin or minha,
    }


_SELECT = ('SELECT m.*, u.nome AS dono_nome FROM musicas m LEFT JOIN usuarios u ON u.id = m.dono_id ')


def _buscar(con: sqlite3.Connection, mid: str) -> sqlite3.Row:
    linha = con.execute(_SELECT + 'WHERE m.id = ?', (mid,)).fetchone()
    if not linha:
        raise HTTPException(404, 'Música não encontrada.')
    return linha


@router.get('')
def listar(u: Usuario = Depends(exigir_usuario)) -> list[dict]:
    with banco() as con:
        linhas = con.execute(_SELECT + 'ORDER BY m.criada_em').fetchall()
    return [_json(linha, u) for linha in linhas]


@router.get('/{mid}/midi')
def baixar(mid: str, u: Usuario = Depends(exigir_usuario)) -> FileResponse:
    with banco() as con:
        linha = _buscar(con, mid)
    if not linha['arquivo']:
        raise HTTPException(404, 'Essa música vem com o jogo.')
    caminho = os.path.join(DADOS, linha['arquivo'])
    if not os.path.exists(caminho):
        raise HTTPException(404, 'O arquivo dessa música sumiu do servidor.')
    return FileResponse(caminho, media_type='audio/midi', filename=f'{mid}.mid')


@router.post('/midi')
def enviar_midi(arquivo: UploadFile = File(...), titulo: str = Form(''), notas: int = Form(...),
                duracao: float = Form(...), u: Usuario = Depends(exigir_usuario)) -> dict:
    """Arquivo .mid da pessoa. O jogo já leu o arquivo para tocar, e manda junto a contagem de notas."""
    dados = arquivo.file.read(MAX_MIDI + 1)
    if len(dados) > MAX_MIDI:
        raise HTTPException(413, 'O arquivo MIDI passa de 2 MB.')
    if not dados.startswith(b'MThd'):
        raise HTTPException(400, 'Isso não é um arquivo MIDI.')
    if not (0 < notas <= 200_000 and 0 < duracao <= 3 * 3600):
        raise HTTPException(400, 'Esse arquivo MIDI não tem notas.')
    titulo = titulo.strip()[:120] or os.path.splitext(arquivo.filename or '')[0].strip()[:120] or 'Arquivo MIDI'
    mid = _novo_id()
    rel = f'musicas/{mid}.mid'
    with open(os.path.join(DADOS, rel), 'wb') as f:
        f.write(dados)
    with banco() as con:
        con.execute('INSERT INTO musicas (id, titulo, origem, dono_id, arquivo, notas, duracao, criada_em) '
                    "VALUES (?, ?, 'midi', ?, ?, ?, ?, ?)", (mid, titulo, u.id, rel, notas, duracao, time.time()))
        return _json(_buscar(con, mid), u)


class NovoTitulo(BaseModel):
    titulo: str


@router.patch('/{mid}')
def renomear(mid: str, n: NovoTitulo, u: Usuario = Depends(exigir_usuario)) -> dict:
    if not u.admin:
        raise HTTPException(403, 'Só o administrador pode mudar o nome das músicas.')
    titulo = n.titulo.strip()
    if not 1 <= len(titulo) <= 120:
        raise HTTPException(400, 'O nome precisa ter de 1 a 120 letras.')
    with banco() as con:
        _buscar(con, mid)
        con.execute('UPDATE musicas SET titulo = ? WHERE id = ?', (titulo, mid))
        return _json(_buscar(con, mid), u)


@router.delete('/{mid}')
def apagar(mid: str, u: Usuario = Depends(exigir_usuario)) -> dict:
    with banco() as con:
        linha = _buscar(con, mid)
        if not (u.admin or (linha['dono_id'] is not None and linha['dono_id'] == u.id)):
            raise HTTPException(403, 'Só quem enviou a música ou o administrador pode apagá-la.')
        con.execute('DELETE FROM musicas WHERE id = ?', (mid,))
    # O .mid enviado é só desta música; o MIDI de transcrição (midi/) é cache compartilhado.
    if linha['origem'] == 'midi' and linha['arquivo']:
        try:
            os.unlink(os.path.join(DADOS, linha['arquivo']))
        except OSError:
            pass
    return {'ok': True}
