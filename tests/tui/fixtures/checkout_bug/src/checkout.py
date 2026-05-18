"""Order calculation logic."""

from src.config import PRICE_PRECISION, TAX_RATE, DISCOUNT_CODES


def calculate_order(items, discount_code=None):
    """Calculate order totals with optional discount code."""
    subtotal = sum(item['price'] * item['qty'] for item in items)

    discount = 0
    if discount_code and discount_code in DISCOUNT_CODES:
        discount = subtotal * DISCOUNT_CODES[discount_code] / 100

    taxable = subtotal - discount
    tax = taxable * TAX_RATE
    total = taxable + tax

    return {
        'subtotal': round(subtotal, PRICE_PRECISION),
        'discount': round(discount, PRICE_PRECISION),
        'taxable': round(taxable, PRICE_PRECISION),
        'tax': round(tax, PRICE_PRECISION),
        'total': round(total, PRICE_PRECISION),
    }
