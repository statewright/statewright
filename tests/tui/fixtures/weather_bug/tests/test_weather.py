"""Weather classification tests."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from src.converter import celsius_to_fahrenheit, fahrenheit_to_celsius
from src.weather import classify, daily_summary


def test_boiling_is_hot():
    """212F = 100C -> Hot"""
    assert classify(212) == "Hot"


def test_freezing_point_is_cold():
    """32F = 0C -> Cold"""
    assert classify(32) == "Cold"


def test_room_temp_is_warm():
    """72F = 22.2C -> Warm"""
    assert classify(72) == "Warm"


def test_cool_morning():
    """50F = 10C -> Cool"""
    assert classify(50) == "Cool"


def test_portland_week():
    """Mid-40s to low-50s F should all be Cool."""
    result = daily_summary("Portland", [45, 52, 48, 47, 51])
    assert result["dominant"] == "Cool"


def test_roundtrip_conversion():
    """C -> F -> C should return the original value."""
    for c in [-40, 0, 20, 37, 100]:
        result = fahrenheit_to_celsius(celsius_to_fahrenheit(c))
        assert abs(result - c) < 0.01, f"Roundtrip failed for {c}C: got {result}"
