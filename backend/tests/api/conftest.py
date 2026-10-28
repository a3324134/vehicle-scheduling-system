"""API tests run against the PostgreSQL in Docker Compose, in a separate database
(TEST_DATABASE_URL in docker-compose.yml): docker compose run --rm --build backend pytest
"""

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text, update
from sqlalchemy.orm import sessionmaker

from app.db.models import BlockRow
from app.db.seed import seed
from app.db.session import get_session
from app.main import create_app
from tests.helpers import TEST_BLOCK_SECONDS

ROOT = Path(__file__).resolve().parents[2]
TEST_DATABASE_URL = os.environ["TEST_DATABASE_URL"]


def _create_database_if_missing(url: str) -> None:
    target = make_url(url)
    admin = create_engine(target.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        exists = conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": target.database}
        )
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{target.database}"'))
    admin.dispose()


def _migrate(url: str) -> None:
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    command.upgrade(config, "head")


@pytest.fixture(scope="session")
def engine():
    _create_database_if_missing(TEST_DATABASE_URL)
    _migrate(TEST_DATABASE_URL)
    engine = create_engine(TEST_DATABASE_URL)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(engine):
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE service_stops, services, blocks, vehicles RESTART IDENTITY CASCADE"))
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory() as session:
        seed(session)
        # The tests' own block time, whatever the seeded default is (tests/helpers.py).
        session.execute(update(BlockRow).values(traversal_seconds=TEST_BLOCK_SECONDS))
        session.commit()
    return factory


@pytest.fixture
def client(session_factory):
    app = create_app()

    def override():
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    with TestClient(app) as test_client:
        yield test_client
