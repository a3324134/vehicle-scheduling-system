#!/bin/sh
# Create or update the tables, insert the initial data, then start the API.
# The first two steps are safe to repeat on every start.
set -e
alembic upgrade head
python -m app.db.seed
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
