"""One vehicle's day: how its services follow each other, and what is
flagged when they overlap, don't connect, or don't end in the yard."""

from app.domain.conflicts import detect_conflicts
from app.domain.models import Conflict
from app.domain.timeline import GAP_DISCONTINUITY, GAP_NOT_RETURNED, Interval, build_timelines
from tests.helpers import BLOCK_TIMES, LAP, of_type, route, svc, t

SAME_VEHICLE = ("vehicle_overlap", "discontinuity", "not_returned")


def same_vehicle_conflicts(*services):
    return of_type(detect_conflicts(services, BLOCK_TIMES), *SAME_VEHICLE)


def test_orders_services_by_departure_not_id():
    services = [
        svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y"),
        svc(102, "V1", "Y 09:00:00", "P1A 09:02:00", "Y"),
        svc(103, "V1", "Y 07:00:00", "P1A 07:02:00", "Y"),
    ]
    timeline = build_timelines(services, BLOCK_TIMES)["V1"]
    assert [s.id for s in timeline.services] == [103, 101, 102]
    assert same_vehicle_conflicts(*services) == []


def test_flags_a_first_service_not_from_the_yard():
    assert same_vehicle_conflicts(svc(101, "V1", "P1A 08:00:00", "P2A")) == [
        Conflict("discontinuity", (101,), ("Y", "P1A"), end=t("08:00:00")),
        Conflict("not_returned", (101,), ("P2A",)),
    ]


def test_does_not_flag_a_next_service_from_the_same_platform():
    first = svc(101, "V1", "Y 07:58:00", "P1A 08:02:00", "P2A")
    second = svc(102, "V1", "P2A 08:10:00", "P3A 08:14:00", "P2B 08:18:00", "P1A 08:22:00", "Y")
    assert same_vehicle_conflicts(first, second) == []
    waits = [i for i in build_timelines([first, second], BLOCK_TIMES)["V1"].intervals if i.at == "P2A"]
    assert [(w.start, w.end, w.between) for w in waits] == [(t("08:04:00"), t("08:10:00"), (101, 102))]


def test_flags_a_next_service_from_somewhere_else():
    first = svc(101, "V1", "Y 08:00:00", "P1B")
    second = svc(102, "V1", "Y 09:00:00", "P1A 09:02:00", "Y")
    assert same_vehicle_conflicts(first, second) == [
        Conflict("discontinuity", (101, 102), ("P1B", "Y"), start=t("08:01:00"), end=t("09:00:00")),
    ]


def test_flags_overlapping_services():
    first = route(101, "V1", ["Y", "P1A", *LAP, "Y"], start="08:00:00")  # back at 08:15
    second = svc(102, "V1", "Y 08:10:00", "P1A 08:12:00", "Y")
    assert of_type(same_vehicle_conflicts(first, second), "vehicle_overlap") == [
        Conflict("vehicle_overlap", (101, 102), start=t("08:10:00"), end=t("08:15:00")),
    ]


def test_flags_leaving_the_same_second_it_arrived():
    first = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y")  # back at 08:03:00
    second = svc(102, "V1", "Y 08:03:00", "P1A 08:05:00", "Y")
    assert [c.type for c in same_vehicle_conflicts(first, second)] == ["vehicle_overlap"]


def test_does_not_flag_leaving_one_second_after_arriving():
    first = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y")
    second = svc(102, "V1", "Y 08:03:01", "P1A 08:05:00", "Y")
    assert same_vehicle_conflicts(first, second) == []


def test_flags_a_last_service_ending_at_a_platform():
    service = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "P2A")  # at P2A from 08:04
    assert same_vehicle_conflicts(service) == [Conflict("not_returned", (101,), ("P2A",))]
    # V2 passes through P2A later; the parked V1 doesn't count as occupying it.
    passing = svc(102, "V2", "Y 09:00:00", "P1A 09:02:00", "P2A 09:05:00", "P3A 09:08:00", "P2B 09:11:00", "P1A 09:14:00", "Y")
    assert of_type(detect_conflicts([service, passing], BLOCK_TIMES), "platform") == []


def test_does_not_flag_an_empty_schedule():
    assert build_timelines([], BLOCK_TIMES) == {}
    assert detect_conflicts([], BLOCK_TIMES) == []


def intervals_of(*services):
    return build_timelines(services, BLOCK_TIMES)["V1"].intervals


def test_computes_a_gap_between_services_that_dont_connect():
    first = svc(101, "V1", "Y 08:00:00", "P1B")  # at P1B from 08:01
    second = svc(102, "V1", "Y 09:00:00", "P1A 09:02:00", "Y")
    gaps = [i for i in intervals_of(first, second) if i.gap is not None]
    assert gaps == [
        Interval("P1B", t("08:01:00"), t("09:00:00"), None, None, None, (101, 102), gap=GAP_DISCONTINUITY)
    ]
    # Not counted as occupying P1B.
    passing = svc(201, "V2", "Y 08:30:00", "P1B 08:32:00", "Y")
    assert of_type(detect_conflicts([first, second, passing], BLOCK_TIMES), "platform") == []


def test_computes_a_vehicle_parked_after_its_last_service_keeping_its_battery():
    service = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "P2A")  # 77 on arrival
    last = intervals_of(service)[-1]
    assert last == Interval(
        "P2A", t("08:04:00"), t("24:00:00"), None, 77, 77, (101,), gap=GAP_NOT_RETURNED
    )


def test_computes_a_gap_in_the_yard_before_a_first_service_elsewhere():
    first = intervals_of(svc(101, "V1", "P1A 08:00:00", "P2A"))[0]
    assert first == Interval("Y", 0, t("08:00:00"), None, None, None, (101,), gap=GAP_DISCONTINUITY)


def test_computes_which_way_the_vehicle_goes_in_each_block():
    service = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y")
    moving = [(i.at, i.toward) for i in intervals_of(service) if i.service == 101]
    assert moving == [("B1", "P1A"), ("P1A", None), ("B1", "Y")]
