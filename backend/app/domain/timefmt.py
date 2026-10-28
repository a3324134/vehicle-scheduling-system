"""Conversions between clock times and seconds since midnight.

Calculations use plain seconds. Computed arrivals can pass midnight after a
block time change, so formatted hours may be 24 or more.
"""

from datetime import time


def time_to_seconds(value: time) -> int:
    return value.hour * 3600 + value.minute * 60 + value.second


def seconds_to_time(seconds: int) -> time:
    """Only for values inside one day, e.g. departures stored in the database."""
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return time(hours, minutes, secs)


def parse_hms(text: str) -> int:
    hours, minutes, secs = (int(part) for part in text.split(":"))
    return hours * 3600 + minutes * 60 + secs


def format_hms(seconds: int) -> str:
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"
