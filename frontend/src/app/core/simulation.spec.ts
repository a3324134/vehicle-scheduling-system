import { Conflict, Interval, VehicleTimeline } from './models';
import {
  STACK_SPACING,
  activeWindows,
  batteryAt,
  conflictWindows,
  jumpTargets,
  nextTarget,
  openingTime,
  playbackEnd,
  positionAt,
  previousTarget,
  alongPoints,
  vehicleStatus,
  vehicleStates,
} from './simulation';
import { BLOCK_LINE_BY_ID, RUN_BY_BLOCK, STATIONS } from '../track-map/layout';
import { parseHms as t } from './time';

function interval(at: string, start: string, end: string, extra: Partial<Interval> = {}): Interval {
  return {
    at,
    toward: null,
    start: t(start),
    end: t(end),
    service: null,
    gap: null,
    battery_start: 80,
    battery_end: 80,
    ...extra,
  };
}

function conflict(extra: Partial<Conflict>): Conflict {
  return { type: 'block', services: [], resources: [], start: null, end: null, detail: null, ...extra };
}

// V1: Y until 08:00, then 101 Y -> P1A -> Y.
const V1: VehicleTimeline = {
  vehicle: 'V1',
  intervals: [
    interval('Y', '00:00:00', '08:00:00'),
    interval('B1', '08:00:00', '08:01:00', { service: 101, toward: 'P1A' }),
    interval('P1A', '08:01:00', '08:02:00', { service: 101 }),
    interval('B1', '08:02:00', '08:03:00', { service: 101, toward: 'Y' }),
    interval('Y', '08:03:00', '24:00:00'),
  ],
};

describe('positionAt', () => {
  // B1 is a straight run between the centres of P1A and Y.
  const [p1a, , , yard] = RUN_BY_BLOCK.get('B1')!;
  const b1 = { from: p1a, to: yard };

  it('moves along a block in proportion to time', () => {
    const halfway = positionAt(V1.intervals[1], t('08:00:30'));
    expect(halfway.x).toBeCloseTo((b1.from.x + b1.to.x) / 2);
  });

  it('runs B1 backwards when heading to P1A, which is drawn at its start', () => {
    // Drawn from P1A to Y; a quarter of the way from Y means three quarters along the line.
    const toP1A = positionAt(V1.intervals[1], t('08:00:15'));
    const toY = positionAt(V1.intervals[3], t('08:02:15'));
    expect(toP1A.x).toBeCloseTo(b1.from.x + (b1.to.x - b1.from.x) * 0.75);
    expect(toY.x).toBeCloseTo(b1.from.x + (b1.to.x - b1.from.x) * 0.25);
  });

  it('puts a vehicle at a station on the station', () => {
    expect(positionAt(V1.intervals[2], t('08:01:30'))).toEqual(STATIONS['P1A']);
  });

  it('leaves from and arrives at the centre of a station, with no jump', () => {
    // Y -> B1 -> P1A: on B1 until 08:01:00, then at P1A.
    expect(positionAt(V1.intervals[1], t('08:00:00'))).toEqual(STATIONS['Y']);
    expect(positionAt(V1.intervals[1], t('08:01:00'))).toEqual(STATIONS['P1A']);
    // B3 runs from P1A to the junction, B5 from the junction to P2A.
    expect(positionAt(interval('B3', '08:00:00', '08:01:00'), t('08:00:00'))).toEqual(STATIONS['P1A']);
    expect(positionAt(interval('B5', '08:01:00', '08:02:00'), t('08:02:00'))).toEqual(STATIONS['P2A']);
  });

  it('runs every block that touches a station from or to its centre', () => {
    const centres = new Set(Object.values(STATIONS).map((p) => `${p.x},${p.y}`));
    const ends = [...RUN_BY_BLOCK.values()].flatMap((r) => [r[0], r.at(-1)!]).filter((p) => centres.has(`${p.x},${p.y}`));
    // B1 and B2 join two stations; every other block touches one at one end.
    expect(ends.length).toBe(16);
  });

  it('stays on a slanting line once out of the station', () => {
    // B4 slants up from P1B to the junction near P2A.
    const line = BLOCK_LINE_BY_ID.get('B4')!;
    for (const time of ['08:00:20', '08:00:40', '08:00:59']) {
      const p = positionAt(interval('B4', '08:00:00', '08:01:00'), t(time));
      const cross = (line.to.x - line.from.x) * (p.y - line.from.y) - (line.to.y - line.from.y) * (p.x - line.from.x);
      expect(Math.abs(cross) / Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y)).toBeLessThan(0.001);
    }
  });
});

describe('alongPoints', () => {
  it('moves at an even speed over every part of the line', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ];
    expect(alongPoints(points, 0)).toEqual({ x: 0, y: 0 });
    expect(alongPoints(points, 0.25)).toEqual({ x: 10, y: 0 });
    expect(alongPoints(points, 0.5)).toEqual({ x: 10, y: 10 });
    expect(alongPoints(points, 1)).toEqual({ x: 10, y: 30 });
  });
});

describe('vehicleStates', () => {
  it('finds the interval that contains t, half-open', () => {
    expect(vehicleStates([V1], t('08:01:00'))[0].interval.at).toBe('P1A');
    expect(vehicleStates([V1], t('08:00:59'))[0].interval.at).toBe('B1');
  });

  it('spreads vehicles at the same station side by side', () => {
    const V2: VehicleTimeline = { vehicle: 'V2', intervals: [interval('Y', '00:00:00', '24:00:00')] };
    const [a, b] = vehicleStates([V1, V2], t('07:00:00'));
    expect(b.position.x - a.position.x).toBe(STACK_SPACING);
    expect((a.position.x + b.position.x) / 2).toBe(STATIONS['Y'].x);
  });

  it('draws a vehicle twice when its services overlap', () => {
    const overlapping: VehicleTimeline = {
      vehicle: 'V1',
      intervals: [
        interval('B3', '08:00:00', '08:01:00', { service: 101 }),
        interval('B6', '08:00:00', '08:01:00', { service: 102 }),
      ],
    };
    expect(vehicleStates([overlapping], t('08:00:30')).map((s) => s.interval.service)).toEqual([101, 102]);
  });
});

