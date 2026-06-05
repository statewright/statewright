# EncodedFile.mode includes 'b' but the stream is text mode

`_pytest.capture.EncodedFile` wraps stdout for capturing. Its `mode` attribute falls through `__getattr__` to the underlying binary buffer, returning `'rb+'`.

But `EncodedFile.write()` only accepts `str`, not bytes. Third-party libraries check `sys.stdout.mode` for `'b'` to decide whether to write bytes or text — they see `'rb+'`, write bytes, and get a TypeError.

The `mode` property should strip `'b'` from the buffer's mode string.

## Reproduction

```python
# Inside a pytest test:
def test_mode(capfd):
    import sys
    assert "b" not in sys.stdout.mode  # FAILS — mode is 'rb+'
```
