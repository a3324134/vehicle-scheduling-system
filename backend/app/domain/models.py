"""Plain data passed into and out of the scheduling rules.

Times are seconds since midnight.
"""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Stop:
    at: str
    # Every stop except the last has a departure. The first stop has no
    # arrival and the last no departure: those times belong to the services
    # before and after.
    departure: int | None = None


@dataclass(frozen=True)
class Service:
    id: int
    vehicle: str
    stops: tuple[Stop, ...]


@dataclass(frozen=True)
class FieldError:
    """A reason to reject a request, pointing at the offending field."""

    loc: tuple[str | int, ...]
    msg: str
    type: str


@dataclass(frozen=True)
class Conflict:
    """A problem that is saved but flagged."""

    type: str
    services: tuple[int, ...]
    resources: tuple[str, ...] = ()
    start: int | None = None
    end: int | None = None
    detail: dict[str, Any] | None = None
