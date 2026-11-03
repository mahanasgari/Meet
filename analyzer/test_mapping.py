import unittest

import mapping as m


class Mapping(unittest.TestCase):
    def test_class_column(self):
        self.assertEqual(m.class_column(["non_sad", "sad"], "sad"), 1)
        self.assertEqual(m.class_column(["happy", "non_happy"], "happy"), 0)
        self.assertEqual(m.class_column(["instrumental", "voice"], "instrumental"), 0)
        with self.assertRaises(ValueError):
            m.class_column(["a", "b"], "c")

    def test_mean_column_clamps(self):
        self.assertAlmostEqual(m.mean_column([[0.2, 0.8], [0.4, 0.6]], 1), 0.7)
        self.assertEqual(m.mean_column([[1.5]], 0), 1.0)
        with self.assertRaises(ValueError):
            m.mean_column([], 0)

    def test_scale_emo(self):
        self.assertEqual(m.scale_emo(1), 0.0)
        self.assertEqual(m.scale_emo(9), 1.0)
        self.assertAlmostEqual(m.scale_emo(5), 0.5)
        self.assertEqual(m.scale_emo(12), 1.0)
        self.assertEqual(m.scale_emo(float("nan")), 0.0)

    def test_energy_mapping(self):
        self.assertEqual(m.energy_from_db(-60), 0.0)
        self.assertEqual(m.energy_from_db(-5), 1.0)
        self.assertAlmostEqual(m.energy_from_db(-18), 0.5)
        self.assertAlmostEqual(m.energy(-6, 0.0), 0.35)
        self.assertEqual(m.energy(-18), 0.5)
        self.assertAlmostEqual(m.rms_dbfs(0.1), -20.0)
        self.assertLess(m.rms_dbfs(0), -100)

    def test_top_genres(self):
        out = m.top_genres([0.05, 0.5, 0.3, 0.2, 0.15], list("abcde"), k=3, min_p=0.1)
        self.assertEqual([g["name"] for g in out], ["b", "c", "d"])
        self.assertEqual(m.top_genres([0.05, 0.02], ["a", "b"]), [])

    def test_key_and_window(self):
        self.assertEqual(m.normalize_key("F#"), "F#")
        self.assertIsNone(m.normalize_key("H"))
        self.assertEqual(m.middle_window(100, 10, 90), (0, 100))
        self.assertEqual(m.middle_window(1000, 10, 40), (300, 700))


if __name__ == "__main__":
    unittest.main()
