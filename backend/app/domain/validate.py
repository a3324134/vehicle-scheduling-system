"""Checks that reject a service before it is saved."""

from collections.abc import Mapping, Sequence

from app.domain.models import FieldError, Stop
from app.domain.params import DAY_SECONDS, MIN_DWELL_SECONDS
from app.domain.timefmt import format_hms
from app.domain.timeline import compute_arrivals
from app.domain.track import YARD, find_segment


def validate_stops(stops: Sequence[Stop], block_times: Mapping[str, int]) -> list[FieldError]:
    errors = _check_structure(stops)
    if errors:
        # Times can't be computed for a path that doesn't exist.
        return errors
    return _check_times(stops, block_times)


def _check_structure(stops: Sequence[Stop]) -> list[FieldError]:
    if len(stops) < 2:
        return [FieldError(("stops",), "A service needs at least two stops", "too_few_stops")]

    errors = []
    last = len(stops) - 1
    for i in range(1, last):
        if stops[i].at == YARD:
            errors.append(FieldError(("stops", i, "at"), "Y can only be the first or last stop", "yard_in_middle"))
    for i in range(last):
        if find_segment(stops[i].at, stops[i + 1].at) is None:
            errors.append(
                FieldError(
                    ("stops", i + 1, "at"),
                    f"No direct route from {stops[i].at} to {stops[i + 1].at}",
                    "invalid_segment",
                )
            )
    for i in range(last):
        if stops[i].departure is None:
            errors.append(FieldError(("stops", i, "departure"), "Departure time is required", "missing_departure"))
    if stops[last].departure is not None:
        errors.append(
            FieldError(("stops", last, "departure"), "The last stop has no departure time", "unexpected_departure")
        )
    return errors


def _check_times(stops: Sequence[Stop], block_times: Mapping[str, int]) -> list[FieldError]:
    errors = []
    arrivals = compute_arrivals(stops, block_times)
    last = len(stops) - 1
    for i in range(1, last):
        earliest = arrivals[i] + MIN_DWELL_SECONDS
        if stops[i].departure < earliest:
            errors.append(
                FieldError(
                    ("stops", i, "departure"),
                    f"Departure must be {format_hms(earliest)} or later",
                    "dwell_too_short",
                )
            )
    for i in range(1, last + 1):
        if arrivals[i] >= DAY_SECONDS:
            # Point at the departure that causes the late arrival.
            errors.append(
                FieldError(
                    ("stops", i - 1, "departure"),
                    f"Arrival at {stops[i].at} would be {format_hms(arrivals[i])}, past midnight",
                    "past_midnight",
                )
            )
    return errors
