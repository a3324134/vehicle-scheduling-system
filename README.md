# Vehicle Scheduling System

English | [中文](README.zh-TW.md)

## Setup

All you need is Docker:

```shell
docker compose up
```

The app is at <http://localhost:8080> and the API docs are at <http://localhost:8000/docs>.

On the first start the backend creates the tables and adds the initial data: vehicles V1 to V5 and 14 blocks at 60 seconds each. The schedule starts empty. To wipe everything and start over, run `docker compose down -v`.

Tests:

```shell
docker compose run --rm backend pytest      # backend, 111 tests
docker compose run --rm frontend-test       # frontend, 84 tests
```

## Data model

| Table | Columns | What it holds |
|---|---|---|
| `vehicles` | `id` | The fixed fleet, V1 to V5 |
| `blocks` | `id`, `traversal_seconds` | Traversal time of each block, at least 1 second |
| `services` | `id`, `vehicle_id` | Services, numbered from 101 |
| `service_stops` | `service_id`, `seq`, `station`, `departure` | The stops of a service, in order |

For example, service 101 (Y → P1A → P2A) is just three rows in `service_stops`:

```
service_id | seq | station | departure
       101 |   0 | Y       | 08:00:00
       101 |   1 | P1A     | 08:02:00
       101 |   2 | P2A     |              ← the last stop has no departure
```

**Stations only, no blocks.** No two of the spec's 12 segments share the same start and end, so the stations alone tell you which blocks a service runs through. That also means the database can never hold a path whose blocks don't match its stations. The API adds the full path back in its responses.

**Nothing that can be computed is stored.** Arrival times, battery and conflicts are worked out on every read. Block times can change, and one change affects every service through that block. If the results were stored, every change would mean finding everything affected and recomputing it, and missing one row would show wrong data. Recomputing costs a little time, but that's acceptable for this design.

**The track lives in code.** Segments, interlocking groups and platforms are fixed by the spec, so they're constants in `backend/app/domain/track.py`. The `blocks` table only exists because traversal times can be changed.

**Times use the `time` type.** It's a single-day timetable, so there's no date. In code, times are converted to seconds since midnight.

## API

Everything is under `/api`; see `/docs` for the fields.

| API | Purpose |
|---|---|
| `GET /api/track` | The track: stations, blocks, segments, interlocking groups |
| `GET /api/vehicles` | The fleet |
| `GET /api/blocks`, `PUT /api/blocks` | Read, or replace all block traversal times at once |
| `GET /api/services`, `GET /api/services/{id}` | Services, with the full path and arrival times |
| `POST /api/services`, `PUT /api/services/{id}` | Create or update a service |
| `POST /api/services/delete` | Delete several services, e.g. `{"ids": [101, 103]}`; if any is missing, none are deleted |
| `GET /api/conflicts` | All current conflicts |
| `GET /api/timeline` | Where each vehicle is all day, and its battery, for the simulation |
| `GET /api/schedule/limits` | Auto-generate: the shortest possible interval, and why a shorter one fails |
| `POST /api/schedule/generate` | Auto-generate: build a schedule that replaces all services |

To create a service you send only the stations and departures; the response adds the path and arrival times:

```json
POST /api/services
{ "vehicle": "V1", "stops": [{ "at": "Y", "departure": "08:00:00" }, { "at": "P1A", "departure": "08:02:00" }, { "at": "P2A" }] }

→ 201
{
  "id": 101, "vehicle": "V1",
  "path": ["Y", "B1", "P1A", "B3", "B5", "P2A"],
  "stops": [
    { "at": "Y",   "arrival": null,       "departure": "08:00:00" },
    { "at": "P1A", "arrival": "08:01:00", "departure": "08:02:00" },
    { "at": "P2A", "arrival": "08:04:00", "departure": null }
  ]
}
```

A service that is invalid on its own (no such route, a stop shorter than 1 second, arriving after midnight, an unknown vehicle) gets a 422, with `loc` pointing at the stop and field. A service that is fine on its own but clashes with others is saved anyway and shows up in `GET /api/conflicts`. There are 10 kinds of conflict:

| Type | Meaning |
|---|---|
| `block` | Two vehicles in the same block at once |
| `interlocking` | Two vehicles in different blocks of the same interlocking group at once |
| `platform` | Two vehicles at the same platform at once |
| `vehicle_overlap` | Two services of the same vehicle overlap in time |
| `discontinuity` | A vehicle's service ends somewhere other than where its next one starts |
| `not_returned` | A vehicle's last service doesn't end at Y |
| `dwell_too_short` | After a block time change, a vehicle no longer arrives before it should leave |
| `past_midnight` | After a block time change, a vehicle arrives after midnight |
| `low_battery` | Battery below 30 while not at Y |
| `insufficient_charge` | Leaving Y with less than 80 battery |

