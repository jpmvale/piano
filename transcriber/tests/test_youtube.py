import unittest

from app.youtube import id_do_video, id_valido


class TesteLinks(unittest.TestCase):
    def test_formatos_aceitos(self):
        for link in [
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
            'https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ',
            'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
            'https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
            'https://youtu.be/dQw4w9WgXcQ',
            'https://youtu.be/dQw4w9WgXcQ?si=abc',
            'youtu.be/dQw4w9WgXcQ',
            '  www.youtube.com/watch?v=dQw4w9WgXcQ  ',
            'https://www.youtube.com/shorts/dQw4w9WgXcQ',
            'https://www.youtube.com/embed/dQw4w9WgXcQ',
        ]:
            self.assertEqual(id_do_video(link), 'dQw4w9WgXcQ', link)

    def test_recusados(self):
        for link in [
            '', 'dQw4w9WgXcQ', 'https://vimeo.com/123456',
            'https://www.youtube.com/watch?v=curto',
            'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
            'https://evil.com/?u=https://youtu.be/dQw4w9WgXcQ',
            'https://www.youtube.com/channel/UC123',
        ]:
            self.assertIsNone(id_do_video(link), link)

    def test_id_valido(self):
        self.assertTrue(id_valido('dQw4w9WgXcQ'))
        self.assertFalse(id_valido('../../etc/x'))
        self.assertFalse(id_valido('..'))


if __name__ == '__main__':
    unittest.main()
