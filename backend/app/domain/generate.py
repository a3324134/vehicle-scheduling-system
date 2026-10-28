"""Bonus 3: generate a whole schedule.

How it works:
- One loop, S1 → P2A → S3 → P2B → S1: the quickest one for the block times,
  unless vehicles can't swap on it.
- Every stop is the same fixed dwell (GENERATED_DWELL_SECONDS), so a lap
  always takes the same time. The vehicles needed to cover the interval are
  spread evenly round the loop: a lap of 10 minutes with 2 vehicles means
  one every 5 minutes, even if the interval asked for is 6.
- Each of those running places ("slots") is held by one vehicle until its
  battery runs low. Then a charged vehicle comes out of the yard and
  reaches P2A exactly when the old one would have, and takes over. The two
  use different S1 platforms: either the new one comes in on the other
  platform, or the old one turns off to it on its way back. Whichever works
  with the block times is used.
- One service is one trip out of the yard and back.
- The result is checked with the same conflict detection as everything else
  and with the passenger wait rule. Anything that fails is
  not handed out.
"""

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import ceil

from app.domain.conflicts import detect_conflicts
from app.domain.models import Service, Stop
from app.domain.params import (
    BATTERY_COST_PER_BLOCK,
    CHARGE_SECONDS_PER_UNIT,
    DEPARTURE_BATTERY_REQUIRED,
    GENERATED_DWELL_SECONDS,
    INITIAL_BATTERY,
    LOW_BATTERY_THRESHOLD,
    MAX_BATTERY,
)
from app.domain.timefmt import format_hms
from app.domain.timeline import compute_arrivals
from app.domain.track import GROUP_OF_BLOCK, INTERLOCKING_GROUPS, STATION_OF_PLATFORM, YARD, find_segment
from app.domain.validate import validate_stops


