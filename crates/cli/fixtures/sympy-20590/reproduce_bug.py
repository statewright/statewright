from sympy import Symbol

def test_symbol_immutability():
    x = Symbol('x')
    try:
        x.foo = 1
        print("Bug reproduced: Symbol allows setting arbitrary attributes")
    except AttributeError:
        print("Symbol is immutable as expected")

if __name__ == "__main__":
    test_symbol_immutability()