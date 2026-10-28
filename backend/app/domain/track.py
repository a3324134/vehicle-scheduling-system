"""Fixed track layout from the spec.

The layout never changes at runtime, so it lives in code instead of the
database. Only block traversal times are configurable.
"""

from dataclasses import dataclass

YARD = "Y"
PLATFORMS = ("P1A", "P1B", "P2A", "P2B", "P3A", "P3B")
STATIONS = (YARD, *PLATFORMS)
# Passenger stations and their two platforms; the yard is not one.
STATION_OF_PLATFORM = {platform: f"S{platform[1]}" for platform in PLATFORMS}
BLOCKS = tuple(f"B{i}" for i in range(1, 15))
BLOCK_SET = frozenset(BLOCKS)


@dataclass(frozen=True)
class Segment:
    """A directed run from one station to the next."""

    start: str
    end: str
    blocks: tuple[str, ...]


# Each line of the spec's adjacency list; the two two-way lines count twice.
SEGMENTS = (
    Segment("Y", "P1A", ("B1",)),
    Segment("P1A", "Y", ("B1",)),
    Segment("Y", "P1B", ("B2",)),
    Segment("P1B", "Y", ("B2",)),
    Segment("P1A", "P2A", ("B3", "B5")),
    Segment("P1B", "P2A", ("B4", "B5")),
    Segment("P2A", "P3A", ("B6", "B7")),
    Segment("P2A", "P3B", ("B6", "B8")),
    Segment("P3A", "P2B", ("B10", "B11")),
    Segment("P3B", "P2B", ("B9", "B11")),
    Segment("P2B", "P1B", ("B12", "B14")),
    Segment("P2B", "P1A", ("B12", "B13")),
)

# No two segments share the same start and end, so the stations alone
# determine which blocks a service passes through.
_SEGMENT_BY_ENDS = {(s.start, s.end): s for s in SEGMENTS}
assert len(_SEGMENT_BY_ENDS) == len(SEGMENTS)

INTERLOCKING_GROUPS: dict[int, tuple[str, ...]] = {
    1: ("B1", "B2"),
    2: ("B3", "B4", "B13", "B14"),
    3: ("B7", "B8", "B9", "B10"),
}
GROUP_OF_BLOCK = {
    block: group for group, blocks in INTERLOCKING_GROUPS.items() for block in blocks
}


def find_segment(start: str, end: str) -> Segment | None:
    return _SEGMENT_BY_ENDS.get((start, end))
