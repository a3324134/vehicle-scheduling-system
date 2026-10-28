import { Conflict, ConflictType, Interval, Service } from './models';
import { chartPosition, chartRange, spanLabel, stopRows, viaBlocks } from './schedule';
import { parseHms as t } from './time';

// 135: Y 19:00:00 -> B1 -> P1A (19:01:00–19:03:00) -> B3, B5 -> P2A 19:05:00.
const S135: Service = {
  id: 135,
  vehicle: 'V1',
  path: ['Y', 'B1', 'P1A', 'B3', 'B5', 'P2A'],
  stops: [
    { at: 'Y', arrival: null, departure: '19:00:00' },
    { at: 'P1A', arrival: '19:01:00', departure: '19:03:00' },
    { at: 'P2A', arrival: '19:05:00', departure: null },
  ],
};

function interval(at: string, start: string, end: string, service: number | null, battery: [number, number]): Interval {
  return { at, toward: null, start: t(start), end: t(end), service, gap: null, battery_start: battery[0], battery_end: battery[1] };
}

// Charging in the yard up to 80, then one unit less on entering each block.
const V1: Interval[] = [
  interval('Y', '18:00:00', '19:00:00', null, [60, 80]),
  interval('B1', '19:00:00', '19:01:00', 135, [79, 79]),
  interval('P1A', '19:01:00', '19:03:00', 135, [79, 79]),
  interval('B3', '19:03:00', '19:04:00', 135, [78, 78]),
  interval('B5', '19:04:00', '19:05:00', 135, [77, 77]),
];

function conflict(
  resources: string[],
  start: string | null,
  end: string | null,
  type: ConflictType = 'block',
  services = [135],
): Conflict {
  return { type, services, resources, start, end, detail: null };
}

/** The cells each row marks: S station, V via, A arrival, D departure, B battery. */
function marks(conflicts: Conflict[]): string[] {
  return stopRows(S135, V1, conflicts).map(
    (r) =>
      (r.marks.station.length ? 'S' : '') +
      (r.marks.via.size ? 'V' : '') +
      (r.marks.arrival.length ? 'A' : '') +
      (r.marks.departure.length ? 'D' : '') +
      (r.marks.battery.length ? 'B' : ''),
  );
}

describe('viaBlocks', () => {
  it('gives each stop the blocks driven through to reach it', () => {
    expect(viaBlocks(S135)).toEqual([[], ['B1'], ['B3', 'B5']]);
  });
});

