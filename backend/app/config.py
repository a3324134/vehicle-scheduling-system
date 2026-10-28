import os


def database_url() -> str:
    # Set by docker-compose.yml.
    return os.environ["DATABASE_URL"]
