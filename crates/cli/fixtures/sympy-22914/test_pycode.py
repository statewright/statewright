"""Test that PythonCodePrinter handles Min and Max."""
import os

def test_min_max_in_known_functions():
    """The _known_functions dict must include Min and Max mappings."""
    fixture_dir = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(fixture_dir, "pycode.py")) as f:
        source = f.read()

    # The _known_functions dict should contain Min and Max
    assert "'Min': 'min'" in source or '"Min": "min"' in source, \
        "_known_functions must map 'Min' to 'min'"
    assert "'Max': 'max'" in source or '"Max": "max"' in source, \
        "_known_functions must map 'Max' to 'max'"
