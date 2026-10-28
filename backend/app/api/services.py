from collections.abc import Mapping

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy.orm import Session

from app.api.deps import SessionDep
from app.api.errors import RequestRejected
from app.api.schemas import ServiceIdsIn, ServiceIn, ServiceOut, StopOut
from app.db import repository
from app.domain.models import FieldError, Service, Stop
from app.domain.timefmt import format_hms, parse_hms
from app.domain.timeline import compute_service
from app.domain.validate import validate_stops

router = APIRouter()


@router.get("/services", response_model=list[ServiceOut])
def list_services(session: SessionDep) -> list[ServiceOut]:
    block_times = repository.get_block_times(session)
    return [_to_out(s, block_times) for s in repository.list_services(session)]


@router.get("/services/{service_id}", response_model=ServiceOut)
def get_service(service_id: int, session: SessionDep) -> ServiceOut:
    service = repository.get_service(session, service_id)
    if service is None:
        raise _not_found(service_id)
    return _to_out(service, repository.get_block_times(session))


@router.post("/services", response_model=ServiceOut, status_code=201)
def create_service(body: ServiceIn, session: SessionDep) -> ServiceOut:
    block_times = repository.get_block_times(session)
    stops = _validated_stops(body, session, block_times)
    service = repository.create_service(session, body.vehicle, stops)
    return _to_out(service, block_times)


@router.put("/services/{service_id}", response_model=ServiceOut)
def replace_service(service_id: int, body: ServiceIn, session: SessionDep) -> ServiceOut:
    if repository.get_service(session, service_id) is None:
        raise _not_found(service_id)
    block_times = repository.get_block_times(session)
    stops = _validated_stops(body, session, block_times)
    service = repository.replace_service(session, service_id, body.vehicle, stops)
    return _to_out(service, block_times)


@router.post("/services/delete", status_code=204)
def delete_services(body: ServiceIdsIn, session: SessionDep) -> Response:
    # Deleting is always allowed, even if it leaves a gap.
    # One commit: if any service is missing, nothing is deleted.
    missing = repository.delete_services(session, body.ids)
    if missing:
        ids = ", ".join(map(str, missing))
        noun = "Service" if len(missing) == 1 else "Services"
        raise HTTPException(status_code=404, detail=f"{noun} {ids} not found; nothing was deleted")
    return Response(status_code=204)


def _validated_stops(body: ServiceIn, session: Session, block_times: Mapping[str, int]) -> list[Stop]:
    errors: list[FieldError] = []
    if not repository.vehicle_exists(session, body.vehicle):
        errors.append(FieldError(("vehicle",), f"Vehicle {body.vehicle} is not in the fleet", "unknown_vehicle"))
    stops = [
        Stop(s.at, parse_hms(s.departure) if s.departure is not None else None) for s in body.stops
    ]
    errors.extend(validate_stops(stops, block_times))
    if errors:
        raise RequestRejected(errors)
    return stops


def _to_out(service: Service, block_times: Mapping[str, int]) -> ServiceOut:
    computed = compute_service(service, block_times)
    return ServiceOut(
        id=service.id,
        vehicle=service.vehicle,
        path=list(computed.path),
        stops=[
            StopOut(
                at=stop.at,
                arrival=_fmt(arrival),
                departure=_fmt(stop.departure),
            )
            for stop, arrival in zip(service.stops, computed.arrivals)
        ],
    )


def _fmt(seconds: int | None) -> str | None:
    return format_hms(seconds) if seconds is not None else None


def _not_found(service_id: int) -> HTTPException:
    return HTTPException(status_code=404, detail=f"Service {service_id} not found")
