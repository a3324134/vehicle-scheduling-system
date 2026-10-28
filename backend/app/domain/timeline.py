"""Arrival times, per-vehicle timelines and battery.

Users enter departures; arrivals are always computed from them plus the
block traversal times. A vehicle's timeline chains its services in time
order and records where it is, when, and with how much battery.
"""

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from app.domain.models import Conflict, Service, Stop
from app.domain.params import (
    BATTERY_COST_PER_BLOCK,
    CHARGE_SECONDS_PER_UNIT,
    DAY_SECONDS,
    DEPARTURE_BATTERY_REQUIRED,
    INITIAL_BATTERY,
    LOW_BATTERY_THRESHOLD,
    MAX_BATTERY,
)
from app.domain.track import BLOCK_SET, YARD, find_segment


@dataclass(frozen=True)
class Step:
    """Time spent in one block, or at one intermediate stop, half-open [start, end)."""

    at: str
    start: int
    end: int
    # For a block: the station the vehicle is heading to, since B1 and B2
    # are used in both directions.
    toward: str | None = None


@dataclass(frozen=True)
class ComputedService:
    id: int
    vehicle: str
    stops: tuple[Stop, ...]
    arrivals: tuple[int | None, ...]  # None for the first stop
    path: tuple[str, ...]  # stations and blocks, as the spec describes a path
    steps: tuple[Step, ...]  # blocks and intermediate stops, in order

    @property
    def first_at(self) -> str:
        return self.stops[0].at

    @property
    def last_at(self) -> str:
        return self.stops[-1].at

    @property
    def start(self) -> int:
        return self.stops[0].departure

    @property
    def end(self) -> int:
        return self.arrivals[-1]


def walk(stops: Sequence[Stop], block_times: Mapping[str, int]):
    """Return (arrivals, path, steps) for structurally valid stops.

    The next leg always starts at the stop's departure, even when that is
    not after the arrival; such stops are flagged elsewhere.
    """
    arrivals: list[int | None] = [None]
    path = [stops[0].at]
    steps: list[Step] = []
    now = stops[0].departure
    last = len(stops) - 1
    for i in range(last):
        segment = find_segment(stops[i].at, stops[i + 1].at)
        if segment is None or now is None:
            raise ValueError(f"stops are not a valid path at index {i}")
        for block in segment.blocks:
            leave = now + block_times[block]
            steps.append(Step(block, now, leave, segment.end))
            path.append(block)
            now = leave
        path.append(segment.end)
        arrivals.append(now)
        if i + 1 < last:
            departure = stops[i + 1].departure
            steps.append(Step(segment.end, now, departure))
            now = departure
    return tuple(arrivals), tuple(path), tuple(steps)


def compute_arrivals(stops: Sequence[Stop], block_times: Mapping[str, int]) -> tuple[int | None, ...]:
    return walk(stops, block_times)[0]


def compute_service(service: Service, block_times: Mapping[str, int]) -> ComputedService:
    arrivals, path, steps = walk(service.stops, block_times)
    return ComputedService(service.id, service.vehicle, service.stops, arrivals, path, steps)


# Why a vehicle is somewhere outside its services.
GAP_DISCONTINUITY = "discontinuity"
GAP_NOT_RETURNED = "not_returned"


@dataclass(frozen=True)
class Interval:
    """Where a vehicle is during [start, end). Battery is None once it can't be
    known, i.e. after services that don't connect."""

    at: str
    start: int
    end: int
    service: int | None
    battery_start: int | None
    battery_end: int | None
    # For a wait between two services: the services before and after it.
    between: tuple[int, ...] = ()
    toward: str | None = None
    # Set when the schedule leaves the vehicle stranded here. Such intervals
    # are only for display: they don't occupy anything or charge.
    gap: str | None = None

    @property
    def service_ids(self) -> tuple[int, ...]:
        return (self.service,) if self.service is not None else self.between


@dataclass(frozen=True)
class VehicleTimeline:
    vehicle: str
    services: tuple[ComputedService, ...]  # sorted by first departure
    intervals: tuple[Interval, ...]
    conflicts: tuple[Conflict, ...]  # same-vehicle (③) and battery (⑤)


@dataclass
class _LowBatteryTrip:
    """One trip away from the yard during which battery fell below 30."""

    block: str
    start: int
    battery_at_start: int
    lowest: int
    services: list[int] = field(default_factory=list)

    def to_conflict(self, end: int | None) -> Conflict:
        return Conflict(
            "low_battery",
            tuple(self.services),
            (self.block,),
            start=self.start,
            end=end,
            detail={"battery_at_start": self.battery_at_start, "lowest": self.lowest},
        )


def build_timelines(
    services: Iterable[Service], block_times: Mapping[str, int]
) -> dict[str, VehicleTimeline]:
    return build_timelines_from_computed(compute_service(s, block_times) for s in services)


def build_timelines_from_computed(
    computed: Iterable[ComputedService],
) -> dict[str, VehicleTimeline]:
    by_vehicle: dict[str, list[ComputedService]] = defaultdict(list)
    for service in computed:
        by_vehicle[service.vehicle].append(service)
    return {
        vehicle: build_vehicle_timeline(vehicle, by_vehicle[vehicle])
        for vehicle in sorted(by_vehicle)
    }


