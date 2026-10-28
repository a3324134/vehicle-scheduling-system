"""The API through FastAPI and a real PostgreSQL, plus a few checks of the HTTP layer."""

from sqlalchemy import delete, func, select

from app.db.models import BlockRow, VehicleRow
from app.db.seed import VEHICLES, seed
from app.domain.generate import generate, shortest_interval
from app.domain.params import DEFAULT_TRAVERSAL_SECONDS, MIN_DWELL_SECONDS
from app.domain.timefmt import format_hms
from app.domain.track import BLOCKS
from tests.helpers import BLOCK_TIMES, TEST_BLOCK_SECONDS, t


def stop(at, departure=None):
    return {"at": at, "departure": departure} if departure else {"at": at}


def body(vehicle, *stops):
    return {"vehicle": vehicle, "stops": list(stops)}


YARD_TO_P2A = body("V1", stop("Y", "08:00:00"), stop("P1A", "08:02:00"), stop("P2A"))


def all_blocks(**changes):
    """All 14 blocks at the tests' 60 seconds, except the given ones: all_blocks(B3=90)."""
    return [{"id": b, "traversal_seconds": changes.get(b, TEST_BLOCK_SECONDS)} for b in BLOCKS]


def block_times(client):
    return {b["id"]: b["traversal_seconds"] for b in client.get("/api/blocks").json()}


def test_returns_the_full_path_from_the_stations_sent(client):
    created = client.post("/api/services", json=YARD_TO_P2A)
    assert created.status_code == 201
    expected = {
        "id": 101,
        "vehicle": "V1",
        "path": ["Y", "B1", "P1A", "B3", "B5", "P2A"],
        "stops": [
            {"at": "Y", "arrival": None, "departure": "08:00:00"},
            {"at": "P1A", "arrival": "08:01:00", "departure": "08:02:00"},
            {"at": "P2A", "arrival": "08:04:00", "departure": None},
        ],
    }
    assert created.json() == expected
    assert client.get("/api/services/101").json() == expected
    assert client.get("/api/services").json() == [expected]


def test_numbers_services_from_101(client):
    assert client.post("/api/services", json=YARD_TO_P2A).json()["id"] == 101
    assert client.post("/api/services", json=YARD_TO_P2A).json()["id"] == 102


def test_rejects_an_unknown_vehicle(client):
    response = client.post("/api/services", json={**YARD_TO_P2A, "vehicle": "V9"})
    assert response.status_code == 422
    assert response.json()["detail"] == [
        {"loc": ["body", "vehicle"], "msg": "Vehicle V9 is not in the fleet", "type": "unknown_vehicle"}
    ]


def test_rejects_an_unknown_station(client):
    response = client.post("/api/services", json=body("V1", stop("P9A", "08:00:00"), stop("P1A")))
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "stops", 0, "at"]


def test_rejects_a_block_time_under_one_second(client):
    response = client.put("/api/blocks", json=all_blocks(B3=90, B5=0))
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", 4, "traversal_seconds"]
    # Nothing is saved, not even the valid B3.
    assert block_times(client) == BLOCK_TIMES


def test_saves_a_block_change_and_flags_its_conflicts(client):
    # 30 seconds at P1A; a 120-second B1 makes the vehicle arrive as it should leave.
    client.post("/api/services", json=body("V1", stop("Y", "08:00:00"), stop("P1A", "08:01:30"), stop("P2A")))
    assert client.put("/api/blocks", json=all_blocks(B1=120)).status_code == 200
    dwell = [c for c in client.get("/api/conflicts").json() if c["type"] == "dwell_too_short"]
    assert dwell == [
        {
            "type": "dwell_too_short",
            "services": [101],
            "resources": ["P1A"],
            "start": "08:02:00",
            "end": "08:01:30",
            "detail": None,
        }
    ]


def test_deletes_a_middle_service_and_flags_the_gap(client):
    client.post("/api/services", json=YARD_TO_P2A)
    client.post("/api/services", json=body("V1", stop("P2A", "08:10:00"), stop("P3A", "08:14:00"), stop("P2B")))
    client.post("/api/services", json=body("V1", stop("P2B", "08:20:00"), stop("P1A", "08:24:00"), stop("Y")))
    assert [c["type"] for c in client.get("/api/conflicts").json()] == []

    assert client.post("/api/services/delete", json={"ids": [102]}).status_code == 204
    gaps = [c for c in client.get("/api/conflicts").json() if c["type"] == "discontinuity"]
    assert [(c["services"], c["resources"]) for c in gaps] == [([101, 103], ["P2A", "P2B"])]


def test_seeds_only_once_when_run_twice(session_factory):
    with session_factory() as session:
        seed(session)
        seed(session)
        assert session.scalar(select(func.count()).select_from(VehicleRow)) == 5
        assert session.scalar(select(func.count()).select_from(BlockRow)) == 14


