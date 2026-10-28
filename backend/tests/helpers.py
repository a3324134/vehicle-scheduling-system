"""Shortcuts for building services in tests."""

from collections.abc import Mapping, Sequence

from app.domain.models import Service, Stop
from app.domain.timefmt import parse_hms
from app.domain.track import BLOCKS, find_segment

# The tests' own block time, not the app's default (DEFAULT_TRAVERSAL_SECONDS):
# the times written in the tests are worked out with it, so changing the default
# changes none of them. The API tests set the database to it too (conftest.py).
TEST_BLOCK_SECONDS = 60
BLOCK_TIMES = {block: TEST_BLOCK_SECONDS for block in BLOCKS}

# One lap from P1A back to P1A: 8 blocks.
LAP = ("P2A", "P3A", "P2B", "P1A")


def t(text: str) -> int:
    return parse_hms(text)


def stops(*specs: str) -> tuple[Stop, ...]:
    """stops("Y 08:00:00", "P1A 08:02:00", "P2A") -> departures as given."""
    result = []
    for spec in specs:
        at, *departure = spec.split()
        result.append(Stop(at, t(departure[0]) if departure else None))
    return tuple(result)


def svc(service_id: int, vehicle: str, *specs: str) -> Service:
    return Service(service_id, vehicle, stops(*specs))


def route(
    service_id: int,
    vehicle: str,
    stations: Sequence[str],
    start: str,
    dwell: int = 60,
    block_times: Mapping[str, int] = BLOCK_TIMES,
) -> Service:
    """A service over the given stations, stopping `dwell` seconds at each intermediate one."""
    departure = t(start)
    result = [Stop(stations[0], departure)]
    for i in range(1, len(stations)):
        segment = find_segment(stations[i - 1], stations[i])
        arrival = departure + sum(block_times[b] for b in segment.blocks)
        if i == len(stations) - 1:
            result.append(Stop(stations[i]))
        else:
            departure = arrival + dwell
            result.append(Stop(stations[i], departure))
    return Service(service_id, vehicle, tuple(result))


def of_type(conflicts, *types: str):
    return [c for c in conflicts if c.type in types]
