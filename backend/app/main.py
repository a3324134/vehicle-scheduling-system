from fastapi import FastAPI

from app.api import blocks, conflicts, reference, schedule, services, timeline
from app.api.errors import RequestRejected, request_rejected_handler


def create_app() -> FastAPI:
    app = FastAPI(title="Vehicle Scheduling API")
    app.add_exception_handler(RequestRejected, request_rejected_handler)
    for module in (reference, services, blocks, conflicts, timeline, schedule):
        app.include_router(module.router, prefix="/api")

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
