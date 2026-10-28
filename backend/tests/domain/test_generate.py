"""Generating a schedule (Bonus 3)."""

import pytest

from app.domain.conflicts import detect_conflicts
from app.domain.generate import (
    GenerationFailed,
    WaitGap,
    generate,
    routes_by_speed,
    shortest_interval,
    wait_gaps,
)
from app.domain.models import Service
from app.domain.params import GENERATED_DWELL_SECONDS
from app.domain.timeline import compute_arrivals
from app.domain.track import YARD
from tests.helpers import BLOCK_TIMES, svc, t

FLEET = ("V1", "V2", "V3", "V4", "V5")
DAY = (t("08:00:00"), t("18:00:00"))
# The numbers in these tests are worked out with 10-second stops, so they hold
# whatever GENERATED_DWELL_SECONDS is. Only
# test_generates_the_default_dwell_at_every_stop checks the default.
DWELL = 10


def numbered(generated) -> list[Service]:
    return [Service(i + 1, vehicle, stops) for i, (vehicle, stops) in enumerate(generated.services)]


def test_generates_a_full_day_with_no_conflicts_or_long_waits():
    generated = generate(6 * 60, *DAY, BLOCK_TIMES, FLEET, dwell=DWELL)
    services = numbered(generated)
    assert detect_conflicts(services, BLOCK_TIMES) == []
    assert wait_gaps(services, BLOCK_TIMES, *DAY, 6 * 60) == []


def test_generates_trips_from_the_yard_within_the_range_and_back():
    services = numbered(generate(6 * 60, *DAY, BLOCK_TIMES, FLEET, dwell=DWELL))
    leaves = sorted(s.stops[0].departure for s in services)
    assert leaves[0] == t("08:00:00")
    assert leaves[-1] <= t("18:00:00")
    assert all(s.stops[0].at == YARD and s.stops[-1].at == YARD for s in services)


def test_generates_the_default_dwell_at_every_stop():
    # Without a dwell given, as the API calls it; at the shortest interval, so
    # this holds for any default.
    minutes, _ = shortest_interval(*DAY, BLOCK_TIMES, FLEET)
    for service in numbered(generate(minutes * 60, *DAY, BLOCK_TIMES, FLEET)):
        arrivals = compute_arrivals(service.stops, BLOCK_TIMES)
        for i in range(1, len(service.stops) - 2):  # stops passengers can board
            assert service.stops[i].departure - arrivals[i] == GENERATED_DWELL_SECONDS


def test_generates_vehicles_running_closer_than_the_interval():
    # A lap is 8 min 40 s (8 blocks, 4 stops of 10 s) and 2 vehicles cover a
    # 6-minute interval: one every 4 min 20 s.
    assert generate(6 * 60, *DAY, BLOCK_TIMES, FLEET, dwell=DWELL).gap == (260, 260)


def test_generates_vehicles_taking_turns_to_charge():
    services = numbered(generate(6 * 60, *DAY, BLOCK_TIMES, FLEET, dwell=DWELL))
    trips_per_vehicle = {v: sum(1 for s in services if s.vehicle == v) for v in FLEET}
    # Two vehicles run at once, but no vehicle runs all day.
    assert max(trips_per_vehicle.values()) > 1
    assert len(services) > 2


def test_computes_the_shortest_interval_and_why_one_minute_less_fails():
    # Default block times: 5 min 20 s from the yard to P3A, and no vehicle
    # leaves the yard before the start, so the spec's own example of 5
    # minutes is not possible.
    minutes, reason = shortest_interval(*DAY, BLOCK_TIMES, FLEET, dwell=DWELL)
    assert minutes == 6
    assert reason == "A vehicle needs 5 min 20 s to get from the yard to P3A, the farthest station"


def test_generates_the_loop_through_the_quicker_platform():
    assert routes_by_speed(BLOCK_TIMES)[0].lap == ("P1A", "P2A", "P3A", "P2B", "P1A")
    slow_b13 = {**BLOCK_TIMES, "B13": 90}
    generated = generate(8 * 60, *DAY, slow_b13, FLEET, dwell=DWELL)
    assert generated.route.lap == ("P1B", "P2A", "P3A", "P2B", "P1B")
    assert detect_conflicts(numbered(generated), slow_b13) == []


def test_generates_swaps_even_with_a_slow_side_at_s1():
    # The other S1 platform's blocks are three times slower; vehicles still
    # swap without conflicts.
    slow_side = {**BLOCK_TIMES, "B4": 180, "B14": 180}
    minutes, _ = shortest_interval(*DAY, slow_side, FLEET, dwell=DWELL)
    assert minutes is not None
    generated = generate(minutes * 60, *DAY, slow_side, FLEET, dwell=DWELL)
    assert detect_conflicts(numbered(generated), slow_side) == []


def test_fails_with_too_few_vehicles_for_the_interval():
    with pytest.raises(GenerationFailed, match="2 vehicles must run at once; the fleet has 1"):
        generate(6 * 60, *DAY, BLOCK_TIMES, ("V1",), dwell=DWELL)


def test_fails_when_an_interlocking_group_is_too_busy():
    # A lap of 14 min needs 2 vehicles for 9 minutes, 7 min apart; each needs
    # 220 + 10 + 220 s = 7 min 30 s around S1 (B13 in, B3 out).
    slow = {**BLOCK_TIMES, "B3": 220, "B4": 220, "B13": 220, "B14": 220}
    with pytest.raises(GenerationFailed, match="needs 7 min 30 s in interlocking group B3/B4/B13/B14 at P1A"):
        generate(9 * 60, *DAY, slow, FLEET, dwell=DWELL)


def test_fails_when_the_last_vehicles_would_be_back_after_midnight():
    minutes, reason = shortest_interval(t("22:00:00"), t("23:50:00"), BLOCK_TIMES, FLEET, dwell=DWELL)
    assert minutes is None
    assert reason == "The last vehicles would get back to the yard after midnight"


# --- the passenger wait rule on its own ---

ONE_LAP = svc(
    1, "V1",
    "Y 07:58:00",  # P1A at 07:59, before the range
    "P1A 08:00:00",  # P2A at 08:02
    "P2A 08:03:30",  # P3A at 08:05:30
    "P3A 08:06:00",  # P2B at 08:08
    "P2B 08:09:00",  # P1A at 08:11, then into the yard
    "P1A 08:12:00",
    "Y",
)


def test_computes_wait_gaps_at_each_station():
    assert wait_gaps([ONE_LAP], BLOCK_TIMES, t("08:00:00"), t("08:10:00"), 5 * 60) == [
        # P1A at 08:11 heads into the yard, so it doesn't count.
        WaitGap("S1", t("08:00:00"), None),
        # P2A and P2B both count for S2; 08:02 to 08:08 is too long.
        WaitGap("S2", t("08:02:00"), t("08:08:00")),
        WaitGap("S2", t("08:08:00"), None),
        # The first vehicle must come within one interval of the start.
        WaitGap("S3", t("08:00:00"), t("08:05:30")),
        WaitGap("S3", t("08:05:30"), None),
    ]


def test_accepts_a_wait_of_exactly_one_interval():
    gaps = wait_gaps([ONE_LAP], BLOCK_TIMES, t("08:00:00"), t("08:05:00"), 6 * 60)
    # S2: 08:02 then 08:08 is exactly 6 minutes; the 08:08 arrival is past the end.
    assert [g for g in gaps if g.station == "S2"] == []