def test_seeds_new_blocks_with_the_default_time(session_factory):
    # The other tests set every block to their own 60 seconds; a new database
    # gets DEFAULT_TRAVERSAL_SECONDS.
    with session_factory() as session:
        session.execute(delete(BlockRow))
        seed(session)
        times = session.scalars(select(BlockRow.traversal_seconds)).all()
    assert times == [DEFAULT_TRAVERSAL_SECONDS] * 14


def test_rejects_blocks_not_sent_exactly_once_each(client):
    blocks = all_blocks()
    cases = {
        "missing": (blocks[:-1], [{"loc": ["body"], "msg": "Missing blocks: B14", "type": "missing_block"}]),
        "duplicate": (
            [*blocks, blocks[0]],
            [{"loc": ["body", 14, "id"], "msg": "B1 is listed more than once", "type": "duplicate_block"}],
        ),
    }
    for sent, expected in cases.values():
        response = client.put("/api/blocks", json=sent)
        assert response.status_code == 422
        assert response.json()["detail"] == expected

    unknown = client.put("/api/blocks", json=[*blocks[:-1], {"id": "B15", "traversal_seconds": 60}])
    assert unknown.status_code == 422
    assert unknown.json()["detail"][0]["loc"] == ["body", 13, "id"]
    assert block_times(client) == BLOCK_TIMES


def test_saves_all_blocks_changing_only_what_differs(client):
    response = client.put("/api/blocks", json=all_blocks(B3=90, B5=45))
    assert response.status_code == 200
    assert response.json() == client.get("/api/blocks").json()
    assert block_times(client) == {**BLOCK_TIMES, "B3": 90, "B5": 45}


def test_returns_a_timeline_for_the_whole_fleet(client):
    client.post("/api/services", json=YARD_TO_P2A)
    timeline = client.get("/api/timeline").json()
    assert [v["vehicle"] for v in timeline] == ["V1", "V2", "V3", "V4", "V5"]
    v1 = timeline[0]["intervals"]
    assert v1[1] == {
        "at": "B1",
        "toward": "P1A",
        "start": 28800,
        "end": 28860,
        "service": 101,
        "gap": None,
        "battery_start": 79,
        "battery_end": 79,
    }
    assert v1[-1]["gap"] == "not_returned"
    assert timeline[1]["intervals"] == [
        {
            "at": "Y",
            "toward": None,
            "start": 0,
            "end": 86400,
            "service": None,
            "gap": None,
            "battery_start": 80,
            "battery_end": 80,
        }
    ]


def test_rejects_a_short_dwell_pointing_at_the_field(client):
    # At P1A from 08:01:00; leaving one second before the shortest dwell is up.
    earliest = t("08:01:00") + MIN_DWELL_SECONDS
    too_early = format_hms(earliest - 1)
    response = client.post("/api/services", json=body("V1", stop("Y", "08:00:00"), stop("P1A", too_early), stop("P2A")))
    assert response.status_code == 422
    assert response.json()["detail"] == [
        {
            "loc": ["body", "stops", 1, "departure"],
            "msg": f"Departure must be {format_hms(earliest)} or later",
            "type": "dwell_too_short",
        }
    ]


def test_rejects_a_bad_time_format(client):
    response = client.post("/api/services", json=body("V1", stop("Y", "8點"), stop("P1A")))
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "stops", 0, "departure"]


def test_replaces_a_service_and_returns_404_when_missing(client):
    client.post("/api/services", json=YARD_TO_P2A)
    replaced = client.put(
        "/api/services/101", json=body("V2", stop("Y", "09:00:00"), stop("P1B", "09:02:00"), stop("Y"))
    )
    assert replaced.status_code == 200
    assert replaced.json()["vehicle"] == "V2"
    assert replaced.json()["path"] == ["Y", "B2", "P1B", "B2", "Y"]
    assert client.put("/api/services/999", json=YARD_TO_P2A).status_code == 404
    assert client.get("/api/services/999").status_code == 404


def test_returns_ok_from_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_returns_the_track_fleet_and_blocks(client):
    track = client.get("/api/track").json()
    assert len(track["segments"]) == 12
    assert {"id": 2, "blocks": ["B3", "B4", "B13", "B14"]} in track["interlocking_groups"]
    assert [v["id"] for v in client.get("/api/vehicles").json()] == ["V1", "V2", "V3", "V4", "V5"]
    blocks = client.get("/api/blocks").json()
    assert [b["id"] for b in blocks][:3] == ["B1", "B2", "B3"]
    assert {b["id"]: b["traversal_seconds"] for b in blocks} == BLOCK_TIMES


# --- Bonus 3: generating the schedule ---

