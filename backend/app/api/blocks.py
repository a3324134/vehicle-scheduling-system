from fastapi import APIRouter

from app.api.deps import SessionDep
from app.api.errors import RequestRejected
from app.api.schemas import BlockIn, BlockOut
from app.db import repository
from app.domain.models import FieldError
from app.domain.track import BLOCKS

router = APIRouter()


@router.get("/blocks", response_model=list[BlockOut])
def list_blocks(session: SessionDep) -> list[BlockOut]:
    return [BlockOut(id=b.id, traversal_seconds=b.traversal_seconds) for b in repository.list_blocks(session)]


@router.put("/blocks", response_model=list[BlockOut])
def replace_blocks(body: list[BlockIn], session: SessionDep) -> list[BlockOut]:
    """Replace all 14 traversal times at once, so a save never half applies.

    Never rejected for the conflicts it causes; those are flagged instead.
    """
    errors = _check_every_block_once(body)
    if errors:
        raise RequestRejected(errors)
    repository.replace_block_times(session, {b.id: b.traversal_seconds for b in body})
    return list_blocks(session)


def _check_every_block_once(body: list[BlockIn]) -> list[FieldError]:
    errors = []
    seen = set()
    for i, block in enumerate(body):
        if block.id in seen:
            errors.append(FieldError((i, "id"), f"{block.id} is listed more than once", "duplicate_block"))
        seen.add(block.id)
    missing = [b for b in BLOCKS if b not in seen]
    if missing:
        errors.append(FieldError((), f"Missing blocks: {', '.join(missing)}", "missing_block"))
    return errors
