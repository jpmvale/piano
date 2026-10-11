"""Contas: cadastro com código de convite, login com sessão opaca e papéis ADMIN/USER.

Mesmo desenho do Property Scout:
- senha com argon2id;
- a sessão é um token aleatório que só o navegador conhece (cookie httpOnly); o banco guarda
  o sha256 dele, então um vazamento do banco não entrega sessões;
- a validade (30 dias) é renovada a cada uso;
- freio de força bruta por e-mail e por IP, conferido ANTES do argon2 (que é o trabalho caro);
- mensagem genérica de credencial: não diz se o e-mail existe.

O cadastro exige CODIGO_CONVITE (um código só, combinado com quem pode entrar; trocar o código
não derruba quem já entrou). Sem ele configurado, o cadastro fica fechado. Os e-mails em
ADMIN_EMAIL (separados por vírgula) viram ADMIN, inclusive contas já criadas.

Tudo num SQLite no volume de dados, que também guarda as músicas (app/musicas.py).
"""
import contextlib
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from collections.abc import Iterator
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

DADOS = os.environ.get('DADOS', '/data')
BANCO = os.path.join(DADOS, 'piano.db')
COOKIE = 'piano_sessao'
SESSAO_S = 30 * 86400

LIVRES_POR_EMAIL = 5
# Mais folgado: um IP é compartilhado (operadora com NAT, rede de celular).
LIVRES_POR_IP = 20
ESPERA_INICIAL_S = 30
ESPERA_MAXIMA_S = 15 * 60
# Sem falha por este tempo, a contagem recomeça: o freio é contra rajada, não contra memória.
JANELA_S = 60 * 60

CREDENCIAL_INVALIDA = 'E-mail ou senha inválidos.'

_hasher = PasswordHasher()
# Login de e-mail inexistente também roda o argon2, para o tempo de resposta não entregar a conta.
_HASH_DESCARTAVEL = _hasher.hash(secrets.token_hex(16))

router = APIRouter(prefix='/api/auth')


def _convite() -> str:
    return os.environ.get('CODIGO_CONVITE', '').strip()


def _admins() -> set[str]:
    return {e.strip().lower() for e in os.environ.get('ADMIN_EMAIL', '').split(',') if e.strip()}