DAY = {"start": "08:00", "end": "18:00"}
# What the generator itself says for the tests' blocks and the seeded fleet. The
# API should pass it on as is; the numbers are tested in tests/domain/test_generate.py.
SHORTEST, WHY = shortest_interval(t("08:00:00"), t("18:00:00"), BLOCK_TIMES, VEHICLES)


def test_returns_the_shortest_interval_and_why(client):
    response = client.get("/api/schedule/limits", params=DAY)
    assert response.status_code == 200
    assert response.json() == {
        "shortest_interval_minutes": SHORTEST,
        "longest_interval_minutes": 600,
        "reason": WHY,
    }


def test_generates_a_schedule_replacing_every_service(client):
    client.post("/api/services", json=YARD_TO_P2A)
    response = client.post("/api/schedule/generate", json={"interval_minutes": SHORTEST, **DAY})
    assert response.status_code == 200
    result = response.json()
    assert result["replaced"] == 1
    generated = generate(SHORTEST * 60, t("08:00:00"), t("18:00:00"), BLOCK_TIMES, VEHICLES)
    assert result["services"] == len(generated.services)
    assert result["gap_seconds"] == list(generated.gap)
    services = client.get("/api/services").json()
    assert len(services) == result["services"]
    assert 101 not in [s["id"] for s in services]
    assert services[0]["stops"][0] == {"at": "Y", "arrival": None, "departure": "08:00:00"}
    assert client.get("/api/conflicts").json() == []


def test_rejects_too_short_an_interval_and_changes_nothing(client):
    client.post("/api/services", json=YARD_TO_P2A)
    response = client.post("/api/schedule/generate", json={"interval_minutes": SHORTEST - 1, **DAY})
    assert response.status_code == 422
    assert response.json()["detail"] == [
        {
            "loc": ["body", "interval_minutes"],
            "msg": f"The interval must be at least {SHORTEST} min with the current block times: {WHY}",
            "type": "interval_too_short",
        }
    ]
    assert [s["id"] for s in client.get("/api/services").json()] == [101]


def test_rejects_a_bad_time_range_or_interval(client):
    backwards = {"start": "18:00", "end": "08:00"}
    response = client.post("/api/schedule/generate", json={"interval_minutes": 6, **backwards})
    assert response.json()["detail"] == [
        {"loc": ["body", "end"], "msg": "End must be later than start", "type": "invalid_range"}
    ]
    response = client.get("/api/schedule/limits", params=backwards)
    assert response.json()["detail"][0]["loc"] == ["query", "end"]

    response = client.post("/api/schedule/generate", json={"interval_minutes": 61, "start": "08:00", "end": "09:00"})
    assert response.json()["detail"][0]["type"] == "interval_too_long"

    # 24-hour HH:MM only.
    assert client.post("/api/schedule/generate", json={"interval_minutes": 6, "start": "8am", "end": "18:00"}).status_code == 422
    assert client.get("/api/schedule/limits", params={"start": "08:00", "end": "24:00"}).status_code == 422


def test_rejects_a_time_range_with_no_possible_schedule(client):
    # Too close to midnight for any interval; the API passes on the generator's reason
    # (see test_fails_when_the_last_vehicles_would_be_back_after_midnight).
    none, why = shortest_interval(t("22:00:00"), t("23:50:00"), BLOCK_TIMES, VEHICLES)
    assert none is None
    response = client.post("/api/schedule/generate", json={"interval_minutes": 10, "start": "22:00", "end": "23:50"})
    assert response.json()["detail"] == [
        {
            "loc": ["body", "interval_minutes"],
            "msg": f"No schedule is possible for this time range: {why}",
            "type": "no_schedule",
        }
    ]


# --- deleting several services at once ---


def three_services(client):
    client.post("/api/services", json=YARD_TO_P2A)
    client.post("/api/services", json=body("V1", stop("P2A", "08:10:00"), stop("P3A", "08:14:00"), stop("P2B")))
    client.post("/api/services", json=body("V1", stop("P2B", "08:20:00"), stop("P1A", "08:24:00"), stop("Y")))


def ids(client):
    return [s["id"] for s in client.get("/api/services").json()]


def test_deletes_several_services_at_once(client):
    three_services(client)
    assert client.post("/api/services/delete", json={"ids": [101, 103, 101]}).status_code == 204
    assert ids(client) == [102]


def test_deletes_nothing_when_a_service_is_missing(client):
    three_services(client)
    response = client.post("/api/services/delete", json={"ids": [101, 998, 999]})
    assert response.status_code == 404
    assert response.json()["detail"] == "Services 998, 999 not found; nothing was deleted"
    assert ids(client) == [101, 102, 103]


def test_rejects_deleting_with_no_ids(client):
    response = client.post("/api/services/delete", json={"ids": []})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "ids"]
