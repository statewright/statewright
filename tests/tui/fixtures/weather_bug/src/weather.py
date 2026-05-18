"""Weather classification from temperature readings."""

from src.converter import fahrenheit_to_celsius

# Celsius thresholds for weather categories
THRESHOLDS = [
    ("Hot", 35),
    ("Warm", 20),
    ("Cool", 10),
    ("Cold", 0),
]


def classify(temp_f):
    """Classify a Fahrenheit temperature into a weather category."""
    temp_c = fahrenheit_to_celsius(temp_f)
    for label, minimum in THRESHOLDS:
        if temp_c >= minimum:
            return label
    return "Freezing"


def daily_summary(city, highs_f):
    """Generate a daily weather summary from Fahrenheit high temps."""
    labels = [classify(t) for t in highs_f]
    avg = sum(highs_f) / len(highs_f)
    return {
        "city": city,
        "avg_high_f": round(avg, 1),
        "conditions": labels,
        "dominant": max(set(labels), key=labels.count),
    }
