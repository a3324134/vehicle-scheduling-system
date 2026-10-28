from fastapi import APIRouter

from app.api.deps import SessionDep
from app.api.schemas import ConflictOut
from app.db import repository
from app.domain.conflicts import detect_conflicts
from app.domain.timefmt import format_hms

router = APIRouter()


@router.get("/conflicts", response_model=list[ConflictOut])
def list_conflicts(session: SessionDep) -> list[ConflictOut]:
    # Computed on every read, so it always matches the current data.
    conflicts = detect_conflicts(repository.list_services(session), repository.get_block_times(session))
    return [
        ConflictOut(
            type=c.type,
            services=list(c.services),
            resources=list(c.resources),
            start=format_hms(c.start) if c.start is not None else None,
            end=format_hms(c.end) if c.end is not None else None,
            detail=c.detail,
        )
        for c in conflicts
    ]
