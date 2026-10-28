"""Initial data: the fixed fleet and default block times.

Safe to run on every start: existing rows are left untouched.
"""

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import BlockRow, VehicleRow
from app.domain.params import DEFAULT_TRAVERSAL_SECONDS
from app.domain.track import BLOCKS

VEHICLES = ("V1", "V2", "V3", "V4", "V5")


def seed(session: Session) -> None:
    session.execute(
        insert(VehicleRow).values([{"id": v} for v in VEHICLES]).on_conflict_do_nothing()
    )
    session.execute(
        insert(BlockRow)
        .values([{"id": b, "traversal_seconds": DEFAULT_TRAVERSAL_SECONDS} for b in BLOCKS])
        .on_conflict_do_nothing()
    )
    session.commit()


if __name__ == "__main__":
    from app.db.session import SessionLocal

    with SessionLocal() as session:
        seed(session)
