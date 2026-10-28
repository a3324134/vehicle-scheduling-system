"""Reads and writes, converting between rows and domain data."""

from collections.abc import Mapping, Sequence

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.db.models import BlockRow, ServiceRow, ServiceStopRow, VehicleRow
from app.domain.models import Service, Stop
from app.domain.timefmt import seconds_to_time, time_to_seconds


def list_vehicle_ids(session: Session) -> list[str]:
    return list(session.scalars(select(VehicleRow.id).order_by(VehicleRow.id)))


def vehicle_exists(session: Session, vehicle_id: str) -> bool:
    return session.get(VehicleRow, vehicle_id) is not None


def list_blocks(session: Session) -> list[BlockRow]:
    rows = session.scalars(select(BlockRow)).all()
    # B1, B2, ..., B14 rather than B1, B10, B11, ...
    return sorted(rows, key=lambda row: int(row.id[1:]))


def get_block_times(session: Session) -> dict[str, int]:
    return {row.id: row.traversal_seconds for row in session.scalars(select(BlockRow))}


def replace_block_times(session: Session, traversal_seconds: Mapping[str, int]) -> None:
    """Update every given block in one commit."""
    for row in session.scalars(select(BlockRow)):
        row.traversal_seconds = traversal_seconds[row.id]
    session.commit()


def list_services(session: Session) -> list[Service]:
    rows = session.scalars(
        select(ServiceRow).options(selectinload(ServiceRow.stops)).order_by(ServiceRow.id)
    )
    return [_to_service(row) for row in rows]


def get_service(session: Session, service_id: int) -> Service | None:
    row = session.get(ServiceRow, service_id)
    return _to_service(row) if row is not None else None


def create_service(session: Session, vehicle_id: str, stops: Sequence[Stop]) -> Service:
    row = ServiceRow(vehicle_id=vehicle_id, stops=_to_stop_rows(stops))
    session.add(row)
    session.commit()
    return _to_service(row)


def replace_service(
    session: Session, service_id: int, vehicle_id: str, stops: Sequence[Stop]
) -> Service | None:
    row = session.get(ServiceRow, service_id)
    if row is None:
        return None
    row.vehicle_id = vehicle_id
    row.stops.clear()
    # Delete the old stops before inserting new ones with the same keys.
    session.flush()
    row.stops.extend(_to_stop_rows(stops))
    session.commit()
    return _to_service(row)


def delete_services(session: Session, service_ids: Sequence[int]) -> list[int]:
    """Delete these services in one commit, or none of them if any is missing.
    Returns the missing ids."""
    wanted = set(service_ids)
    found = set(session.scalars(select(ServiceRow.id).where(ServiceRow.id.in_(wanted))))
    missing = sorted(wanted - found)
    if missing:
        return missing
    # Their stops go with them (ON DELETE CASCADE).
    session.execute(delete(ServiceRow).where(ServiceRow.id.in_(wanted)))
    session.commit()
    return []


def replace_all_services(session: Session, services: Sequence[tuple[str, Sequence[Stop]]]) -> int:
    """Delete every service and add these in one commit.
    Returns how many were deleted."""
    deleted = session.execute(delete(ServiceRow)).rowcount
    session.add_all(ServiceRow(vehicle_id=vehicle, stops=_to_stop_rows(stops)) for vehicle, stops in services)
    session.commit()
    return deleted


def _to_stop_rows(stops: Sequence[Stop]) -> list[ServiceStopRow]:
    return [
        ServiceStopRow(
            seq=i,
            station=stop.at,
            departure=seconds_to_time(stop.departure) if stop.departure is not None else None,
        )
        for i, stop in enumerate(stops)
    ]


def _to_service(row: ServiceRow) -> Service:
    stops = tuple(
        Stop(s.station, time_to_seconds(s.departure) if s.departure is not None else None)
        for s in row.stops
    )
    return Service(row.id, row.vehicle_id, stops)
