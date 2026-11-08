import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("effect_label", Path(__file__).with_name("local-effect-label.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EffectLabelTests(unittest.TestCase):
    def test_typed_labels_and_unknown_are_distinct(self):
        self.assertEqual(module.decode('{"effects":[],"unresolved":false}'), 0)
        self.assertEqual(module.decode('{"effects":["read","write"],"unresolved":false}'), 3)
        self.assertEqual(module.decode('{"effects":["destroy"],"unresolved":false}'), 4)
        self.assertIsNone(module.decode('{"effects":[],"unresolved":true}'))

    def test_missing_ambiguous_or_generated_explanations_fail_closed(self):
        for value in ['{}', '{"effects":["read","read"],"unresolved":false}',
                      '{"effects":["read"],"unresolved":true}',
                      '{"effects":["read"],"unresolved":0}',
                      '{"effects":["external"],"unresolved":false}',
                      '{"effects":[],"unresolved":false,"unresolved":true}',
                      '{"effects":[],"unresolved":false,"reason":"trust me"}',
                      '```json\n{"effects":[],"unresolved":false}\n```']:
            with self.assertRaises(ValueError):
                module.decode(value)


if __name__ == "__main__":
    unittest.main()
