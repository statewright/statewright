from sympy import symbols, Min, Max
from sympy.printing.pycode import pycode

x, y = symbols('x y')
print(f"Min(x, y) -> {pycode(Min(x, y))}")
print(f"Max(x, y) -> {pycode(Max(x, y))}")

assert pycode(Min(x, y)) == 'min(x, y)'
assert pycode(Max(x, y)) == 'max(x, y)'
