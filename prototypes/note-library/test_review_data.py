import tempfile
import unittest
from pathlib import Path

from review_data import check_jpeg, local_media, select_candidates


class ReviewDataTest(unittest.TestCase):
    def test_rejects_truncated_decoder_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'preview.jpg'
            path.write_bytes(b'\xff\xd8\xff' + b'header only')
            with self.assertRaises(ValueError):
                check_jpeg(path)

    def test_candidates_require_old_like_evidence(self):
        old = [{'id': 'a', 'source_relations': ['点赞']},
               {'id': 'b', 'source_relations': ['收藏']},
               {'id': 'c', 'source_relations': ['点赞', '收藏']},
               {'id': 'd', 'source_relations': ['点赞']}]
        liked = [{'note_id': 'd', 'interact_info.liked': True},
                 {'note_id': 'e', 'interact_info.liked': False},
                 {'note_id': 'f'}]
        missing, conflicts, excluded = select_candidates(old, liked)
        self.assertEqual(missing, {'a', 'c'})
        self.assertEqual(conflicts, {'e'})
        self.assertEqual(excluded, {'b'})

    def test_media_paths_must_resolve_inside_note(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / '笔记' / 'a' / 'media'
            media.mkdir(parents=True)
            (media / 'image.jpg').write_bytes(b'image')
            entry = {'id': 'image-1', 'kind': 'image', 'path': 'media/image.jpg'}
            self.assertEqual(local_media(root, 'a', entry)['url'], '/media/a/image.jpg')
            for path in ('../outside.jpg', '/tmp/outside.jpg', 'media/../image.jpg'):
                with self.assertRaises(ValueError):
                    local_media(root, 'a', {**entry, 'path': path})
            (media / 'link.jpg').symlink_to(media / 'image.jpg')
            with self.assertRaises(ValueError):
                local_media(root, 'a', {**entry, 'path': 'media/link.jpg'})


if __name__ == '__main__':
    unittest.main()
