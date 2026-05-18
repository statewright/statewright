"""Order validation before payment processing."""

from src.config import TAX_RATE, DISCOUNT_CODES


def validate_order(order, discount_code=None):
    """Validate a calculated order for correctness before charging.

    Returns a list of error strings. Empty list means valid.
    """
    errors = []

    if order.get('total', 0) <= 0:
        errors.append('Total must be positive')

    if discount_code and discount_code not in DISCOUNT_CODES:
        errors.append(f'Invalid discount code: {discount_code}')

    if order.get('discount', 0) > order.get('subtotal', 0):
        errors.append('Discount exceeds subtotal')

    # Verify tax matches expected rate
    expected_tax = round(order['subtotal'] * TAX_RATE, 2)
    actual_tax = order.get('tax', 0)
    if abs(actual_tax - expected_tax) > 0.01:
        errors.append(
            f'Tax calculation error: expected {expected_tax}, got {actual_tax}'
        )

    return errors
