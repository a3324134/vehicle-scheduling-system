"""Everything that is saved but flagged: times a block change has made
contradictory, problems within one vehicle's day, battery, and two vehicles
in the same place at once."""

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from itertools import combinations

from app.domain.models import Conflict, Service
from app.domain.params import DAY_SECONDS
from app.domain.timeline import (
    ComputedService,
    VehicleTimeline,
    build_timelines_from_computed,
    compute_service,
)
from app.domain.track import BLOCK_SET, GROUP_OF_BLOCK, YARD

CONFLICT_TYPES = (
    "dwell_too_short",
    "past_midnight",
    "vehicle_overlap",
    "discontinuity",
    "not_returned",
    "block",
    "interlocking",
    "platform",
    "low_battery",
    "insufficient_charge",
)


def windows_overlap(start1: int, end1: int, start2: int, end2: int) -> bool:
    """Half-open windows; touching end to start is not an overlap."""
    return start1 < end2 and start2 < end1


def detect_conflicts(services: Sequence[Service], block_times: Mapping[str, int]) -> list[Conflict]:
    computed = [compute_service(s, block_times) for s in services]
    conflicts: list[Conflict] = []
    for service in computed:
        conflicts.extend(_time_contradictions(service))
    timelines = build_timelines_from_computed(computed).values()
    for timeline in timelines:
        conflicts.extend(timeline.conflicts)
    conflicts.extend(_occupancy_conflicts(timelines))
    conflicts.sort(key=_sort_key)
    return conflicts


def _sort_key(conflict: Conflict):
    start = conflict.start if conflict.start is not None else -1
    return (start, CONFLICT_TYPES.index(conflict.type), conflict.services)


def _time_contradictions(service: ComputedService) -> list[Conflict]:
    """Saved services that a block time change has made inconsistent."""
    conflicts = []
    last = len(service.stops) - 1
    for i in range(1, last):
        arrival, departure = service.arrivals[i], service.stops[i].departure
        if departure <= arrival:
            conflicts.append(
                Conflict(
                    "dwell_too_short",
                    (service.id,),
                    (service.stops[i].at,),
                    start=arrival,
                    end=departure,
                )
            )
    for i in range(1, last + 1):
        if service.arrivals[i] >= DAY_SECONDS:
            conflicts.append(
                Conflict("past_midnight", (service.id,), (service.stops[i].at,), start=service.arrivals[i])
            )
    return conflicts


@dataclass(frozen=True)
class _Occupancy:
    at: str
    start: int
    end: int
    vehicle: str
    services: tuple[int, ...]


def _occupancy_conflicts(timelines: Iterable[VehicleTimeline]) -> list[Conflict]:
    """Two vehicles in the same block, the same interlocking group, or at the same platform.

    Each place gets its own conflict; the viewer folds runs of them together.
    """
    by_place: dict[str, list[_Occupancy]] = defaultdict(list)
    by_group: dict[int, list[_Occupancy]] = defaultdict(list)
    for timeline in timelines:
        for interval in timeline.intervals:
            if interval.at == YARD or interval.gap is not None or interval.end <= interval.start:
                continue
            occupancy = _Occupancy(
                interval.at, interval.start, interval.end, timeline.vehicle, interval.service_ids
            )
            by_place[interval.at].append(occupancy)
            group = GROUP_OF_BLOCK.get(interval.at)
            if group is not None:
                by_group[group].append(occupancy)

    conflicts = []
    for place, occupancies in by_place.items():
        kind = "block" if place in BLOCK_SET else "platform"
        for a, b in combinations(occupancies, 2):
            if a.vehicle != b.vehicle and windows_overlap(a.start, a.end, b.start, b.end):
                conflicts.append(_pair(kind, a, b, (place,)))
    for occupancies in by_group.values():
        for a, b in combinations(occupancies, 2):
            # The same block is already reported as a block conflict.
            if a.at != b.at and a.vehicle != b.vehicle and windows_overlap(a.start, a.end, b.start, b.end):
                conflicts.append(_pair("interlocking", a, b, (a.at, b.at)))
    return conflicts


def _pair(kind: str, a: _Occupancy, b: _Occupancy, resources: tuple[str, ...]) -> Conflict:
    services = tuple(dict.fromkeys(a.services + b.services))
    return Conflict(kind, services, resources, start=max(a.start, b.start), end=min(a.end, b.end))
