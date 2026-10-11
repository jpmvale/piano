"""Contas (convite, login, freio de tentativas) e permissões sobre as músicas."""
import io
import os
import unittest

from tests.ajuda import cadastrar  # antes do app: prepara o ambiente  # isort: skip

from fastapi.testclient import TestClient

from app import contas, main

MIDI = b'MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x04\x00\xff\x2f\x00'


def cliente() -> TestClient:
    return TestClient(main.app)


class TesteContas(unittest.TestCase):
    def test_sem_login_nada_abre(self):
        c = cliente()
        self.assertEqual(c.get('/api/auth/eu').status_code, 401)
        self.assertEqual(c.get('/api/musicas').status_code, 401)
        self.assertEqual(c.post('/api/enviar', files={'arquivo': ('a.mp3', io.BytesIO(b'x'))}).status_code, 401)
        self.assertEqual(c.post('/api/importar', json={'link': 'https://youtu.be/dQw4w9WgXcQ'}).status_code, 401)
        self.assertEqual(c.get('/api/health').status_code, 200)

    def test_convite(self):
        c = cliente()
        dados = {'nome': 'Ana', 'email': 'ana@exemplo.com', 'senha': 'senha-boa-123'}
        self.assertEqual(c.post('/api/auth/cadastro', json={**dados, 'convite': 'errado'}).status_code, 403)
        self.assertEqual(c.post('/api/auth/cadastro', json={**dados, 'convite': 'convite-de-teste',
                                                            'senha': 'curta'}).status_code, 400)
        r = c.post('/api/auth/cadastro', json={**dados, 'convite': ' convite-de-teste '})
        self.assertEqual((r.status_code, r.json()['papel']), (200, 'USER'))
        self.assertEqual(c.get('/api/auth/eu').json()['email'], 'ana@exemplo.com')
        # E-mail repetido, mesmo com outra caixa
        r = cliente().post('/api/auth/cadastro', json={**dados, 'email': 'ANA@exemplo.com',
                                                       'convite': 'convite-de-teste'})
        self.assertEqual(r.status_code, 409)

    def test_sem_convite_configurado_o_cadastro_fecha(self):
        antes = os.environ.pop('CODIGO_CONVITE')
        try:
            r = cliente().post('/api/auth/cadastro', json={'nome': 'Bia', 'email': 'bia@exemplo.com',
                                                           'senha': 'senha-boa-123', 'convite': ''})
            self.assertEqual(r.status_code, 403)
        finally:
            os.environ['CODIGO_CONVITE'] = antes

    def test_entrar_e_sair(self):
        cadastrar(cliente(), 'caio@exemplo.com')
        c = cliente()
        r = c.post('/api/auth/entrar', json={'email': ' Caio@Exemplo.com ', 'senha': 'senha-boa-123'})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(c.cookies.get(contas.COOKIE))
        self.assertEqual(c.get('/api/auth/eu').status_code, 200)
        c.post('/api/auth/sair')
        self.assertEqual(c.get('/api/auth/eu').status_code, 401)

    def test_mensagem_generica_e_freio(self):
        cadastrar(cliente(), 'duda@exemplo.com')
        c = cliente()
        errado = c.post('/api/auth/entrar', json={'email': 'duda@exemplo.com', 'senha': 'errada-errada'})
        inexistente = c.post('/api/auth/entrar', json={'email': 'ninguem@exemplo.com', 'senha': 'qualquer-uma'})
        self.assertEqual(errado.status_code, 401)
        self.assertEqual(errado.json(), inexistente.json())
        for _ in range(4):
            c.post('/api/auth/entrar', json={'email': 'duda@exemplo.com', 'senha': 'errada-errada'})
        # Trancado: nem a senha certa entra agora
        r = c.post('/api/auth/entrar', json={'email': 'duda@exemplo.com', 'senha': 'senha-boa-123'})
        self.assertEqual(r.status_code, 429)
        self.assertIn('Retry-After', r.headers)

    def test_admin_pelo_email(self):
        self.assertEqual(cadastrar(cliente(), 'Chefe@exemplo.com')['papel'], 'ADMIN')


