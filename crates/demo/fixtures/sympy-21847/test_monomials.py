"""SWE-bench sympy__sympy-21847: itermonomials min_degrees bug.

itermonomials should return all monomials where:
  min_degree <= total_degree(monom) <= max_degree

Total degree = sum of all exponents (x^2*y has total degree 3).

Bug: uses max(exponents) >= min_degree instead of sum(exponents) >= min_degree,
so it only returns monomials where a single variable has exponent >= min_degree,
missing mixed terms like x^2*y.
"""
import importlib
import sys
import os
import pytest

# Import monomials from the LOCAL buggy file, not the installed sympy
fixture_dir = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("local_monomials", os.path.join(fixture_dir, "monomials.py"))
local_monomials = importlib.util.module_from_spec(spec)
sys.modules["local_monomials"] = local_monomials  # needed for @public decorator
spec.loader.exec_module(local_monomials)
itermonomials = local_monomials.itermonomials

from sympy import symbols


def test_itermonomials_degree_3():
    """All degree-3 monomials in x,y should include mixed terms like x^2*y."""
    x, y = symbols('x y')
    result = set(itermonomials([x, y], 3, 3))
    expected = {x**3, x**2*y, x*y**2, y**3}
    assert result == expected, f"Expected {expected}, got {result}"


def test_itermonomials_degree_2_to_3():
    """Monomials with total degree between 2 and 3."""
    x, y = symbols('x y')
    result = set(itermonomials([x, y], 3, 2))
    expected = {x**2, x*y, y**2, x**3, x**2*y, x*y**2, y**3}
    assert result == expected, f"Expected {expected}, got {result}"
