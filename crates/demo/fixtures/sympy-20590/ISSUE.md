# Symbol instances have __dict__ when they shouldn't

Since SymPy 1.7, `Symbol` instances have a `__dict__` attribute. This breaks immutability — you can set arbitrary attributes on Symbols:

```python
from sympy import Symbol
x = Symbol('x')
x.foo = 1  # Should raise AttributeError but doesn't
```

The cause: the `Printable` mixin class in `_print_helpers.py` doesn't define `__slots__ = ()`. When a class without `__slots__` is in the MRO, Python gives instances a `__dict__` even if every other class uses `__slots__`.
