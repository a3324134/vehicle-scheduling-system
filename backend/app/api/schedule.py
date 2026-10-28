"""Bonus 3: generate the whole schedule."""

from typing import Annotated, NoReturn

from fastapi import APIRouter, Query

from app.api.deps import SessionDep
from app.api.errors import RequestRejected
from app.api.schemas import CLOCK_MINUTES_PATTERN, GeneratedOut, GenerateIn, ScheduleLimitsOut
from app.db import repository
from app.domain.generate import GenerationFailed, generate, longest_interval, shortest_interval
from app.domain.models import FieldError

router = APIRouter()

Clock = Annotated[str, Query(pattern=CLOCK_MINUTES_PATTERN)]


@router.get("/schedule/limits", response_model=ScheduleLimitsOut)
def schedule_limits(start: Clock, end: Clock, session: SessionDep) -> ScheduleLimitsOut:
    """What the Auto-generate tab shows while the user types."""
    first, last = _time_range(start, end, location="query")
    block_times = repository.get_block_times(session)
    vehicles = repository.list_vehicle_ids(session)
    minutes, reason = shortest_interval(first, last, block_times, vehicles)
    return ScheduleLimitsOut(
        shortest_interval_minutes=minutes,
        longest_interval_minutes=longest_interval(first, last),
        reason=reason,
    )


@router.post("/schedule/generate", response_model=GeneratedOut)
def generate_schedule(body: GenerateIn, session: SessionDep) -> GeneratedOut:
    """Replace every service with a generated schedule, or change nothing."""
    first, last = _time_range(body.start, body.end, location="body")
    longest = longest_interval(first, last)
    if body.interval_minutes > longest:
        _reject(f"The interval can be at most {longest} min for this time range", "interval_too_long")

    block_times = repository.get_block_times(session)
    vehicles = repository.list_vehicle_ids(session)
    try:
        generated = generate(body.interval_minutes * 60, first, last, block_times, vehicles)
    except GenerationFailed as failed:
        _explain(failed, body.interval_minutes, first, last, block_times, vehicles)

    replaced = repository.replace_all_services(session, generated.services)
    return GeneratedOut(
        services=len(generated.services),
        replaced=replaced,
        vehicles=sorted({vehicle for vehicle, _ in generated.services}),
        route=list(generated.route.lap),
        gap_seconds=list(generated.gap),
    )


def _explain(failed: GenerationFailed, minutes: int, first: int, last: int, block_times, vehicles) -> NoReturn:
    shortest, reason = shortest_interval(first, last, block_times, vehicles)
    if shortest is None:
        _reject(f"No schedule is possible for this time range: {reason}", "no_schedule")
    if minutes < shortest:
        _reject(
            f"The interval must be at least {shortest} min with the current block times: {failed.reason}",
            "interval_too_short",
        )
    # Rare: a longer interval can fail where a shorter one works.
    _reject(f"Can't generate with {minutes} min: {failed.reason}. Try another interval.", "generation_failed")


def _time_range(start: str, end: str, location: str) -> tuple[int, int]:
    first, last = _minutes_of_day(start), _minutes_of_day(end)
    if last <= first:
        raise RequestRejected([FieldError(("end",), "End must be later than start", "invalid_range")], location)
    return first, last


def _minutes_of_day(text: str) -> int:
    hours, minutes = (int(part) for part in text.split(":"))
    return hours * 3600 + minutes * 60


def _reject(msg: str, kind: str) -> NoReturn:
    raise RequestRejected([FieldError(("interval_minutes",), msg, kind)])
