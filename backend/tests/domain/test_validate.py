"""Checks before a service is saved: its path and its times."""

import pytest

from app.domain.models import FieldError, Stop
from app.domain.params import MIN_DWELL_SECONDS
from app.domain.timefmt import format_hms
from app.domain.timeline import compute_arrivals, compute_service
from app.domain.track import SEGMENTS
from app.domain.validate import validate_stops
from tests.helpers import BLOCK_TIMES, LAP, route, stops, svc, t


def types(errors: list[FieldError]) -> list[str]:
    return [e.type for e in errors]


# --- 1. Paths ---------------------------------------------------------------


@pytest.mark.parametrize("segment", SEGMENTS, ids=lambda s: f"{s.start}-{s.end}")
def test_accepts_every_segment_as_a_service(segment):
    service = svc(1, "V1", f"{segment.start} 08:00:00", segment.end)
    assert validate_stops(service.stops, BLOCK_TIMES) == []
    assert compute_service(service, BLOCK_TIMES).path == (segment.start, *segment.blocks, segment.end)


def test_computes_the_path_from_p2b_to_p1a_through_b12_and_b13():
    service = svc(1, "V1", "P2B 08:00:00", "P1A")
    assert compute_service(service, BLOCK_TIMES).path == ("P2B", "B12", "B13", "P1A")


def test_computes_the_full_path_from_the_stations():
    service = svc(1, "V1", "Y 08:00:00", "P1A 08:02:00", "P2A")
    assert validate_stops(service.stops, BLOCK_TIMES) == []
    assert compute_service(service, BLOCK_TIMES).path == ("Y", "B1", "P1A", "B3", "B5", "P2A")


@pytest.mark.parametrize(
    "first, second",
    [
        ("P1A", "P1A"),  # turning back inside B1
        ("Y", "Y"),  # no line from the yard to itself
        ("P2A", "P1A"),  # wrong direction
        ("P1A", "P3A"),  # skipping a station
    ],
)
def test_rejects_stations_with_no_line_between_them(first, second):
    errors = validate_stops(stops(f"{first} 08:00:00", second), BLOCK_TIMES)
    assert errors == [FieldError(("stops", 1, "at"), f"No direct route from {first} to {second}", "invalid_segment")]


def test_accepts_turning_back_at_a_platform():
    assert validate_stops(stops("Y 08:00:00", "P1A 08:02:00", "Y"), BLOCK_TIMES) == []


def test_rejects_the_yard_in_the_middle_of_a_service():
    errors = validate_stops(stops("P1A 08:00:00", "Y 08:05:00", "P1B"), BLOCK_TIMES)
    assert types(errors) == ["yard_in_middle"]
    assert errors[0].loc == ("stops", 1, "at")


@pytest.mark.parametrize("given", [stops("Y 08:00:00"), ()])
def test_rejects_fewer_than_two_stops(given):
    assert types(validate_stops(given, BLOCK_TIMES)) == ["too_few_stops"]


def test_computes_both_arrivals_at_a_platform_visited_twice():
    service = route(1, "V1", ["Y", "P1A", *LAP, "Y"], start="08:00:00")
    assert validate_stops(service.stops, BLOCK_TIMES) == []
    arrivals = compute_arrivals(service.stops, BLOCK_TIMES)
    assert service.stops[1].at == service.stops[5].at == "P1A"
    assert arrivals[1] == t("08:01:00")
    assert arrivals[5] == t("08:13:00")


# --- 2. Times ---------------------------------------------------------------


def test_computes_arrivals_from_departures_and_block_times():
    arrivals = compute_arrivals(stops("Y 08:00:00", "P1A 08:02:00", "P2A"), BLOCK_TIMES)
    assert arrivals == (None, t("08:01:00"), t("08:04:00"))


def test_computes_arrivals_with_each_blocks_own_time():
    block_times = {**BLOCK_TIMES, "B5": 90}
    arrivals = compute_arrivals(stops("Y 08:00:00", "P1A 08:02:00", "P2A"), block_times)
    assert arrivals[2] == t("08:04:30")


# At P1A from 08:01:00; the shortest dwell is MIN_DWELL_SECONDS (1 second).
EARLIEST = t("08:01:00") + MIN_DWELL_SECONDS


def test_rejects_a_dwell_one_second_short_of_the_shortest():
    errors = validate_stops(stops("Y 08:00:00", f"P1A {format_hms(EARLIEST - 1)}", "P2A"), BLOCK_TIMES)
    message = f"Departure must be {format_hms(EARLIEST)} or later"
    assert errors == [FieldError(("stops", 1, "departure"), message, "dwell_too_short")]


def test_accepts_the_shortest_dwell():
    assert validate_stops(stops("Y 08:00:00", f"P1A {format_hms(EARLIEST)}", "P2A"), BLOCK_TIMES) == []


def test_computes_no_arrival_for_the_first_stop_and_no_departure_for_the_last():
    computed = compute_service(svc(1, "V1", "Y 08:00:00", "P1A 08:02:00", "P2A"), BLOCK_TIMES)
    assert computed.arrivals[0] is None
    assert computed.stops[-1].departure is None


def test_rejects_arriving_exactly_at_midnight():
    errors = validate_stops(stops("P1A 23:58:00", "P2A"), BLOCK_TIMES)
    assert types(errors) == ["past_midnight"]
    assert errors[0].loc == ("stops", 0, "departure")


def test_accepts_arriving_one_second_before_midnight():
    assert validate_stops(stops("P1A 23:57:59", "P2A"), BLOCK_TIMES) == []


def test_rejects_a_departure_at_the_last_stop():
    errors = validate_stops(stops("Y 08:00:00", "P1A 08:02:00", "P2A 08:10:00"), BLOCK_TIMES)
    assert errors == [FieldError(("stops", 2, "departure"), "The last stop has no departure time", "unexpected_departure")]


@pytest.mark.parametrize(
    "given, index",
    [
        ((Stop("Y"), Stop("P1A", t("08:02:00")), Stop("P2A")), 0),
        ((Stop("Y", t("08:00:00")), Stop("P1A"), Stop("P2A")), 1),
    ],
)
def test_rejects_a_missing_departure(given, index):
    errors = validate_stops(given, BLOCK_TIMES)
    assert errors == [FieldError(("stops", index, "departure"), "Departure time is required", "missing_departure")]
