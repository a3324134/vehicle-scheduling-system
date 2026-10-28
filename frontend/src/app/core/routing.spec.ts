import { Segment, Service } from './models';
import { DraftStop, checkDraft, computeArrivals, currentStation, nextSegments, nextStations, pathParts, pickOnMap, startFor } from './routing';
import { parseHms as t } from './time';

// Same as GET /api/track and the backend's track.py.
const SEGMENTS: Segment[] = [
  { start: 'Y', end: 'P1A', blocks: ['B1'] },
  { start: 'P1A', end: 'Y', blocks: ['B1'] },
  { start: 'Y', end: 'P1B', blocks: ['B2'] },
  { start: 'P1B', end: 'Y', blocks: ['B2'] },
  { start: 'P1A', end: 'P2A', blocks: ['B3', 'B5'] },
  { start: 'P1B', end: 'P2A', blocks: ['B4', 'B5'] },
  { start: 'P2A', end: 'P3A', blocks: ['B6', 'B7'] },
  { start: 'P2A', end: 'P3B', blocks: ['B6', 'B8'] },
  { start: 'P3A', end: 'P2B', blocks: ['B10', 'B11'] },
  { start: 'P3B', end: 'P2B', blocks: ['B9', 'B11'] },
  { start: 'P2B', end: 'P1B', blocks: ['B12', 'B14'] },
  { start: 'P2B', end: 'P1A', blocks: ['B12', 'B13'] },
];

const BLOCK_TIMES = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`B${i + 1}`, 60]));

/** stops('Y 08:00:00', 'P1A 08:02:00', 'P2A'), like the backend's test helper. */
function stops(...specs: string[]): DraftStop[] {
  return specs.map((spec) => {
    const [at, departure] = spec.split(' ');
    return { at, departure: departure ? t(departure) : null };
  });
}

describe('nextStations', () => {
  it('lists only stations one segment away', () => {
    expect(nextStations(SEGMENTS, 'Y')).toEqual(['P1A', 'P1B']);
    expect(nextStations(SEGMENTS, 'P2A')).toEqual(['P3A', 'P3B']);
    expect(nextStations(SEGMENTS, 'P1A')).toEqual(['Y', 'P2A']);
  });
});

// The same cases as the backend's T-* tests, so both sides compute the same arrivals.
describe('computeArrivals', () => {
  it('adds the block times to the previous departure', () => {
    expect(computeArrivals(stops('Y 08:00:00', 'P1A 08:02:00', 'P2A'), SEGMENTS, BLOCK_TIMES)).toEqual([
      null,
      t('08:01:00'),
      t('08:04:00'),
    ]);
  });

  it('uses each block’s own time', () => {
    const arrivals = computeArrivals(stops('Y 08:00:00', 'P1A 08:02:00', 'P2A'), SEGMENTS, { ...BLOCK_TIMES, B5: 90 });
    expect(arrivals[2]).toBe(t('08:04:30'));
  });

  it('keeps both arrivals when a service visits the same platform twice', () => {
    const lap = stops(
      'Y 08:00:00',
      'P1A 08:02:00',
      'P2A 08:05:00',
      'P3A 08:08:00',
      'P2B 08:11:00',
      'P1A 08:14:00',
      'Y',
    );
    const arrivals = computeArrivals(lap, SEGMENTS, BLOCK_TIMES);
    expect(arrivals[1]).toBe(t('08:01:00'));
    expect(arrivals[5]).toBe(t('08:13:00'));
  });

  it('gives no arrival after a missing departure', () => {
    expect(computeArrivals(stops('Y', 'P1A'), SEGMENTS, BLOCK_TIMES)).toEqual([null, null]);
  });
});

describe('checkDraft', () => {
  const check = (...specs: string[]) => checkDraft(stops(...specs), SEGMENTS, BLOCK_TIMES);

  it('accepts a valid service', () => {
    expect(check('Y 08:00:00', 'P1A 08:02:00', 'P2A')).toEqual([]);
  });

  it('rejects a zero-second dwell and gives the earliest allowed time', () => {
    expect(check('Y 08:00:00', 'P1A 08:01:00', 'P2A')).toEqual([
      { index: 1, field: 'departure', msg: 'Departure must be 08:01:01 or later' },
    ]);
  });

  it('accepts a one-second dwell', () => {
    expect(check('Y 08:00:00', 'P1A 08:01:01', 'P2A')).toEqual([]);
  });

  it('rejects arriving at midnight, pointing at the departure that causes it', () => {
    expect(check('P1A 23:58:00', 'P2A')).toEqual([
      { index: 0, field: 'departure', msg: 'Arrival at P2A would be 24:00:00, past midnight' },
    ]);
  });

  it('accepts arriving one second before midnight', () => {
    expect(check('P1A 23:57:59', 'P2A')).toEqual([]);
  });

  it('rejects two stations with no line between them', () => {
    expect(check('P2A 08:00:00', 'P1A')).toEqual([{ index: 1, field: 'at', msg: 'No direct route from P2A to P1A' }]);
  });

  it('rejects fewer than two stops', () => {
    expect(check('Y 08:00:00')).toEqual([{ index: 0, field: 'at', msg: 'A service needs at least two stops' }]);
  });

  it('rejects a stop with no station chosen or no departure', () => {
    expect(checkDraft([{ at: 'Y', departure: null }, { at: '', departure: null }], SEGMENTS, BLOCK_TIMES)).toEqual([
      { index: 0, field: 'departure', msg: 'Departure time is required' },
      { index: 1, field: 'at', msg: 'Choose a station' },
    ]);
  });
});

