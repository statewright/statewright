import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("judgment", Path(__file__).with_name("local-judgment.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeAgent:
    cfg = {"max_len": 512, "head_max_len": 192}

    @staticmethod
    def _to_internal(value):
        return value

    @staticmethod
    def tok(value, **kwargs):
        return {"input_ids": list(range(len(value.split())))}


class DiagnosticTests(unittest.TestCase):
    def test_frozen_question_profiles_are_explicit_and_missing_profile_fails(self):
        corpus = {"questions": {"command": {"old": {}}}, "question_profiles": {"focused": {"new": {}}}}
        self.assertEqual(module.case_questions(corpus, {"task": "command"}), {"old": {}})
        self.assertEqual(module.case_questions(corpus, {"task": "command", "question_profile": "focused"}), {"new": {}})
        with self.assertRaises(ValueError):
            module.case_questions(corpus, {"task": "command", "question_profile": "missing"})

    def test_captured_input_hash_binds_parsed_bytes_not_later_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "input.json"
            module.emit(path, {"case": "original"})
            parsed, before = module.capture_input(path)
            path.write_text('{"case":"replacement"}')
            self.assertEqual(parsed, {"case": "original"})
            self.assertNotEqual(before, module.digest(path))
            path.write_bytes(b" " * (1024 * 1024 + 1))
            with self.assertRaises(ValueError):
                module.capture_input(path)

    def test_complete_and_truncated_tokens(self):
        def same(*args):
            return [1, 2], []

        def cut(tok, state, question, max_len, head_max_len):
            return ([1] if max_len == 512 else [1, 2]), []

        options = lambda question: ["yes", "no"]
        self.assertFalse(module.token_evidence(FakeAgent(), {}, {"q": {}}, same, options)[0])
        self.assertTrue(module.token_evidence(FakeAgent(), {}, {"q": {}}, cut, options)[0])
        self.assertTrue(module.token_evidence(FakeAgent(), {}, {"q": {}}, same,
                                            lambda question: ["word " * 49])[0])

    def test_equal_length_token_replacement_is_not_complete(self):
        def changed(tok, state, question, max_len, head_max_len):
            return ([1, 3] if max_len == 512 else [1, 2]), []
        self.assertTrue(module.token_evidence(FakeAgent(), {}, {"q": {}}, changed,
                                            lambda question: ["yes"])[0])

    def test_receipts_are_exclusive_and_hashes_are_order_independent(self):
        self.assertEqual(module.json_hash({"a": 1, "b": 2}), module.json_hash({"b": 2, "a": 1}))
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "receipt.json"
            module.emit(path, {"observed": True})
            initial = module.digest(path)
            with self.assertRaises(FileExistsError):
                module.emit(path, {"observed": False})
            self.assertEqual(initial, module.digest(path))


if __name__ == "__main__":
    unittest.main()
