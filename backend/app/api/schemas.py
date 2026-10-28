"""Request and response bodies."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Station = Literal["Y", "P1A", "P1B", "P2A", "P2B", "P3A", "P3B"]
BlockId = Literal[
    "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13", "B14"
]

# Departures are entered within one day, so hours stop at 23.
CLOCK_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$"
# The time range for generating a schedule, to the minute.
CLOCK_MINUTES_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class StopIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    at: Station
    departure: str | None = Field(default=None, pattern=CLOCK_PATTERN)


class ServiceIn(BaseModel):
    """Only the stations are sent; blocks in between are derived."""

    model_config = ConfigDict(extra="forbid")

    vehicle: str
    stops: list[StopIn]


class ServiceIdsIn(BaseModel):
    """Services to delete together."""

    model_config = ConfigDict(extra="forbid")

    ids: list[int] = Field(min_length=1)


class StopOut(BaseModel):
    at: str
    arrival: str | None
    departure: str | None


class ServiceOut(BaseModel):
    id: int
    vehicle: str
    path: list[str]
    stops: list[StopOut]


class BlockOut(BaseModel):
    id: str
    traversal_seconds: int


class BlockIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: BlockId
    traversal_seconds: int = Field(ge=1)


class VehicleOut(BaseModel):
    id: str


class SegmentOut(BaseModel):
    start: str
    end: str
    blocks: list[str]


class InterlockingGroupOut(BaseModel):
    id: int
    blocks: list[str]


class TrackOut(BaseModel):
    stations: list[str]
    blocks: list[str]
    segments: list[SegmentOut]
    interlocking_groups: list[InterlockingGroupOut]


class IntervalOut(BaseModel):
    """Times are seconds since midnight, handy for animation."""

    at: str
    toward: str | None
    start: int
    end: int
    service: int | None
    gap: str | None
    battery_start: int | None
    battery_end: int | None


class TimelineOut(BaseModel):
    vehicle: str
    intervals: list[IntervalOut]


class ConflictOut(BaseModel):
    type: str
    services: list[int]
    resources: list[str]
    start: str | None
    end: str | None
    detail: dict[str, Any] | None


class GenerateIn(BaseModel):
    """What the Auto-generate tab sends (Bonus 3)."""

    model_config = ConfigDict(extra="forbid")

    interval_minutes: int = Field(ge=1)
    start: str = Field(pattern=CLOCK_MINUTES_PATTERN)
    end: str = Field(pattern=CLOCK_MINUTES_PATTERN)


class ScheduleLimitsOut(BaseModel):
    shortest_interval_minutes: int | None
    longest_interval_minutes: int
    # Why one minute less than the shortest fails, or why nothing works.
    reason: str | None


class GeneratedOut(BaseModel):
    services: int
    replaced: int
    vehicles: list[str]
    route: list[str]
    # Seconds between vehicles: [shortest, longest]. Can be less than the
    # interval, since every stop has the same fixed dwell.
    gap_seconds: list[int]
