# itermonomials returns incomplete results when min_degrees is specified

When calling `itermonomials` with an integer `min_degrees`, mixed-degree monomials are missing from the output.

## Reproduction

```python
from sympy import symbols
from sympy.polys.monomials import itermonomials

x, y = symbols('x y')
result = set(itermonomials([x, y], 3, 3))
print(result)
```

**Actual output:** `{x**3, y**3}`

**Expected output:** `{x**3, x**2*y, x*y**2, y**3}`

All degree-3 monomials should be returned, including mixed terms like `x**2*y` (which has total degree 2+1=3).

The `min_degrees` parameter should filter by total degree (sum of all exponents), but it appears to be filtering by the maximum exponent of any single variable instead.