class TesteMusicas(unittest.TestCase):
    def setUp(self):
        self.dono, self.outro, self.admin = cliente(), cliente(), cliente()
        cadastrar(self.dono, nome='Dono')
        cadastrar(self.outro)
        r = self.admin.post('/api/auth/entrar', json={'email': 'chefe2@exemplo.com', 'senha': 'senha-boa-123'})
        if r.status_code != 200:
            cadastrar(self.admin, 'chefe2@exemplo.com')

    def enviar(self, c: TestClient, **extra) -> dict:
        r = c.post('/api/musicas/midi', files={'arquivo': ('Minha peça.mid', io.BytesIO(MIDI))},
                   data={'notas': '120', 'duracao': '60', **extra})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_casa_ja_vem_com_dificuldade(self):
        casa = [m for m in self.dono.get('/api/musicas').json() if m['origem'] == 'casa']
        self.assertGreaterEqual(len(casa), 3)
        for m in casa:
            self.assertIsNone(m['dono'])
            self.assertTrue(1 <= m['dificuldade'] <= 4, m)
            self.assertFalse(m['pode_apagar'] or m['pode_renomear'])

    def test_dificuldade(self):
        from app.musicas import dificuldade
        self.assertEqual(dificuldade(0, 60), 0)
        self.assertEqual(dificuldade(120, 60), 3)   # 120 notas por minuto
        self.assertEqual(dificuldade(400, 60), 10)
        self.assertEqual(dificuldade(5000, 60), 10)
        self.assertEqual(dificuldade(0, 0), 0)      # duração zero não divide por zero

    def test_enviar_midi(self):
        m = self.enviar(self.dono)
        self.assertEqual((m['titulo'], m['origem'], m['minha'], m['dificuldade']), ('Minha peça', 'midi', True, 3))
        self.assertEqual(m['dono']['nome'], 'Dono')
        self.assertEqual(self.outro.get(f'/api/musicas/{m["id"]}/midi').content, MIDI)
        r = self.dono.post('/api/musicas/midi', files={'arquivo': ('x.mid', io.BytesIO(b'nada'))},
                           data={'notas': '1', 'duracao': '1'})
        self.assertEqual(r.status_code, 400)

    def test_dono_apaga_a_sua_e_nao_a_dos_outros(self):
        m = self.enviar(self.dono)
        visto_pelo_outro = next(x for x in self.outro.get('/api/musicas').json() if x['id'] == m['id'])
        self.assertFalse(visto_pelo_outro['pode_apagar'])
        self.assertEqual(self.outro.delete(f'/api/musicas/{m["id"]}').status_code, 403)
        self.assertEqual(self.dono.patch(f'/api/musicas/{m["id"]}', json={'titulo': 'x'}).status_code, 403)
        self.assertEqual(self.dono.delete(f'/api/musicas/{m["id"]}').status_code, 200)
        self.assertEqual(self.dono.get(f'/api/musicas/{m["id"]}/midi').status_code, 404)

    def test_admin_renomeia_e_apaga_qualquer_uma(self):
        m = self.enviar(self.dono)
        r = self.admin.patch(f'/api/musicas/{m["id"]}', json={'titulo': '  Nome novo '})
        self.assertEqual((r.status_code, r.json()['titulo']), (200, 'Nome novo'))
        self.assertEqual(self.admin.patch(f'/api/musicas/{m["id"]}', json={'titulo': ' '}).status_code, 400)
        self.assertEqual(self.admin.delete(f'/api/musicas/{m["id"]}').status_code, 200)
        casa = next(x for x in self.admin.get('/api/musicas').json() if x['origem'] == 'casa')
        self.assertTrue(casa['pode_apagar'] and casa['pode_renomear'])
        r = self.admin.patch(f'/api/musicas/{casa["id"]}', json={'titulo': 'Da casa, renomeada'})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.admin.delete('/api/musicas/nao-existe').status_code, 404)


if __name__ == '__main__':
    unittest.main()