describe('batteryAt', () => {
  it('charges one unit per 12 seconds while waiting in the yard', () => {
    const charging = interval('Y', '08:03:00', '08:13:00', { battery_start: 78, battery_end: 100 });
    expect(batteryAt(charging, t('08:03:11'))).toBe(78);
    expect(batteryAt(charging, t('08:03:12'))).toBe(79);
    expect(batteryAt(charging, t('08:12:59'))).toBe(100);
  });

  it('gives no battery after a discontinuity', () => {
    expect(batteryAt(interval('P1B', '08:00:00', '09:00:00', { battery_start: null, battery_end: null }), 0)).toBeNull();
  });
});

describe('conflictWindows', () => {
  it('uses the conflict’s own window when it has one', () => {
    const block = conflict({ services: [101, 201], resources: ['B1'], start: '08:00:30', end: '08:01:00' });
    expect(conflictWindows([block], [V1])).toEqual([
      { conflict: block, start: t('08:00:30'), end: t('08:01:00'), exact: true },
    ]);
  });

  it('shows single-moment and timeless conflicts while their service runs', () => {
    const cases = [
      conflict({ type: 'insufficient_charge', services: [101], resources: ['Y'], start: '08:00:00' }),
      conflict({ type: 'dwell_too_short', services: [101], resources: ['P1A'], start: '08:01:00', end: '08:00:50' }),
      conflict({ type: 'not_returned', services: [101], resources: ['P2A'] }),
    ];
    for (const c of cases) {
      expect(conflictWindows([c], [V1])).toEqual([{ conflict: c, start: t('08:00:00'), end: t('08:03:00'), exact: false }]);
    }
  });

});

describe('activeWindows', () => {
  it('keeps only the windows that contain t', () => {
    const windows = conflictWindows(
      [conflict({ services: [101], resources: ['B1'], start: '08:00:30', end: '08:01:00' })],
      [V1],
    );
    expect(activeWindows(windows, t('08:00:29'))).toEqual([]);
    expect(activeWindows(windows, t('08:00:30'))).toHaveLength(1);
    expect(activeWindows(windows, t('08:01:00'))).toEqual([]);
  });
});

const targets = jumpTargets(
  conflictWindows(
    [
      conflict({ services: [101], start: '08:00:30', end: '08:01:00' }),
      conflict({ services: [101], start: '09:00:00', end: '09:01:00' }),
    ],
    [V1],
  ),
);

describe('jumpTargets', () => {
  it('lands three seconds before each conflict', () => {
    expect(targets).toEqual([t('08:00:27'), t('08:59:57')]);
  });
});

describe('nextTarget and previousTarget', () => {
  it('find the next and previous target from the current time', () => {
    expect(nextTarget(targets, t('07:00:00'))).toBe(t('08:00:27'));
    expect(nextTarget(targets, t('08:00:27'))).toBe(t('08:59:57'));
    expect(nextTarget(targets, t('08:59:57'))).toBeNull();
    expect(previousTarget(targets, t('08:59:57'))).toBe(t('08:00:27'));
    expect(previousTarget(targets, t('08:00:27'))).toBeNull();
  });
});

describe('openingTime', () => {
  it('opens a minute before the first departure', () => {
    expect(openingTime([V1])).toBe(t('07:59:00'));
    expect(openingTime([])).toBe(0);
  });
});

describe('playbackEnd', () => {
  it('runs past 24:00 when a flagged service arrives after midnight', () => {
    expect(playbackEnd([V1])).toBe(t('24:00:00'));
    const late: VehicleTimeline = { vehicle: 'V2', intervals: [interval('B5', '23:59:00', '24:03:40', { service: 102 })] };
    expect(playbackEnd([V1, late])).toBe(t('24:03:40'));
  });
});

describe('vehicleStatus', () => {
  const at = (where: string, extra: Partial<Interval> = {}) => interval(where, '08:00:00', '09:00:00', extra);

  it('says Running on a block and Stopped at a platform', () => {
    expect(vehicleStatus([at('B3', { service: 101 })], t('08:30:00'))).toBe('Running');
    expect(vehicleStatus([at('P2A', { service: 101 })], t('08:30:00'))).toBe('Stopped');
  });

  it('says Charging in the yard until the battery is full', () => {
    // 60 -> 100 takes 40 × 12 s = 8 minutes.
    const yard = at('Y', { battery_start: 60, battery_end: 100 });
    expect(vehicleStatus([yard], t('08:05:00'))).toBe('Charging');
    expect(vehicleStatus([yard], t('08:30:00'))).toBe('In yard');
  });

  it('names the problems the schedule leaves the vehicle in', () => {
    expect(vehicleStatus([at('P2A', { gap: 'discontinuity' })], t('08:30:00'))).toBe('Stranded');
    expect(vehicleStatus([at('P2A', { gap: 'not_returned' })], t('08:30:00'))).toBe('Not returned');
    expect(vehicleStatus([at('B1'), at('B2')], t('08:30:00'))).toBe('Two places');
    expect(vehicleStatus([], t('08:30:00'))).toBeNull();
  });
});