def build_vehicle_timeline(vehicle: str, services: Sequence[ComputedService]) -> VehicleTimeline:
    ordered = sorted(services, key=lambda s: (s.start, s.id))
    conflicts = _overlaps(ordered)
    intervals: list[Interval] = []

    # Every vehicle starts the day in the yard with 80. That 80 is the battery
    # at the first departure, so nothing is charged before it.
    battery: int | None = INITIAL_BATTERY
    location = YARD
    idle_since = 0
    charging = False
    latest_end: int | None = None
    previous: ComputedService | None = None
    trip: _LowBatteryTrip | None = None

    for current in ordered:
        overlapping = latest_end is not None and current.start <= latest_end
        moved = location != current.first_at
        if moved:
            conflicts.append(_discontinuity(previous, current, location, idle_since))
            if not overlapping and current.start > idle_since:
                # Shown where it was last seen until the next service starts.
                between = tuple(s.id for s in (previous, current) if s is not None)
                intervals.append(
                    Interval(
                        location, idle_since, current.start, None, None, None, between,
                        gap=GAP_DISCONTINUITY,
                    )
                )
        if overlapping or moved:
            # The schedule doesn't connect here, so anything we computed about
            # battery from now on would be a guess.
            if trip is not None:
                conflicts.append(trip.to_conflict(end=None))
                trip = None
            battery = None
        elif current.start > idle_since:
            battery = _wait(
                intervals, location, idle_since, current.start, battery, charging, previous, current
            )

        if current.first_at == YARD and battery is not None and battery < DEPARTURE_BATTERY_REQUIRED:
            conflicts.append(Conflict("insufficient_charge", (current.id,), (YARD,), start=current.start))

        battery, trip = _drive(current, battery, trip, intervals, conflicts)
        location, idle_since = current.last_at, current.end
        charging = location == YARD
        latest_end = current.end if latest_end is None else max(latest_end, current.end)
        previous = current

    if trip is not None:
        conflicts.append(trip.to_conflict(end=None))
    if previous is not None and location != YARD:
        # Not counted as occupying the platform afterwards.
        conflicts.append(Conflict("not_returned", (previous.id,), (location,)))
        if idle_since < DAY_SECONDS:
            # Parked, so the battery stays as it arrived.
            intervals.append(
                Interval(
                    location, idle_since, DAY_SECONDS, None, battery, battery, (previous.id,),
                    gap=GAP_NOT_RETURNED,
                )
            )
    elif idle_since < DAY_SECONDS:
        _wait(intervals, YARD, idle_since, DAY_SECONDS, battery, charging, previous, None)

    return VehicleTimeline(vehicle, tuple(ordered), tuple(intervals), tuple(conflicts))


def _overlaps(ordered: Sequence[ComputedService]) -> list[Conflict]:
    """Same vehicle: the next service must leave at least 1 second after the
    previous one arrives."""
    conflicts = []
    for i, earlier in enumerate(ordered):
        for later in ordered[i + 1 :]:
            if later.start <= earlier.end:
                conflicts.append(
                    Conflict(
                        "vehicle_overlap",
                        (earlier.id, later.id),
                        start=later.start,
                        end=earlier.end,
                    )
                )
    return conflicts


def _discontinuity(
    previous: ComputedService | None, current: ComputedService, location: str, idle_since: int
) -> Conflict:
    if previous is None:
        # Compared with the virtual start in the yard.
        return Conflict("discontinuity", (current.id,), (location, current.first_at), end=current.start)
    return Conflict(
        "discontinuity",
        (previous.id, current.id),
        (location, current.first_at),
        start=idle_since,
        end=current.start,
    )


def _wait(
    intervals: list[Interval],
    at: str,
    start: int,
    end: int,
    battery: int | None,
    charging: bool,
    previous: ComputedService | None,
    following: ComputedService | None,
) -> int | None:
    """Record a wait between services; charge if it is in the yard."""
    after = battery
    if at == YARD and charging and battery is not None:
        after = min(MAX_BATTERY, battery + (end - start) // CHARGE_SECONDS_PER_UNIT)
    between = tuple(s.id for s in (previous, following) if s is not None)
    intervals.append(Interval(at, start, end, None, battery, after, between))
    return after


def _drive(
    service: ComputedService,
    battery: int | None,
    trip: _LowBatteryTrip | None,
    intervals: list[Interval],
    conflicts: list[Conflict],
) -> tuple[int | None, _LowBatteryTrip | None]:
    for step in service.steps:
        if step.at in BLOCK_SET and battery is not None:
            # Battery drops on entering a block.
            battery -= BATTERY_COST_PER_BLOCK
            if trip is None and battery < LOW_BATTERY_THRESHOLD:
                trip = _LowBatteryTrip(step.at, step.start, battery, battery)
            if trip is not None:
                trip.lowest = min(trip.lowest, battery)
                if service.id not in trip.services:
                    trip.services.append(service.id)
        intervals.append(
            Interval(step.at, step.start, step.end, service.id, battery, battery, toward=step.toward)
        )

    if service.last_at == YARD and trip is not None:
        conflicts.append(trip.to_conflict(end=service.end))
        trip = None
    return battery, trip