describe('stopRows', () => {
  it('lists times, stop lengths and the battery at each stop', () => {
    const rows = stopRows(S135, V1, []);
    expect(rows.map((r) => [r.at, r.via, r.arrival, r.departure, r.dwell, r.battery])).toEqual([
      ['Y', [], null, t('19:00:00'), null, 80],
      ['P1A', ['B1'], t('19:01:00'), t('19:03:00'), 120, 79],
      ['P2A', ['B3', 'B5'], t('19:05:00'), null, null, 77],
    ]);
  });

  it('leaves the battery unknown when the timeline has none', () => {
    // No wait before 19:00:00, e.g. the vehicle was somewhere else.
    expect(stopRows(S135, V1.slice(1), [])[0].battery).toBeNull();
  });

  it('marks the stations and blocks a conflict involves while the vehicle is there', () => {
    const rows = stopRows(S135, V1, [
      conflict(['B1'], '19:00:30', '19:01:00'),
      conflict(['B5'], '19:04:30', '19:05:00'),
      conflict(['P1A'], '19:02:00', '19:02:30'),
    ]);
    expect(rows.map((r) => [r.marks.station.length > 0, [...r.marks.via.keys()]])).toEqual([
      [false, []],
      [true, ['B1']],
      [false, ['B5']],
    ]);
  });

  it('ignores a conflict at the same place at another time', () => {
    const rows = stopRows(S135, V1, [conflict(['P1A', 'B3'], '18:00:00', '18:10:00')]);
    expect(rows.some((r) => r.marks.station.length > 0 || r.marks.via.size > 0)).toBe(false);
  });

  it('marks the last station when the service does not return to the yard', () => {
    expect(marks([conflict(['P2A'], null, null, 'not_returned')])).toEqual(['', '', 'S']);
  });

  it('marks the times that contradict, not the station', () => {
    expect(marks([conflict(['P1A'], '19:01:00', '19:03:00', 'dwell_too_short')])).toEqual(['', 'AD', '']);
    expect(marks([conflict(['P2A'], '19:05:00', null, 'past_midnight')])).toEqual(['', '', 'A']);
  });

  it('marks the departure or the arrival that overlaps another service of the vehicle', () => {
    // 135 leaves before 134 arrives.
    expect(marks([conflict([], '19:00:00', '19:00:20', 'vehicle_overlap', [134, 135])])).toEqual(['D', '', '']);
    // 136 leaves before 135 arrives.
    expect(marks([conflict([], '19:04:50', '19:05:00', 'vehicle_overlap', [135, 136])])).toEqual(['', '', 'A']);
  });

  it('marks the battery, not the block, while it is low or when it leaves the yard short', () => {
    expect(marks([conflict(['B3'], '19:03:00', null, 'low_battery')])).toEqual(['', '', 'B']);
    expect(marks([conflict(['Y'], '19:00:00', null, 'insufficient_charge')])).toEqual(['B', '', '']);
  });

  it('marks both ends of services that do not connect', () => {
    // 134 ends at P3A, 135 starts at Y.
    expect(marks([conflict(['P3A', 'Y'], '18:00:00', '19:00:00', 'discontinuity', [134, 135])])).toEqual(['S', '', '']);
    // 135 ends at P2A, 136 starts at Y.
    expect(marks([conflict(['P2A', 'Y'], '19:05:00', '20:00:00', 'discontinuity', [135, 136])])).toEqual(['', '', 'S']);
    // The first service of the day starts at P1A while the vehicle is in the yard.
    expect(marks([conflict(['Y', 'P1A'], null, '19:00:00', 'discontinuity')])).toEqual(['S', '', '']);
  });

  it('keeps the conflicts behind each red cell, to explain them', () => {
    const platform = conflict(['P1A'], '19:02:00', '19:02:30', 'platform');
    const interlocking = conflict(['B1', 'B2'], '19:00:30', '19:01:00', 'interlocking');
    const [, p1a] = stopRows(S135, V1, [platform, interlocking]);
    expect(p1a.marks.station).toEqual([platform]);
    expect(p1a.marks.via.get('B1')).toEqual([interlocking]);
  });
});

function service(id: number, departure: string, arrival: string): Service {
  return {
    id,
    vehicle: 'V1',
    path: ['Y', 'B1', 'P1A'],
    stops: [
      { at: 'Y', arrival: null, departure },
      { at: 'P1A', arrival, departure: null },
    ],
  };
}

describe('chartRange', () => {
  it('rounds out to whole hours around every service', () => {
    const range = chartRange([service(1, '08:00:00', '09:02:30'), service(2, '19:00:00', '19:05:00')])!;
    expect([range.start, range.end]).toEqual([t('08:00:00'), t('20:00:00')]);
    // 12 hours: a line every hour.
    expect(range.ticks.length).toBe(13);
  });

  it('runs past midnight with a service that does, and spaces the labels out', () => {
    const range = chartRange([service(1, '06:10:00', '07:00:00'), service(2, '23:50:00', '24:03:40')])!;
    expect([range.start, range.end]).toEqual([t('06:00:00'), t('25:00:00')]);
    expect(range.ticks.slice(0, 3)).toEqual([t('06:00:00'), t('08:00:00'), t('10:00:00')]);
  });

  it('is at least one hour wide', () => {
    const range = chartRange([service(1, '08:00:00', '09:00:00')])!;
    expect([range.start, range.end]).toEqual([t('08:00:00'), t('09:00:00')]);
  });

  it('is empty without services', () => {
    expect(chartRange([])).toBeNull();
  });
});

describe('chartPosition and spanLabel', () => {
  it('place and label a service by its times', () => {
    const range = chartRange([service(1, '08:00:00', '20:00:00')])!;
    const { left, width } = chartPosition([t('11:00:00'), t('14:00:00')], range);
    expect(left).toBeCloseTo(25);
    expect(width).toBeCloseTo(25);
    expect(spanLabel(service(118, '08:00:00', '09:02:30'))).toBe('118 · 08:00:00–09:02:30');
  });
});
