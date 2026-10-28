"""Our own 422 errors use FastAPI's default shape, so the frontend handles
both kinds the same way."""

from fastapi import Request
from fastapi.responses import JSONResponse

from app.domain.models import FieldError


class RequestRejected(Exception):
    def __init__(self, errors: list[FieldError], location: str = "body"):
        super().__init__(errors)
        self.errors = errors
        self.location = location  # "body" or "query", as FastAPI reports them


async def request_rejected_handler(request: Request, exc: RequestRejected) -> JSONResponse:
    detail = [{"loc": [exc.location, *e.loc], "msg": e.msg, "type": e.type} for e in exc.errors]
    return JSONResponse(status_code=422, content={"detail": detail})
