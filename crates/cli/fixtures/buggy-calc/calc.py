"""Simple calculator module."""


def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def multiply(a, b):
    return a * b


def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a // b


def percentage(value, total):
    """Calculate what percentage 'value' is of 'total'."""
    if total == 0:
        raise ValueError("Total cannot be zero")
    return (value / total) * 100
