# PythonCodePrinter doesn't support Min and Max

`pycode(Min(x, y))` raises an error because `PythonCodePrinter` doesn't have `Min` or `Max` in its `_known_functions` dict.

Python's built-in `min()` and `max()` are the correct targets for these functions.

## Reproduction

```python
from sympy import symbols, Min, Max
from sympy.printing.pycode import pycode

x, y = symbols('x y')
print(pycode(Min(x, y)))  # Should print "min(x, y)" but raises error
print(pycode(Max(x, y)))  # Should print "max(x, y)" but raises error
```