# ---------------------------------------------------------------------------
# Banco
# ---------------------------------------------------------------------------
@contextlib.contextmanager
def banco() -> Iterator[sqlite3.Connection]:
    """Uma conexão por operação, com commit no fim (ou rollback se der erro)."""
    con = sqlite3.connect(BANCO, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    try:
        with con:
            yield con
    finally:
        con.close()


ESQUEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    papel TEXT NOT NULL DEFAULT 'USER' CHECK (papel IN ('ADMIN', 'USER')),
    criado_em REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tentativas (
    tipo TEXT NOT NULL,
    chave TEXT NOT NULL,
    falhas INTEGER NOT NULL,
    ultima REAL NOT NULL,
    bloqueado_ate REAL,
    PRIMARY KEY (tipo, chave)
);
"""


def iniciar() -> None:
    os.makedirs(DADOS, exist_ok=True)
    with banco() as con:
        con.execute('PRAGMA journal_mode = WAL')
        con.executescript(ESQUEMA)
        for email in _admins():
            con.execute("UPDATE usuarios SET papel = 'ADMIN' WHERE email = ?", (email,))


# ---------------------------------------------------------------------------
# Sessões
# ---------------------------------------------------------------------------
@dataclass
class Usuario:
    id: int
    nome: str
    email: str
    papel: str

    @property
    def admin(self) -> bool:
        return self.papel == 'ADMIN'

    def json(self) -> dict:
        return {'id': self.id, 'nome': self.nome, 'email': self.email, 'papel': self.papel}


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _criar_sessao(con: sqlite3.Connection, usuario_id: int) -> str:
    token = secrets.token_urlsafe(32)
    con.execute('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)',
                (_hash_token(token), usuario_id, time.time() + SESSAO_S))
    return token


def _gravar_cookie(resp: Response, req: Request, token: str) -> None:
    resp.set_cookie(COOKIE, token, max_age=SESSAO_S, httponly=True, samesite='lax', path='/',
                    secure=req.url.scheme == 'https')


def usuario_da_sessao(req: Request) -> Usuario | None:
    token = req.cookies.get(COOKIE)
    if not token:
        return None
    agora = time.time()
    with banco() as con:
        linha = con.execute(
            'SELECT u.id, u.nome, u.email, u.papel, s.token_hash FROM sessoes s '
            'JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ? AND s.expira_em > ?',
            (_hash_token(token), agora)).fetchone()
        if not linha:
            return None
        # Validade renovada a cada uso: quem joga sempre não precisa entrar de novo.
        con.execute('UPDATE sessoes SET expira_em = ? WHERE token_hash = ?', (agora + SESSAO_S, linha['token_hash']))
    return Usuario(linha['id'], linha['nome'], linha['email'], linha['papel'])


def exigir_usuario(req: Request) -> Usuario:
    """Dependência das rotas que pedem login."""
    u = usuario_da_sessao(req)
    if not u:
        raise HTTPException(401, 'Entre na sua conta para continuar.')
    return u


# ---------------------------------------------------------------------------
# Freio de tentativas de login
# ---------------------------------------------------------------------------
def _espera(falhas: int, livres: int) -> float:
    """Com 5 livres, a quinta falha já tranca: 30 s, 1 min, 2 min… até 15 min."""
    excedentes = falhas - livres + 1
    if excedentes <= 0:
        return 0
    return min(ESPERA_INICIAL_S * 2 ** (excedentes - 1), ESPERA_MAXIMA_S)


def _chaves(email: str, ip: str | None) -> list[tuple[str, str, int]]:
    chaves = [('EMAIL', email, LIVRES_POR_EMAIL)]
    if ip:
        chaves.append(('IP', ip, LIVRES_POR_IP))
    return chaves


def _bloqueio(con: sqlite3.Connection, email: str, ip: str | None) -> int:
    agora = time.time()
    for tipo, chave, _ in _chaves(email, ip):
        linha = con.execute('SELECT bloqueado_ate FROM tentativas WHERE tipo = ? AND chave = ?',
                            (tipo, chave)).fetchone()
        if linha and linha['bloqueado_ate'] and linha['bloqueado_ate'] > agora:
            return int(linha['bloqueado_ate'] - agora) + 1
    return 0


def _registrar_falha(con: sqlite3.Connection, email: str, ip: str | None) -> None:
    """Conta MESMO quando o e-mail não existe, para o freio não virar um oráculo de contas."""
    agora = time.time()
    for tipo, chave, livres in _chaves(email, ip):
        linha = con.execute('SELECT falhas, ultima FROM tentativas WHERE tipo = ? AND chave = ?',
                            (tipo, chave)).fetchone()
        falhas = linha['falhas'] + 1 if linha and agora - linha['ultima'] <= JANELA_S else 1
        espera = _espera(falhas, livres)
        con.execute(
            'INSERT INTO tentativas (tipo, chave, falhas, ultima, bloqueado_ate) VALUES (?, ?, ?, ?, ?) '
            'ON CONFLICT (tipo, chave) DO UPDATE SET falhas = excluded.falhas, ultima = excluded.ultima, '
            'bloqueado_ate = excluded.bloqueado_ate',
            (tipo, chave, falhas, agora, agora + espera if espera else None))


def _por_extenso(segundos: int) -> str:
    if segundos < 60:
        return f'{segundos} segundo{"" if segundos == 1 else "s"}'
    minutos = -(-segundos // 60)
    return f'{minutos} minuto{"" if minutos == 1 else "s"}'


# ---------------------------------------------------------------------------
# Rotas
# ---------------------------------------------------------------------------
EMAIL_OK = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


class Cadastro(BaseModel):
    nome: str
    email: str
    senha: str
    convite: str


class Entrada(BaseModel):
    email: str
    senha: str


def _ip(req: Request) -> str | None:
    return req.client.host if req.client else None


@router.post('/cadastro')
def cadastro(c: Cadastro, req: Request, resp: Response) -> dict:
    convite = _convite()
    # O convite vem antes de tudo: sem ele, nem se descobre se um e-mail já tem conta.
    if not convite:
        raise HTTPException(403, 'O cadastro está fechado no momento.')
    if not hmac.compare_digest(c.convite.strip().encode(), convite.encode()):
        raise HTTPException(403, 'Código de convite inválido.')
    nome, email = c.nome.strip(), c.email.strip().lower()
    if not 2 <= len(nome) <= 80:
        raise HTTPException(400, 'Informe seu nome.')
    if not EMAIL_OK.match(email) or len(email) > 200:
        raise HTTPException(400, 'E-mail inválido.')
    if not 8 <= len(c.senha) <= 200:
        raise HTTPException(400, 'A senha precisa de ao menos 8 caracteres.')
    papel = 'ADMIN' if email in _admins() else 'USER'
    senha_hash = _hasher.hash(c.senha)
    with banco() as con:
        try:
            cur = con.execute('INSERT INTO usuarios (nome, email, senha_hash, papel, criado_em) VALUES (?, ?, ?, ?, ?)',
                              (nome, email, senha_hash, papel, time.time()))
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'Já existe uma conta com este e-mail.') from None
        token = _criar_sessao(con, cur.lastrowid)
    _gravar_cookie(resp, req, token)
    return Usuario(cur.lastrowid, nome, email, papel).json()


@router.post('/entrar')
def entrar(e: Entrada, req: Request, resp: Response) -> dict:
    email, ip = e.email.strip().lower(), _ip(req)
    with banco() as con:
        espera = _bloqueio(con, email, ip)
        if espera:
            raise HTTPException(429, f'Muitas tentativas. Tente de novo em {_por_extenso(espera)}.',
                                headers={'Retry-After': str(espera)})
        linha = con.execute('SELECT id, nome, email, papel, senha_hash FROM usuarios WHERE email = ?',
                            (email,)).fetchone()
    try:
        _hasher.verify(linha['senha_hash'] if linha else _HASH_DESCARTAVEL, e.senha[:200])
        ok = linha is not None
    except (VerifyMismatchError, InvalidHashError):
        ok = False
    if not ok:
        # Fora do `with` de baixo: uma exceção lá dentro desfaria a gravação da falha.
        with banco() as con:
            _registrar_falha(con, email, ip)
        raise HTTPException(401, CREDENCIAL_INVALIDA)
    with banco() as con:
        # Acerto zera só a contagem do e-mail: a do IP fica, para uma conta válida não
        # poder zerar o contador da máquina de onde se varre as outras.
        con.execute("DELETE FROM tentativas WHERE tipo = 'EMAIL' AND chave = ?", (email,))
        con.execute('DELETE FROM tentativas WHERE ultima < ?', (time.time() - JANELA_S,))
        con.execute('DELETE FROM sessoes WHERE expira_em < ?', (time.time(),))
        token = _criar_sessao(con, linha['id'])
    _gravar_cookie(resp, req, token)
    return Usuario(linha['id'], linha['nome'], linha['email'], linha['papel']).json()


@router.post('/sair')
def sair(req: Request, resp: Response) -> dict:
    token = req.cookies.get(COOKIE)
    if token:
        with banco() as con:
            con.execute('DELETE FROM sessoes WHERE token_hash = ?', (_hash_token(token),))
    resp.delete_cookie(COOKIE, path='/')
    return {'ok': True}


@router.get('/eu')
def eu(u: Usuario = Depends(exigir_usuario)) -> dict:
    return u.json()
