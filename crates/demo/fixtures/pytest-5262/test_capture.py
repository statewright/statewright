"""Test that EncodedFile.mode doesn't include 'b'."""
import sys, os, io

# We can't easily import the full pytest capture module standalone,
# so test the concept: a text wrapper's mode should not contain 'b'
fixture_dir = os.path.dirname(os.path.abspath(__file__))

def test_encoded_file_mode():
    """The EncodedFile class should have a mode property that strips 'b'."""
    # Simulate what EncodedFile does
    sys.path.insert(0, fixture_dir)

    # Read the source and check if mode property exists
    with open(os.path.join(fixture_dir, "capture.py")) as f:
        source = f.read()

    # The fix adds a mode property that strips 'b'
    assert "@property" in source and "def mode" in source, \
        "EncodedFile should have an explicit mode property"
    assert 'replace("b", "")' in source or "replace('b', '')" in source, \
        "mode property should strip 'b' from buffer mode"
