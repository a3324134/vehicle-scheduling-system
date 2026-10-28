"""Initial tables.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATIONS = ("Y", "P1A", "P1B", "P2A", "P2B", "P3A", "P3B")


def upgrade() -> None:
    op.create_table(
        "vehicles",
        sa.Column("id", sa.String(8), primary_key=True),
    )
    op.create_table(
        "blocks",
        sa.Column("id", sa.String(4), primary_key=True),
        sa.Column("traversal_seconds", sa.Integer, nullable=False),
        sa.CheckConstraint("traversal_seconds >= 1", name="ck_blocks_traversal_positive"),
    )
    op.create_table(
        "services",
        sa.Column("id", sa.Integer, sa.Identity(start=101), primary_key=True),
        sa.Column("vehicle_id", sa.String(8), sa.ForeignKey("vehicles.id"), nullable=False),
    )
    op.create_table(
        "service_stops",
        sa.Column(
            "service_id",
            sa.Integer,
            sa.ForeignKey("services.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("seq", sa.Integer, primary_key=True),
        sa.Column("station", sa.String(4), nullable=False),
        sa.Column("departure", sa.Time, nullable=True),
        sa.CheckConstraint(
            "station IN ({})".format(", ".join(f"'{s}'" for s in STATIONS)),
            name="ck_service_stops_station",
        ),
    )


def downgrade() -> None:
    op.drop_table("service_stops")
    op.drop_table("services")
    op.drop_table("blocks")
    op.drop_table("vehicles")