class GenerationFailed(Exception):
    """No schedule for these inputs; `reason` is shown to the user."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Route:
    s1: str  # the S1 platform the loop uses
    s3: str  # the S3 platform the loop uses
    other: str  # the other S1 platform, used when vehicles swap

    @property
    def lap(self) -> tuple[str, ...]:
        return (self.s1, "P2A", self.s3, "P2B", self.s1)


@dataclass(frozen=True)
class Handover:
    """Where vehicles join the loop from the yard and where they leave it."""

    joins_at: str
    leaves_at: str


@dataclass(frozen=True)
class Generated:
    services: tuple[tuple[str, tuple[Stop, ...]], ...]  # (vehicle, stops)
    route: Route
    handover: Handover
    # Seconds between vehicles on the loop: equal, or one second apart when a
    # lap doesn't divide evenly.
    gap: tuple[int, int]


@dataclass(frozen=True)
class WaitGap:
    """Passengers at `station` wait longer than the interval after `since`."""

    station: str
    since: int
    until: int | None  # the next vehicle, or None if none comes


def routes_by_speed(block_times: Mapping[str, int]) -> list[Route]:
    """The four loops, quickest first. Ties keep P1A and P3A first."""
    options = [
        Route(s1, s3, other)
        for s1, other in (("P1A", "P1B"), ("P1B", "P1A"))
        for s3 in ("P3A", "P3B")
    ]
    return sorted(options, key=lambda route: _travel(route.lap, block_times))


def longest_interval(start: int, end: int) -> int:
    """In minutes: no longer than the time range."""
    return (end - start) // 60


def shortest_interval(
    start: int,
    end: int,
    block_times: Mapping[str, int],
    vehicles: Sequence[str],
    dwell: int = GENERATED_DWELL_SECONDS,
) -> tuple[int | None, str | None]:
    """The shortest interval in whole minutes that generates, tried from 1 up
    with the generator itself, and why one minute less fails."""
    reason = None
    for minutes in range(1, longest_interval(start, end) + 1):
        try:
            generate(minutes * 60, start, end, block_times, vehicles, dwell)
        except GenerationFailed as failed:
            reason = failed.reason
            continue
        return minutes, reason
    return None, reason


def generate(
    interval: int,
    start: int,
    end: int,
    block_times: Mapping[str, int],
    vehicles: Sequence[str],
    dwell: int = GENERATED_DWELL_SECONDS,
) -> Generated:
    """Services that leave the yard from `start` to `end`, a vehicle every
    `interval` seconds at each station. Raises GenerationFailed."""
    failures: list[tuple[int, GenerationFailed]] = []
    # The quickest loop first. A slower one is only used when vehicles can't
    # swap on the quick one, e.g. when the other S1 platform's blocks are much
    # slower.
    attempts = [
        (route, handover)
        for route in routes_by_speed(block_times)
        for handover in (Handover(route.other, route.s1), Handover(route.s1, route.other))
    ]
    for route, handover in attempts:
        stage = 0
        try:
            plan = _plan(interval, start, block_times, vehicles, dwell, route, handover)
            stage = 1
            services = _Assigner(plan, start, end, vehicles).run()
            stage = 2
            _verify(services, block_times, start, end, interval)
        except GenerationFailed as failed:
            failures.append((stage, failed))
            continue
        return Generated(tuple(services), route, handover, plan.gaps)
    # Explain the attempt that got furthest.
    raise max(failures, key=lambda f: f[0])[1]


def wait_gaps(
    services: Sequence[Service], block_times: Mapping[str, int], start: int, end: int, interval: int
) -> list[WaitGap]:
    """Where a passenger would wait longer than `interval` between `start` and
    `end`. Any platform of a station counts; a vehicle heading
    into the yard does not."""
    arrivals: dict[str, list[int]] = defaultdict(list)
    for service in services:
        times = compute_arrivals(service.stops, block_times)
        # The last stop is excluded: the vehicle goes no further.
        for i in range(1, len(service.stops) - 1):
            if service.stops[i + 1].at != YARD:
                arrivals[STATION_OF_PLATFORM[service.stops[i].at]].append(times[i])

    gaps = []
    for station in sorted(set(STATION_OF_PLATFORM.values())):
        since = start
        for at in sorted(t for t in arrivals[station] if t >= start):
            if at - since > interval:
                gaps.append(WaitGap(station, since, at))
            since = at
            if since >= end:
                break
        if since < end:
            gaps.append(WaitGap(station, since, None))
    return gaps


# --- the fixed pattern -------------------------------------------------------


@dataclass(frozen=True)
class _Plan:
    route: Route
    handover: Handover
    slots: int  # vehicles on the loop at once
    lap_seconds: int
    dwell: int  # at every stop
    join_seconds: int  # from the yard to where a vehicle joins
    # When a vehicle from the yard arrives where it joins, compared with when a
    # loop vehicle arrives at s1. Both then reach P2A at the same time.
    join_offset: int
    legs: tuple[int, int, int, int]  # travel times between the lap's stops
    block_times: Mapping[str, int]

    @property
    def gaps(self) -> tuple[int, int]:
        return self.lap_seconds // self.slots, ceil(self.lap_seconds / self.slots)

    @property
    def lap_blocks(self) -> int:
        return _block_count(self.route.lap)

    @property
    def join_blocks(self) -> int:
        return _block_count((YARD, self.handover.joins_at))

    @property
    def leave_blocks(self) -> int:
        """Blocks from P2B to the yard, beyond the usual P2B to s1."""
        way_back = _block_count(("P2B", self.handover.leaves_at, YARD))
        return way_back - _block_count(("P2B", self.route.s1))

    @property
    def exit_floor(self) -> int:
        """Battery needed at the S1 arrival to get back to the yard instead
        without dropping below 30."""
        return LOW_BATTERY_THRESHOLD + self.leave_blocks * BATTERY_COST_PER_BLOCK


def _plan(
    interval: int,
    start: int,
    block_times: Mapping[str, int],
    vehicles: Sequence[str],
    dwell: int,
    route: Route,
    handover: Handover,
) -> _Plan:
    lap = route.lap
    legs = tuple(_seconds(a, b, block_times) for a, b in zip(lap, lap[1:]))
    join_seconds = _seconds(YARD, handover.joins_at, block_times)
    joining_leg = _seconds(handover.joins_at, "P2A", block_times)

    # The first vehicle leaves the yard at the start; S3, the farthest station,
    # must still see it within one interval.
    reach = join_seconds + dwell + joining_leg + dwell + legs[1]
    if reach > interval:
        raise GenerationFailed(
            f"A vehicle needs {_minutes(reach)} to get from the yard to {route.s3}, the farthest station"
        )

    # As few vehicles as cover the interval, spread evenly round the loop.
    lap_seconds = sum(legs) + 4 * dwell
    slots = ceil(lap_seconds / interval)
    if slots > len(vehicles):
        raise GenerationFailed(
            f"A lap takes {_minutes(lap_seconds)}, so {slots} vehicles must run at once; the fleet has {len(vehicles)}"
        )
    gap = lap_seconds // slots
    apart = f"vehicles are {_minutes(gap)} apart"

    for a, b in zip(lap, lap[1:]):
        for block in _blocks(a, b):
            if block_times[block] > gap:
                raise GenerationFailed(f"{block} takes {_minutes(block_times[block])} to pass, but {apart}")

    # Around S1 and S3 each vehicle holds an interlocking group twice: coming
    # in and going out. Both, and the stop between, must be done before the
    # next vehicle comes in.
    for index, platform in ((0, route.s1), (2, route.s3)):
        into = _blocks(lap[index - 1] if index else "P2B", platform)[-1]
        out = _blocks(platform, lap[index + 1])[0]
        needed = block_times[into] + dwell + block_times[out]
        if needed > gap:
            group = "/".join(INTERLOCKING_GROUPS[GROUP_OF_BLOCK[into]])
            raise GenerationFailed(
                f"Each vehicle needs {_minutes(needed)} in interlocking group {group} at {platform}, but {apart}"
            )

    return _Plan(
        route=route,
        handover=handover,
        slots=slots,
        lap_seconds=lap_seconds,
        dwell=dwell,
        join_seconds=join_seconds,
        join_offset=legs[0] - joining_leg,
        legs=legs,
        block_times=block_times,
    )


# --- who drives which lap ----------------------------------------------------


@dataclass
class _Run:
    """One vehicle out of the yard, holding one slot."""

    vehicle: str
    stops: list[Stop]
    battery: int  # at its next arrival at S1
    next_arrival: int


@dataclass
class _Parked:
    arrived: int | None  # None: not used yet today, still at the 80 it starts with
    battery: int


class _Assigner:
    def __init__(self, plan: _Plan, start: int, end: int, vehicles: Sequence[str]):
        self.plan = plan
        self.end = end
        # Laps are numbered by when they arrive at S1. The first vehicle leaves
        # the yard right at the start.
        self.first_arrival = start + plan.join_seconds - plan.join_offset
        # The last lap is the first to reach S1 at or after the end, so every
        # station is covered up to the end.
        self.last_lap = 0
        while self.arrival(self.last_lap) < end:
            self.last_lap += 1
        self.vehicles = list(vehicles)
        self.yard = {v: _Parked(None, INITIAL_BATTERY) for v in vehicles}
        self.services: list[tuple[str, tuple[Stop, ...]]] = []

    def arrival(self, lap: int) -> int:
        """Spread evenly; one second apart at most when a lap doesn't divide evenly."""
        return self.first_arrival + lap * self.plan.lap_seconds // self.plan.slots

    def joins(self, lap: int) -> int:
        """When a vehicle from the yard arrives where it joins, for this lap."""
        return self.arrival(lap) + self.plan.join_offset

    def leaves_yard(self, lap: int) -> int:
        return self.joins(lap) - self.plan.join_seconds

    def run(self) -> list[tuple[str, tuple[Stop, ...]]]:
        plan = self.plan
        runs: list[_Run | None] = [None] * plan.slots
        for lap in range(self.last_lap + 1):
            slot = lap % plan.slots
            current = runs[slot]
            if current is not None and self._keeps_going(current, lap):
                current.stops.append(Stop(plan.route.s1, self.arrival(lap) + plan.dwell))
            else:
                if current is not None:
                    self._back_to_yard(current)
                current = runs[slot] = self._out_of_yard(lap)
            self._drive_lap(current, lap)
        for current in runs:
            if current is not None:
                self._back_to_yard(current)
        return self.services

    def _keeps_going(self, current: _Run, lap: int) -> bool:
        plan = self.plan
        after_lap = current.battery - plan.lap_blocks * BATTERY_COST_PER_BLOCK
        if after_lap < plan.exit_floor:
            return False
        # If the last lap would need a fresh vehicle that leaves the yard after
        # the end of the range, hand over one lap earlier instead.
        handover_next = after_lap - plan.lap_blocks * BATTERY_COST_PER_BLOCK < plan.exit_floor
        if lap + plan.slots == self.last_lap and handover_next and self.leaves_yard(self.last_lap) > self.end:
            return False
        return True

    def _out_of_yard(self, lap: int) -> _Run:
        plan = self.plan
        leaves = self.leaves_yard(lap)
        if leaves > self.end:
            raise GenerationFailed(f"A vehicle would have to leave the yard at {format_hms(leaves)}, after the end")
        vehicle, battery = self._pick_vehicle(leaves)
        stops = [Stop(YARD, leaves), Stop(plan.handover.joins_at, self.joins(lap) + plan.dwell)]
        return _Run(vehicle, stops, battery - plan.join_blocks * BATTERY_COST_PER_BLOCK, self.arrival(lap))

    def _pick_vehicle(self, leaves: int) -> tuple[str, int]:
        """The vehicle in the yard that has been ready the longest."""
        best: tuple[int, str, int] | None = None  # (ready since, vehicle, battery)
        for vehicle in self.vehicles:
            parked = self.yard.get(vehicle)
            if parked is None:
                continue
            if parked.arrived is None:
                battery, ready = parked.battery, -1
            else:
                if leaves <= parked.arrived:
                    continue
                # Charging as the timeline computes it.
                charged = (leaves - parked.arrived) // CHARGE_SECONDS_PER_UNIT
                battery = min(MAX_BATTERY, parked.battery + charged)
                missing = max(0, DEPARTURE_BATTERY_REQUIRED - parked.battery)
                ready = parked.arrived + missing * CHARGE_SECONDS_PER_UNIT
            if battery >= DEPARTURE_BATTERY_REQUIRED and (best is None or ready < best[0]):
                best = (ready, vehicle, battery)
        if best is None:
            raise GenerationFailed(
                f"No vehicle in the yard is charged to {DEPARTURE_BATTERY_REQUIRED} at {format_hms(leaves)}"
            )
        _, vehicle, battery = best
        del self.yard[vehicle]
        return vehicle, battery

    def _drive_lap(self, current: _Run, lap: int) -> None:
        """From S1 round to P2B; the next S1 arrival is added by whoever drives on."""
        plan = self.plan
        route = plan.route
        # When the loop leaves s1, whether this vehicle is at s1 or joins from
        # the other platform: both reach P2A at the same time.
        departure = self.arrival(lap) + plan.dwell
        for stop, leg in zip(route.lap[1:4], plan.legs):
            departure += leg + plan.dwell
            current.stops.append(Stop(stop, departure))
        current.battery -= plan.lap_blocks * BATTERY_COST_PER_BLOCK
        current.next_arrival = self.arrival(lap + plan.slots)

    def _back_to_yard(self, current: _Run) -> None:
        """Instead of arriving at s1 again, go back to the yard."""
        plan = self.plan
        times = plan.block_times
        platform = plan.handover.leaves_at
        if platform == plan.route.s1:
            leaves = current.next_arrival + plan.dwell
        else:
            # Turn off to the other platform. Wait there until the vehicle taking
            # over has arrived from the yard, so the two don't meet on B1/B2.
            arrives = current.stops[-1].departure + _seconds("P2B", platform, times)
            leaves = max(arrives + plan.dwell, current.next_arrival)
        current.stops += [Stop(platform, leaves), Stop(YARD)]
        self.services.append((current.vehicle, tuple(current.stops)))
        battery = current.battery - plan.leave_blocks * BATTERY_COST_PER_BLOCK
        self.yard[current.vehicle] = _Parked(leaves + _seconds(platform, YARD, times), battery)


