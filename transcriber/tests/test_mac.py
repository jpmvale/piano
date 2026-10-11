"""Fila com o Mac: entrega, sinal de vida, devolução do MIDI e recusa sem token."""
import io
import unittest

from tests.ajuda import cadastrar  # antes do app: prepara o ambiente  # isort: skip

from fastapi.testclient import TestClient

from app import main

AUTH = {'Authorization': 'Bearer segredo'}
MIDI = b'MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk\x00\x00\x00\x04\x00\xff\x2f\x00'


class TesteMac(unittest.TestCase):
    def setUp(self):
        self.c = TestClient(main.app)
        cadastrar(self.c)

    def enviar(self, conteudo: bytes) -> str:
        r = self.c.post('/api/enviar', files={'arquivo': ('Minha música.mp3', io.BytesIO(conteudo))})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()['id']

    def test_sem_token_e_token_errado(self):
        self.assertEqual(self.c.post('/api/mac/proximo').status_code, 401)
        self.assertEqual(self.c.post('/api/mac/proximo', headers={'Authorization': 'Bearer x'}).status_code, 401)

    def test_fluxo_completo(self):
        while self.c.post('/api/mac/proximo', headers=AUTH).status_code == 200:
            pass  # esvazia o que outro teste deixou
        self.assertTrue(self.c.get('/api/health').json()['mac'])

        tid = self.enviar(b'audio de mentira 1')
        t = self.c.post('/api/mac/proximo', headers=AUTH).json()
        self.assertEqual((t['id'], t['tipo'], t['titulo']), (tid, 'arquivo', 'Minha música'))
        self.assertEqual(self.c.get(f'/api/mac/{tid}/audio', headers=AUTH).content, b'audio de mentira 1')

        r = self.c.post(f'/api/mac/{tid}/estado', headers=AUTH,
                        json={'estado': 'transcrevendo', 'duracao': 60, 'estimativa': 30})
        self.assertEqual(r.status_code, 200)
        s = self.c.get(f'/api/importar/{tid}').json()
        self.assertEqual((s['estado'], s['onde'], s['estimativa']), ('transcrevendo', 'mac', 30))

        r = self.c.post(f'/api/mac/{tid}/midi', headers=AUTH, data={'notas': '3'},
                        files={'midi': ('x.mid', io.BytesIO(b'nao sou midi'))})
        self.assertEqual(r.status_code, 400)
        r = self.c.post(f'/api/mac/{tid}/midi', headers=AUTH, data={'notas': '3'},
                        files={'midi': ('x.mid', io.BytesIO(MIDI))})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.c.get(f'/api/importar/{tid}').json()['estado'], 'pronto')
        self.assertEqual(self.c.get(f'/api/importar/{tid}/midi').content, MIDI)
        # Quem enviou ganhou a música, com dono, e só ela vê como sua
        mid = self.c.get(f'/api/importar/{tid}').json()['musica']
        m = next(m for m in self.c.get('/api/musicas').json() if m['id'] == mid)
        self.assertEqual((m['titulo'], m['origem'], m['minha'], m['notas']), ('Minha música', 'audio', True, 3))
        self.assertEqual(self.c.get(f'/api/musicas/{mid}/midi').content, MIDI)
        # Outra pessoa que envia o mesmo áudio recebe o MIDI na hora, como música dela
        outro = TestClient(main.app)
        cadastrar(outro)
        r = outro.post('/api/enviar', files={'arquivo': ('outro nome.mp3', io.BytesIO(b'audio de mentira 1'))})
        self.assertEqual(r.json()['estado'], 'pronto')
        self.assertNotIn(r.json()['musica'], (None, mid))
        # Depois de pronto, a música não é mais do Mac
        self.assertEqual(self.c.post(f'/api/mac/{tid}/estado', headers=AUTH,
                                     json={'estado': 'transcrevendo'}).status_code, 409)

    def test_erro_do_mac_aparece_na_tela(self):
        tid = self.enviar(b'audio de mentira 2')
        while (t := self.c.post('/api/mac/proximo', headers=AUTH).json())['id'] != tid:
            pass
        self.c.post(f'/api/mac/{tid}/erro', headers=AUTH, json={'mensagem': 'Não encontrei notas.'})
        s = self.c.get(f'/api/importar/{tid}').json()
        self.assertEqual((s['estado'], s['erro']), ('erro', 'Não encontrei notas.'))


if __name__ == '__main__':
    unittest.main()
