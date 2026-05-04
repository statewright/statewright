from sympy import symbols
from sympy.polys.monomials import itermonomials

x, y = symbols('x y')
result = set(itermonomials([x, y], 3, 3))
print(f"Result: {result}")
expected = {x**3, x**2*y, x*y**2, y**3}
if result == expected:
    print("Success")
else:
    print(f"Failure: Expected {expected}, got {result}")
