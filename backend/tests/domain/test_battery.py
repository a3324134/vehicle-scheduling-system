"""Battery use, charging in the yard, and the two battery warnings."""

from app.domain.conflicts import detect_conflicts
from app.domain.timefmt import format_hms
from app.domain.timeline import build_timelines, compute_service
from tests.helpers import BLOCK_TIMES, LAP, of_type, route, svc, t


def timeline(*services):
    return build_timelines(services, BLOCK_TIMES)["V1"]


def battery_conflicts(*services):
    return of_type(detect_conflicts(services, BLOCK_TIMES), "low_battery", "insufficient_charge")


def at(seconds: int) -> str:
    return format_hms(seconds)


def test_computes_one_unit_used_on_entering_each_block():
    intervals = timeline(svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "P2A")).intervals
    moving = [(i.at, i.battery_end) for i in intervals if i.service == 101]
    assert moving == [("B1", 79), ("P1A", 79), ("B3", 78), ("B5", 77)]


def test_computes_80_at_the_first_departure_without_charging_before_it():
    first = svc(101, "V1", "Y 10:00:00", "P1A 10:02:00", "Y")
    initial_wait = timeline(first).intervals[0]
    assert (initial_wait.at, initial_wait.battery_start, initial_wait.battery_end) == ("Y", 80, 80)
    assert battery_conflicts(first) == []


def test_does_not_flag_a_battery_of_exactly_30():
    service = route(101, "V1", ["Y", "P1A", *LAP * 6, "Y"], start="08:00:00")
    blocks = [i for i in timeline(service).intervals if i.at.startswith("B")]
    assert blocks[-2].battery_end == 31  # B13, back at P1A after six laps
    assert blocks[-1].battery_end == 30  # B1 on the way home
    assert battery_conflicts(service) == []


def test_flags_low_battery_once_per_trip():
    service = route(101, "V1", ["Y", "P1A", *LAP * 7, "Y"], start="08:00:00")
    first_low = next(i for i in timeline(service).intervals if i.battery_end == 29)
    [conflict] = battery_conflicts(service)
    assert conflict.type == "low_battery"
    assert conflict.services == (101,)
    assert conflict.resources == ("B5",)
    assert conflict.start == first_low.start
    assert conflict.end == compute_service(service, BLOCK_TIMES).end
    assert conflict.detail == {"battery_at_start": 29, "lowest": 22}


def test_flags_a_second_trip_below_30_again():
    first = route(101, "V1", ["Y", "P1A", *LAP * 7, "Y"], start="08:00:00")
    back = compute_service(first, BLOCK_TIMES).end
    # Leaves after only 60 seconds of charging: 22 + 5 = 27.
    second = svc(102, "V1", f"Y {at(back + 60)}", f"P1A {at(back + 180)}", "Y")
    low = of_type(battery_conflicts(first, second), "low_battery")
    assert [c.services for c in low] == [(101,), (102,)]


def test_computes_battery_below_zero():
    service = route(101, "V1", ["Y", "P1A", *LAP * 12], start="08:00:00")
    [conflict] = battery_conflicts(service)
    assert conflict.detail["lowest"] == 79 - 8 * 12
    assert conflict.end is None


def test_computes_charge_in_whole_12_second_units():
    first = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y")  # back at 08:03:00 with 78
    for wait, expected in [(11, 78), (12, 79)]:
        second = svc(102, "V1", f"Y {at(t('08:03:00') + wait)}", "P1A 08:06:00", "Y")
        charge = next(i for i in timeline(first, second).intervals if i.at == "Y" and i.between == (101, 102))
        assert (charge.battery_start, charge.battery_end) == (78, expected)


def test_computes_charge_up_to_100_at_most():
    first = svc(101, "V1", "Y 08:00:00", "P1A 08:02:00", "Y")
    second = svc(102, "V1", "Y 09:03:00", "P1A 09:05:00", "Y")
    charge = next(i for i in timeline(first, second).intervals if i.between == (101, 102))
    assert charge.battery_end == 100


def lap_then_leave_after(wait: int):
    first = route(101, "V1", ["Y", "P1A", *LAP, "Y"], start="08:00:00")  # back with 70
    back = compute_service(first, BLOCK_TIMES).end
    second = svc(102, "V1", f"Y {at(back + wait)}", f"P1A {at(back + wait + 120)}", "Y")
    return first, second


def test_flags_leaving_the_yard_one_second_before_reaching_80():
    first, second = lap_then_leave_after(119)  # 70 + 9 = 79
    assert [(c.type, c.services) for c in battery_conflicts(first, second)] == [
        ("insufficient_charge", (102,))
    ]


def test_does_not_flag_leaving_the_yard_once_back_at_80():
    first, second = lap_then_leave_after(120)  # 70 + 10 = 80
    assert battery_conflicts(first, second) == []


def test_computes_no_battery_after_a_discontinuity():
    first = svc(101, "V1", "Y 08:00:00", "P1B")
    second = route(102, "V1", ["Y", "P1A", *LAP * 12], start="09:00:00")
    assert battery_conflicts(first, second) == []
    later = [i for i in timeline(first, second).intervals if i.service == 102]
    assert later and all(i.battery_end is None for i in later)


def test_flags_low_battery_up_to_a_discontinuity():
    # Below 30 and still out (ends at P1A, 23 left), then the next service starts
    # in the yard: the warning has no end, and nothing after it is guessed.
    first = route(101, "V1", ["Y", "P1A", *LAP * 7], start="08:00:00")
    second = svc(102, "V1", "Y 20:00:00", "P1A 20:02:00", "Y")
    [conflict] = battery_conflicts(first, second)
    assert (conflict.type, conflict.services, conflict.end) == ("low_battery", (101,), None)
    assert conflict.detail == {"battery_at_start": 29, "lowest": 23}
    later = [i for i in timeline(first, second).intervals if i.service == 102]
    assert later and all(i.battery_end is None for i in later)