## Design trade-offs

### Users enter departures; arrivals are computed

An arrival is the previous departure plus the block times in between, so I only ask users for departure times. I also considered two other options: entering both arrivals and departures, which easily falls out of step with block times; and entering a start time plus how long to stop at each station, where a block time change pushes the delay all the way to the last stop.

For example, take `P1A dep 08:02 → P2A arr 08:04, dep 08:06 → P3A arr 08:08` and change B5 from 60 to 90 seconds:

| | Departures (chosen) | Stop lengths |
|---|---|---|
| P2A arrival | 08:04:30 | 08:04:30 |
| P2A departure | 08:06, unchanged | 08:06:30 |
| P3A arrival | 08:08, unchanged | 08:08:30 |

The stop absorbs the delay and the published departure stays the same, which is closer to how real timetables work. The downside is that a big enough delay makes a vehicle arrive after it should leave: with B5 at 200 seconds it reaches P2A at 08:06:20. That's flagged as `dwell_too_short` for the user to fix.

### Conflicts are flagged, not rejected

Only a service that is invalid on its own is rejected. Every other conflict comes from several services together, so it's saved and then flagged. Editing naturally passes through these states: delete the middle one of three back-to-back services and the other two no longer connect. If those were rejected, you couldn't even delete. The cost is that the database can hold a schedule with problems, so the UI has to show clearly what's wrong and why.

### Auto-generate uses one fixed loop

Every vehicle runs the same loop, `S1 → P2A → S3 → P2B → S1`, stopping 10 seconds at each station, with just enough vehicles spread evenly around it. When a vehicle runs low it goes back to Y to charge and a charged one takes its place. The result is checked with the same conflict detection as the rest of the app, and nothing is handed out if it finds anything.

Fixed rules mean the result never has conflicts and is easy to test. The shortest interval shown in the UI comes from running the same generator from 1 minute upwards, so it always matches what Generate actually does. The downsides: vehicles are spaced evenly, so they can run closer than the interval asked for (6 minutes gives one every 4 min 20 s); and individual services are never fine-tuned, so for some block times the shortest interval is a bit longer than it could be.

### Every intermediate stop is at least 1 second

Occupancy uses `[enter, leave)`, so leaving and entering in the same second is not a conflict. With a 0-second stop, a vehicle's time at the platform would be `[t, t)`, which contains nothing. Two vehicles arriving at P1A at 08:00:00 and both stopping for 0 seconds would not be flagged.

With at least 1 second, no window is ever empty, and blocks, interlocking groups and platforms all use the same check. Closed windows would flag vehicles that only touch; treating 0 seconds as a special case would add another rule. The cost is that a vehicle can't pass through a station without stopping, which the spec doesn't ask for.

## Assumptions

- It's a single-day timetable: no service runs past midnight. Every vehicle starts the day at Y with 80 battery.
- The spec doesn't say how many vehicles there are, so I use a fixed fleet of 5 (V1 to V5), added as initial data. Users pick a vehicle from a list, so a typo can't create a new one.
- Service IDs are assigned by the system, starting at 101.
- The first stop has no arrival and the last stop has no departure. Intermediate stops last at least 1 second, and so does the gap between two services of the same vehicle.
- Each leg of a path must be one of the adjacency list's lines, so a vehicle can't turn back inside a block. Turning back at a platform is fine, e.g. `Y → P1A → Y`.
- Y can only be the first or last stop. Passing through Y means two services, so charging is clear.
- A vehicle's last service must end at Y, or it's flagged as `not_returned`.
- A vehicle is a point. Vehicles that only touch don't conflict, and there's no extra safety margin.
- Platforms are occupied too: one vehicle at a time (any number at Y). Otherwise a vehicle could pass one standing at the platform.
- Overlap in the same block is reported only as a block conflict; interlocking conflicts are only for different blocks in the same group.
- Battery drops by 1 on entering a block and not while stopped. The check on leaving the yard uses the battery before leaving Y.
- At Y the battery gains 1 per full 12 seconds, up to 100. Low battery is reported once per trip.
- Once a vehicle's services stop connecting, its battery is no longer computed, since there's no way to know whether it went to charge.
- Auto-generate's start and end are when vehicles leave Y, so the first vehicle leaves at 08:00 and none leave earlier. But from 08:00 on, every station must see a vehicle within one interval, and the farthest station, S3, has to wait for the first vehicle to get there. With the defaults, that's 5 blocks (60 seconds each by default) plus a 10-second stop at P1A and at P2A (auto-generate's default stop), reaching P3A at 08:05:20. So the shortest interval is 6 minutes. Shorter block times or stops make it shorter.
- Auto-generate replaces the whole schedule; if it can't generate one, the existing schedule is left untouched.
- Single user, no login; desktop browsers only.
