"""Checkout and validation tests."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from src.checkout import calculate_order
from src.validator import validate_order


def test_simple_order():
    """Basic order without discount."""
    items = [{'name': 'Widget', 'price': 50.00, 'qty': 2}]
    order = calculate_order(items)
    assert order['subtotal'] == 100.00
    assert order['tax'] == 8.00
    assert order['total'] == 108.00


def test_discount_amount():
    """Discount calculation is correct."""
    items = [{'name': 'Widget', 'price': 100.00, 'qty': 1}]
    order = calculate_order(items, 'SAVE10')
    assert order['discount'] == 10.00
    assert order['taxable'] == 90.00


def test_no_discount_validates():
    """Order without discount passes validation."""
    items = [{'name': 'Widget', 'price': 100.00, 'qty': 1}]
    order = calculate_order(items)
    errors = validate_order(order)
    assert errors == [], f"Unexpected errors: {errors}"


def test_discounted_order_validates():
    """Order with SAVE10 discount should pass validation."""
    items = [{'name': 'Widget', 'price': 100.00, 'qty': 1}]
    order = calculate_order(items, 'SAVE10')
    errors = validate_order(order, 'SAVE10')
    assert errors == [], f"Validation errors: {errors}"


def test_vip_discount_validates():
    """Order with VIP discount should pass validation."""
    items = [{'name': 'Gadget', 'price': 200.00, 'qty': 1}]
    order = calculate_order(items, 'VIP')
    errors = validate_order(order, 'VIP')
    assert errors == [], f"Validation errors: {errors}"


def test_multi_item_discounted():
    """Multi-item order with discount should validate."""
    items = [
        {'name': 'Widget', 'price': 25.00, 'qty': 3},
        {'name': 'Gadget', 'price': 50.00, 'qty': 1},
    ]
    order = calculate_order(items, 'SAVE20')
    errors = validate_order(order, 'SAVE20')
    assert errors == [], f"Validation errors: {errors}"
