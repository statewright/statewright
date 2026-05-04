"""Test that Printable mixin has __slots__ for immutability."""
import sys, os, importlib

fixture_dir = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("local_print_helpers", os.path.join(fixture_dir, "_print_helpers.py"))
local_mod = importlib.util.module_from_spec(spec)
sys.modules["local_print_helpers"] = local_mod
spec.loader.exec_module(local_mod)

def test_printable_has_slots():
    assert hasattr(local_mod.Printable, '__slots__'), "Printable must define __slots__"

def test_symbol_no_dict():
    from sympy import Symbol
    x = Symbol('x')
    assert not hasattr(x, '__dict__'), "Symbol instances should not have __dict__"
