"""Tables.

Only what users enter is stored. Arrival times, battery and conflicts are
computed on every read.
"""

from datetime import time

from sqlalchemy import CheckConstraint, ForeignKey, Identity, Integer, String, Time
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.domain.track import STATIONS

STATION_CHECK = "station IN ({})".format(", ".join(f"'{s}'" for s in STATIONS))


class Base(DeclarativeBase):
    pass


class VehicleRow(Base):
    __tablename__ = "vehicles"

    id: Mapped[str] = mapped_column(String(8), primary_key=True)


class BlockRow(Base):
    __tablename__ = "blocks"
    __table_args__ = (CheckConstraint("traversal_seconds >= 1", name="ck_blocks_traversal_positive"),)

    id: Mapped[str] = mapped_column(String(4), primary_key=True)
    traversal_seconds: Mapped[int] = mapped_column(Integer)


class ServiceRow(Base):
    __tablename__ = "services"

    id: Mapped[int] = mapped_column(Integer, Identity(start=101), primary_key=True)
    vehicle_id: Mapped[str] = mapped_column(ForeignKey("vehicles.id"))
    stops: Mapped[list["ServiceStopRow"]] = relationship(
        order_by="ServiceStopRow.seq",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ServiceStopRow(Base):
    """One stop of a service. Blocks in between are derived from the stations."""

    __tablename__ = "service_stops"
    __table_args__ = (CheckConstraint(STATION_CHECK, name="ck_service_stops_station"),)

    service_id: Mapped[int] = mapped_column(
        ForeignKey("services.id", ondelete="CASCADE"), primary_key=True
    )
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    station: Mapped[str] = mapped_column(String(4))
    departure: Mapped[time | None] = mapped_column(Time)
