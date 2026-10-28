"""Conflicts between vehicles, and times a slower block has made contradictory."""

from app.domain.conflicts import detect_conflicts, windows_overlap
from app.domain.models import Conflict
from tests.helpers import BLOCK_TIMES, of_type, svc, t

CROSS_VEHICLE = ("block", "interlocking", "platform")


def cross(*services):
    return of_type(detect_conflicts(services, BLOCK_TIMES), *CROSS_VEHICLE)


def test_does_not_flag_touching_windows():
    assert not windows_overlap(0, 60, 60, 120)
    assert windows_overlap(0, 60, 59, 120)


def test_flags_the_same_block_as_a_block_conflict_only():
    found = cross(
        svc(101, "V1", "Y 08:00:00", "P1A"),
        svc(201, "V2", "Y 08:00:30", "P1A"),
    )
    assert found == [Conflict("block", (101, 201), ("B1",), start=t("08:00:30"), end=t("08:01:00"))]


def test_flags_different_blocks_in_one_interlocking_group():
    found = cross(
        svc(101, "V1", "P1A 08:00:00", "P2A"),  # B3 08:00-08:01
        svc(201, "V2", "P2B 07:59:30", "P1B"),  # B14 08:00:30-08:01:30
    )
    assert [(c.type, set(c.resources), c.start, c.end) for c in found] == [
        ("interlocking", {"B3", "B14"}, t("08:00:30"), t("08:01:00"))
    ]


def test_flags_b1_and_b2_as_interlocked():
    found = cross(
        svc(101, "V1", "Y 08:00:00", "P1A"),
        svc(201, "V2", "Y 08:00:30", "P1B"),
    )
    assert [(c.type, set(c.resources)) for c in found] == [("interlocking", {"B1", "B2"})]


def test_flags_head_on_in_a_two_way_block():
    found = cross(
        svc(101, "V1", "Y 08:00:00", "P1A"),
        svc(201, "V2", "P1A 08:00:30", "Y"),
    )
    assert [(c.type, c.resources) for c in found] == [("block", ("B1",))]


V1_STOPS_AT_P2A = svc(101, "V1", "P1A 08:02:00", "P2A 08:10:00", "P3A")  # at P2A 08:04-08:10


def test_flags_overtaking_a_train_standing_at_a_platform():
    found = cross(V1_STOPS_AT_P2A, svc(201, "V2", "P1B 08:04:00", "P2A 08:07:00", "P3A"))
    assert found == [Conflict("platform", (101, 201), ("P2A",), start=t("08:06:00"), end=t("08:07:00"))]


def test_does_not_flag_arriving_as_the_other_leaves():
    assert cross(V1_STOPS_AT_P2A, svc(201, "V2", "P1B 08:08:00", "P2A 08:12:00", "P3A")) == []


def test_flags_a_platform_held_between_services():
    found = cross(
        svc(101, "V1", "Y 07:58:00", "P1A 08:02:00", "P2A"),
        svc(102, "V1", "P2A 08:10:00", "P3A 08:14:00", "P2B 08:18:00", "P1A 08:22:00", "Y"),
        svc(201, "V2", "P1B 08:04:00", "P2A 08:07:00", "P3A"),
    )
    assert [(c.type, c.services, c.resources) for c in found] == [("platform", (101, 102, 201), ("P2A",))]


def test_does_not_flag_vehicles_together_in_the_yard():
    assert (
        cross(
            svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y"),
            svc(201, "V2", "Y 09:00:00", "P1A 09:02:00", "Y"),
        )
        == []
    )


def test_flags_following_too_closely_at_every_place():
    found = cross(
        svc(101, "V1", "P1A 08:00:00", "P2A 08:03:00", "P3A 08:06:00", "P2B"),
        svc(201, "V2", "P1A 08:00:30", "P2A 08:03:30", "P3A 08:06:30", "P2B"),
    )
    assert sorted((c.type, c.resources[0]) for c in found) == sorted(
        [("block", b) for b in ("B3", "B5", "B6", "B7", "B10", "B11")]
        + [("platform", "P2A"), ("platform", "P3A")]
    )


# --- Flagged after a block time change ------------------------------------

AT_P2A_FROM_0804_TO_0806 = svc(101, "V1", "Y 07:59:00", "P1A 08:02:00", "P2A 08:06:00", "P3A")


def test_flags_a_dwell_squeezed_to_zero_by_a_slower_block():
    block_times = {**BLOCK_TIMES, "B5": 180}
    found = of_type(detect_conflicts([AT_P2A_FROM_0804_TO_0806], block_times), "dwell_too_short")
    assert found == [
        Conflict("dwell_too_short", (101,), ("P2A",), start=t("08:06:00"), end=t("08:06:00"))
    ]


def test_flags_an_arrival_pushed_past_midnight_by_a_slower_block():
    block_times = {**BLOCK_TIMES, "B5": 280}
    found = of_type(detect_conflicts([svc(101, "V1", "P1A 23:58:00", "P2A")], block_times), "past_midnight")
    assert found == [Conflict("past_midnight", (101,), ("P2A",), start=t("24:03:40"))]
