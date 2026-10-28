from fastapi import APIRouter

from app.api.deps import SessionDep
from app.api.schemas import IntervalOut, TimelineOut
from app.db import repository
from app.domain.timeline import build_timelines, build_vehicle_timeline

router = APIRouter()


@router.get("/timeline", response_model=list[TimelineOut])
def get_timeline(session: SessionDep) -> list[TimelineOut]:
    """Where every vehicle is all day, for the viewer's simulation."""
    timelines = build_timelines(repository.list_services(session), repository.get_block_times(session))
    result = []
    for vehicle in repository.list_vehicle_ids(session):
        # A vehicle without services spends the day in the yard.
        timeline = timelines.get(vehicle) or build_vehicle_timeline(vehicle, [])
        intervals = sorted(timeline.intervals, key=lambda i: (i.start, i.end))
        result.append(
            TimelineOut(
                vehicle=vehicle,
                intervals=[
                    IntervalOut(
                        at=i.at,
                        toward=i.toward,
                        start=i.start,
                        end=i.end,
                        service=i.service,
                        gap=i.gap,
                        battery_start=i.battery_start,
                        battery_end=i.battery_end,
                    )
                    for i in intervals
                ],
            )
        )
    return result