// Bonus 2.1: clicking the track map.
describe('pickOnMap', () => {
  const pick = (clicked: string, ...specs: string[]) => pickOnMap(stops(...specs), SEGMENTS, clicked);

  it('adds the end station of the segment, whichever part of it is clicked', () => {
    for (const clicked of ['B3', 'B5', 'P2A']) {
      expect(pick(clicked, 'Y 08:00:00', 'P1A')).toEqual({ kind: 'add', station: 'P2A' });
    }
  });

  it('rejects a place the current station cannot reach', () => {
    expect(pick('B4', 'Y 08:00:00', 'P1A')).toEqual({ kind: 'refuse', msg: "Can't reach B4 from P1A" });
  });

  it('removes the last stop when its station is clicked', () => {
    expect(pick('P1A', 'Y 08:00:00', 'P1A')).toEqual({ kind: 'remove' });
  });

  it('treats B1 after Y -> P1A as going back to Y, not removing', () => {
    expect(pick('B1', 'Y 08:00:00', 'P1A')).toEqual({ kind: 'add', station: 'Y' });
  });

  it('leaves the first stop to the table', () => {
    expect(pick('Y', 'Y')).toEqual({ kind: 'refuse', msg: 'Change the first stop in the table below' });
  });

  it('adds nothing after the service is back in the yard', () => {
    expect(pick('P1B', 'Y 08:00:00', 'P1A 08:02:00', 'Y').kind).toBe('refuse');
    expect(pick('Y', 'Y 08:00:00', 'P1A 08:02:00', 'Y')).toEqual({ kind: 'remove' });
  });

  it('starts from the last chosen station when a row is still unchosen', () => {
    const draft = [...stops('Y 08:00:00', 'P1A 08:02:00'), { at: '', departure: null }];
    expect(pickOnMap(draft, SEGMENTS, 'B3')).toEqual({ kind: 'add', station: 'P2A' });
    expect(pickOnMap(draft, SEGMENTS, 'P1A')).toEqual({ kind: 'remove' });
  });
});

describe('pathParts', () => {
  it('highlights the stations and the blocks between them', () => {
    expect(pathParts(stops('Y 08:00:00', 'P1A 08:02:00', 'P2A'), SEGMENTS)).toEqual(
      new Set(['Y', 'P1A', 'B1', 'P2A', 'B3', 'B5']),
    );
  });

});

describe('nextSegments', () => {
  it('offers the segments from the last station, none once back in the yard', () => {
    expect(nextSegments(stops('Y 08:00:00', 'P1A'), SEGMENTS).map((s) => s.end)).toEqual(['Y', 'P2A']);
    expect(nextSegments(stops('Y 08:00:00', 'P1A 08:02:00', 'Y'), SEGMENTS)).toEqual([]);
  });

});

describe('currentStation and nextSegments', () => {
  it('follow a path that visits a station twice', () => {
    const lap = stops('Y 08:00:00', 'P1A 08:02:00', 'P2A 08:05:00', 'P3A 08:08:00', 'P2B 08:11:00', 'P1A');
    expect(currentStation(lap)).toBe('P1A');
    // Both ways out of P1A were taken on the first lap; they are still offered.
    expect(nextSegments(lap, SEGMENTS).map((s) => s.end)).toEqual(['Y', 'P2A']);
    expect(currentStation([...lap, { at: '', departure: null }])).toBe('P1A');
    expect(currentStation([{ at: '', departure: null }])).toBeNull();
  });
});

describe('startFor', () => {
  /** service(101, 'V1', 'Y 08:00:00', 'P1A') — only what startFor reads. */
  const service = (id: number, vehicle: string, ...specs: string[]): Service => ({
    id,
    vehicle,
    path: [],
    stops: specs.map((spec) => {
      const [at, departure] = spec.split(' ');
      return { at, arrival: null, departure: departure ?? null };
    }),
  });
  const services = [
    service(101, 'V1', 'Y 08:00:00', 'P1A 08:02:00', 'P2A'),
    service(102, 'V1', 'P2A 09:00:00', 'P3A 09:03:00', 'P2B'),
    // Created last but runs first: the latest by departure is still 102.
    service(103, 'V1', 'Y 07:00:00', 'P1A'),
    service(201, 'V2', 'Y 08:00:00', 'P1A 08:02:00', 'Y'),
  ];

  it('continues from where the latest service of that vehicle ends', () => {
    expect(startFor(services, 'V1')).toBe('P2B');
  });

  it('starts in the yard when the vehicle is back there or has no services', () => {
    expect(startFor(services, 'V2')).toBe('Y');
    expect(startFor(services, 'V3')).toBe('Y');
  });
});
