"""Converting between seconds since midnight and "HH:MM:SS"."""

import pytest

from app.domain.timefmt import format_hms, parse_hms


@pytest.mark.parametrize("seconds, text", [(28800, "08:00:00"), (86620, "24:03:40"), (0, "00:00:00")])
def test_converts_between_seconds_and_text(seconds, text):
    assert format_hms(seconds) == text
    assert parse_hms(text) == seconds
