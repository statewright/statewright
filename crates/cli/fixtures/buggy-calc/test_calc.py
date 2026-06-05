"""Tests for the calculator module."""
import pytest
from calc import add, subtract, multiply, divide, percentage


def test_add():
    assert add(2, 3) == 5
    assert add(-1, 1) == 0
    assert add(0, 0) == 0


def test_subtract():
    assert subtract(5, 3) == 2
    assert subtract(0, 5) == -5


def test_multiply():
    assert multiply(3, 4) == 12
    assert multiply(-2, 3) == -6
    assert multiply(0, 100) == 0


def test_divide():
    assert divide(10, 3) == pytest.approx(3.333333, rel=1e-4)
    assert divide(1, 4) == 0.25
    assert divide(7, 2) == 3.5


def test_divide_by_zero():
    with pytest.raises(ValueError, match="Cannot divide by zero"):
        divide(1, 0)


def test_percentage():
    assert percentage(25, 100) == 25.0
    assert percentage(1, 3) == pytest.approx(33.333333, rel=1e-4)


def test_percentage_zero_total():
    with pytest.raises(ValueError, match="Total cannot be zero"):
        percentage(5, 0)