# --- checking the result -----------------------------------------------------


def _verify(
    services: Sequence[tuple[str, tuple[Stop, ...]]],
    block_times: Mapping[str, int],
    start: int,
    end: int,
    interval: int,
) -> None:
    """Hand out nothing the rest of the system would flag."""
    numbered = [Service(i + 1, vehicle, stops) for i, (vehicle, stops) in enumerate(services)]
    for service in numbered:
        errors = validate_stops(service.stops, block_times)
        if any(e.type == "past_midnight" for e in errors):
            raise GenerationFailed("The last vehicles would get back to the yard after midnight")
        if errors:
            raise GenerationFailed(f"A generated service is invalid: {errors[0].msg}")
    conflicts = detect_conflicts(numbered, block_times)
    if conflicts:
        first = conflicts[0]
        when = f" at {format_hms(first.start)}" if first.start is not None else ""
        where = f" ({', '.join(first.resources)})" if first.resources else ""
        kind = first.type.replace("_", " ")
        article = "an" if kind[0] in "aeiou" else "a"
        raise GenerationFailed(f"It would cause {article} {kind} conflict{when}{where}")
    gaps = wait_gaps(numbered, block_times, start, end, interval)
    if gaps:
        gap = gaps[0]
        raise GenerationFailed(f"Passengers at {gap.station} would wait longer than the interval after {format_hms(gap.since)}")


# --- small helpers -----------------------------------------------------------


def _blocks(start: str, end: str) -> tuple[str, ...]:
    return find_segment(start, end).blocks


def _block_count(stations: Sequence[str]) -> int:
    return sum(len(_blocks(a, b)) for a, b in zip(stations, stations[1:]))


def _seconds(start: str, end: str, block_times: Mapping[str, int]) -> int:
    return sum(block_times[b] for b in _blocks(start, end))


def _travel(stations: Sequence[str], block_times: Mapping[str, int]) -> int:
    return sum(_seconds(a, b, block_times) for a, b in zip(stations, stations[1:]))


def _minutes(seconds: int) -> str:
    """135 -> '2 min 15 s'."""
    minutes, rest = divmod(seconds, 60)
    if not rest:
        return f"{minutes} min"
    return f"{minutes} min {rest} s" if minutes else f"{rest} s"
