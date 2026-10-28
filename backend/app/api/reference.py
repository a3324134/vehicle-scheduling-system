"""Read-only data the frontend needs: the track layout and the fleet."""

from fastapi import APIRouter

from app.api.deps import SessionDep
from app.api.schemas import InterlockingGroupOut, SegmentOut, TrackOut, VehicleOut
from app.db import repository
from app.domain.track import BLOCKS, INTERLOCKING_GROUPS, SEGMENTS, STATIONS

router = APIRouter()


@router.get("/track", response_model=TrackOut)
def get_track() -> TrackOut:
    return TrackOut(
        stations=list(STATIONS),
        blocks=list(BLOCKS),
        segments=[SegmentOut(start=s.start, end=s.end, blocks=list(s.blocks)) for s in SEGMENTS],
        interlocking_groups=[
            InterlockingGroupOut(id=group, blocks=list(blocks))
            for group, blocks in INTERLOCKING_GROUPS.items()
        ],
    )


@router.get("/vehicles", response_model=list[VehicleOut])
def list_vehicles(session: SessionDep) -> list[VehicleOut]:
    return [VehicleOut(id=v) for v in repository.list_vehicle_ids(session)]
