"""Ambiente comum dos testes da API: precisa vir antes de qualquer `from app import main`."""
import itertools
import os
import tempfile

os.environ.update(DADOS=tempfile.mkdtemp(), MAC_TOKEN='segredo', MODO_TRANSCRICAO='mac',
                  CODIGO_CONVITE='convite-de-teste', ADMIN_EMAIL='chefe@exemplo.com, chefe2@exemplo.com')

_contador = itertools.count()


def cadastrar(cliente, email: str = '', nome: str = 'Pessoa') -> dict:
    """Cria uma conta e deixa o cliente logado nela."""
    email = email or f'pessoa{next(_contador)}@exemplo.com'
    r = cliente.post('/api/auth/cadastro', json={'nome': nome, 'email': email, 'senha': 'senha-boa-123',
                                                 'convite': 'convite-de-teste'})
    assert r.status_code == 200, r.text
    return r.json()
