import {
  describe as describeConflict,
  foldConflicts,
  groupDetails,
  groupTime,
  groupType,
  sortGroups,
} from './conflicts';
import { Conflict } from './models';

function conflict(extra: Partial<Conflict>): Conflict {
  return { type: 'block', services: [], resources: [], start: null, end: null, detail: null, ...extra };
}

const vehicleOf = new Map([
  [101, 'V1'],
  [201, 'V2'],
  [202, 'V2'],
]);

describe('foldConflicts', () => {
  // V2 runs 30 seconds behind V1: one conflict per place, as in the backend's
  // test_flags_following_too_closely_at_every_place.
  const chase = [
    conflict({ services: [101, 201], resources: ['B5'], start: '08:03:30', end: '08:04:00' }),
    conflict({ services: [101, 201], resources: ['B3'], start: '08:02:30', end: '08:03:00' }),
    conflict({ type: 'platform', services: [101, 201], resources: ['P2A'], start: '08:04:30', end: '08:05:00' }),
  ];

  it('folds conflicts between the same two services into one row, in time order', () => {
    const [group] = foldConflicts(chase);
    expect(group.conflicts.map((c) => c.resources[0])).toEqual(['B3', 'B5', 'P2A']);
    expect(group.resources).toEqual(['B3', 'B5', 'P2A']);
    expect([group.start, group.end]).toEqual(['08:02:30', '08:05:00']);
    expect(group.services).toEqual([101, 201]);
  });

  it('keeps a different pair of services in its own row', () => {
    const other = conflict({ services: [101, 202], resources: ['B6'], start: '09:00:00', end: '09:00:30' });
    expect(foldConflicts([...chase, other])).toHaveLength(2);
  });

  it('does not fold conflicts of a single vehicle', () => {
    const own = [
      conflict({ type: 'not_returned', services: [101], resources: ['P2A'] }),
      conflict({ type: 'low_battery', services: [101], resources: ['B5'], start: '08:10:00', detail: { lowest: 21 } }),
    ];
    expect(foldConflicts(own)).toHaveLength(2);
  });
});

describe('describe', () => {
  it('names the other vehicle from the point of view of the service', () => {
    const c = conflict({ services: [101, 201], resources: ['B1'], start: '08:00:30', end: '08:01:00' });
    expect(describeConflict(c, 101, vehicleOf)).toBe('Block B1 also used by V2·201 (08:00:30–08:01:00)');
    expect(describeConflict(c, 201, vehicleOf)).toBe('Block B1 also used by V1·101 (08:00:30–08:01:00)');
  });
});

describe('groupTime, groupType and groupDetails', () => {
  it('describe a folded run in one row, with every kind and place in it', () => {
    const [group] = foldConflicts([
      conflict({ services: [101, 201], resources: ['B3'], start: '08:02:30', end: '08:03:00' }),
      conflict({ type: 'platform', services: [101, 201], resources: ['P2A'], start: '08:04:30', end: '08:05:00' }),
    ]);
    expect([groupTime(group), groupType(group), groupDetails(group)]).toEqual([
      '08:02:30–08:05:00',
      'Block, Platform',
      'B3, P2A',
    ]);
  });

});

describe('groupDetails', () => {
  it('says what the other columns do not, for each kind', () => {
    const details = (c: Partial<Conflict>) => groupDetails(foldConflicts([conflict(c)])[0]);
    expect(details({ type: 'platform', services: [101, 201], resources: ['P1A'] })).toBe('P1A');
    expect(details({ type: 'interlocking', services: [101, 201], resources: ['B1', 'B2'] })).toBe('B1 / B2');
    expect(details({ type: 'low_battery', services: [101], resources: ['B3'], detail: { lowest: 21 } })).toBe('from B3, lowest 21');
    expect(details({ type: 'insufficient_charge', services: [101], resources: ['Y'] })).toBe('leaves Y below 80');
    expect(details({ type: 'vehicle_overlap', services: [128, 129] })).toBe('129 leaves before 128 is back');
    expect(details({ type: 'discontinuity', services: [101, 102], resources: ['P2A', 'Y'] })).toBe('ends at P2A, next starts at Y');
    expect(details({ type: 'discontinuity', services: [101], resources: ['Y', 'P1A'] })).toBe('starts at P1A, vehicle is at Y');
    expect(details({ type: 'dwell_too_short', services: [133], resources: ['P1B'], start: '24:01:00', end: '23:56:30' })).toBe(
      'P1B, due to leave 23:56:30',
    );
    expect(details({ type: 'past_midnight', services: [133], resources: ['P1B'] })).toBe('arrives at P1B');
    expect(details({ type: 'not_returned', services: [132], resources: ['P2A'] })).toBe('ends at P2A');
  });

});

describe('groupTime', () => {
  it('gives a time even when only one end is known', () => {
    const time = (c: Partial<Conflict>) => groupTime(foldConflicts([conflict(c)])[0]);
    expect(time({ type: 'low_battery', services: [101], start: '08:10:00' })).toBe('08:10:00');
    expect(time({ type: 'discontinuity', services: [101], end: '08:00:00' })).toBe('until 08:00:00');
    expect(time({ type: 'not_returned', services: [101] })).toBe('—');
    // Arrives after it should leave: not a time window, so only the arrival.
    expect(time({ type: 'dwell_too_short', services: [101], start: '24:01:00', end: '23:56:30' })).toBe('24:01:00');
  });

});

describe('sortGroups', () => {
  it('puts the earliest first and those with no time last', () => {
    const groups = foldConflicts([
      conflict({ type: 'not_returned', services: [101], resources: ['P2A'] }),
      conflict({ services: [101, 201], resources: ['B6'], start: '09:00:00', end: '09:00:30' }),
      conflict({ type: 'discontinuity', services: [202], resources: ['Y', 'P1A'], end: '08:00:00' }),
    ]);
    expect(sortGroups(groups).map((g) => g.conflicts[0].type)).toEqual(['discontinuity', 'block', 'not_returned']);
  });
});
