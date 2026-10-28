/** Describing and grouping conflicts for the Editor and the Viewer's schedule mode. */
import { Conflict, ConflictType } from './models';
import { parseHms } from './time';

export type ConflictCategory = 'time' | 'vehicle' | 'cross' | 'battery';

export const CATEGORY_OF: Record<ConflictType, ConflictCategory> = {
  dwell_too_short: 'time',
  past_midnight: 'time',
  vehicle_overlap: 'vehicle',
  discontinuity: 'vehicle',
  not_returned: 'vehicle',
  block: 'cross',
  interlocking: 'cross',
  platform: 'cross',
  low_battery: 'battery',
  insufficient_charge: 'battery',
};

export const CATEGORY_LABELS: Record<ConflictCategory, string> = {
  time: 'Timing',
  vehicle: 'Same vehicle',
  cross: 'Between vehicles',
  battery: 'Battery',
};

export const TYPE_LABELS: Record<ConflictType, string> = {
  dwell_too_short: 'Dwell too short',
  past_midnight: 'Past midnight',
  vehicle_overlap: 'Overlap',
  discontinuity: 'Discontinuity',
  not_returned: 'Not returned',
  block: 'Block',
  interlocking: 'Interlocking',
  platform: 'Platform',
  low_battery: 'Low battery',
  insufficient_charge: 'Insufficient charge',
};

/** Service id -> vehicle id, to name the other side of a conflict. */
export type VehicleOf = ReadonlyMap<number, string>;

function window(c: Conflict): string {
  if (c.start && c.end) return ` (${c.start}–${c.end})`;
  if (c.start) return ` (${c.start})`;
  return '';
}

function others(c: Conflict, self: number | null, vehicleOf: VehicleOf): string {
  return c.services
    .filter((id) => id !== self)
    .map((id) => `${vehicleOf.get(id) ?? '?'}·${id}`)
    .join(', ');
}

/** One line of text, from the point of view of service `self` (or none). */
export function describe(c: Conflict, self: number | null, vehicleOf: VehicleOf): string {
  const [first, second] = c.resources;
  switch (c.type) {
    case 'dwell_too_short':
      return `Dwell too short at ${first}: arrives ${c.start}, departs ${c.end}`;
    case 'past_midnight':
      return `Arrives at ${first} after midnight${window(c)}`;
    case 'vehicle_overlap':
      return `Overlaps with service ${others(c, self, vehicleOf)} on the same vehicle${window(c)}`;
    case 'discontinuity':
      return c.services.length === 1
        ? `First service starts at ${second}, not in the yard`
        : `Ends at ${first}, but the next service starts at ${second}${window(c)}`;
    case 'not_returned':
      return `Last service ends at ${first} and does not return to the yard`;
    case 'block':
      return `Block ${first} also used by ${others(c, self, vehicleOf)}${window(c)}`;
    case 'interlocking':
      return `Interlocking ${first} / ${second} with ${others(c, self, vehicleOf)}${window(c)}`;
    case 'platform':
      return `Platform ${first} also used by ${others(c, self, vehicleOf)}${window(c)}`;
    case 'low_battery':
      return `Battery below 30 from ${first} at ${c.start} (lowest ${c.detail?.['lowest']})`;
    case 'insufficient_charge':
      return `Leaves the yard with less than 80 battery at ${c.start}`;
  }
}

export function conflictsOf(conflicts: Conflict[], serviceId: number): Conflict[] {
  return conflicts.filter((c) => c.services.includes(serviceId));
}

/**
 * Conflicts between vehicles come one per place, so two vehicles running
 * close together produce a long run of them. The schedule shows each run
 * as one row: same pair of services, sorted by time.
 */
export interface ConflictGroup {
  conflicts: Conflict[];
  /** Services involved, in order, without repeats. */
  services: number[];
  /** Places involved, in order, without repeats. */
  resources: string[];
  start: string | null;
  end: string | null;
}

export function foldConflicts(conflicts: Conflict[]): ConflictGroup[] {
  const groups: ConflictGroup[] = [];
  const byPair = new Map<string, ConflictGroup>();
  for (const c of conflicts) {
    const key = CATEGORY_OF[c.type] === 'cross' ? [...c.services].sort().join('-') : null;
    const group = key !== null ? byPair.get(key) : undefined;
    if (group) {
      group.conflicts.push(c);
      continue;
    }
    const created: ConflictGroup = { conflicts: [c], services: [], resources: [], start: null, end: null };
    groups.push(created);
    if (key !== null) byPair.set(key, created);
  }
  for (const group of groups) {
    group.conflicts.sort((a, b) => parseHms(a.start ?? '0:0:0') - parseHms(b.start ?? '0:0:0'));
    group.services = [...new Set(group.conflicts.flatMap((c) => c.services))];
    group.resources = [...new Set(group.conflicts.flatMap((c) => c.resources))];
    group.start = group.conflicts[0].start;
    const ends = group.conflicts.map((c) => c.end).filter((e): e is string => e !== null);
    group.end = ends.length ? ends.reduce((a, b) => (parseHms(a) >= parseHms(b) ? a : b)) : null;
  }
  return groups;
}

// --- the conflicts table of the Viewer ---

/** Earliest first; conflicts with no time last. */
export function sortGroups(groups: ConflictGroup[]): ConflictGroup[] {
  const key = (g: ConflictGroup) => {
    const time = g.start ?? g.end;
    return time === null ? Infinity : parseHms(time);
  };
  return [...groups].sort((a, b) => key(a) - key(b));
}

/** "08:02:30–08:05:00", "08:10:00", "until 08:00:00" or "—". */
export function groupTime(group: ConflictGroup): string {
  // Not a window but the arrival, then the departure it is not before: show when it arrives.
  if (group.conflicts[0].type === 'dwell_too_short') return group.start ?? '—';
  if (group.start && group.end) return `${group.start}–${group.end}`;
  if (group.start) return group.start;
  if (group.end) return `until ${group.end}`;
  return '—';
}

/** "Block, Platform": the kinds in a row, without repeats. */
export function groupType(group: ConflictGroup): string {
  return [...new Set(group.conflicts.map((c) => TYPE_LABELS[c.type]))].join(', ');
}

/**
 * What the time, type and services columns don't already say: the place, or
 * the reason in a few words, e.g. "ends at P2A, next starts at Y".
 */
export function groupDetails(group: ConflictGroup): string {
  if (group.conflicts.length > 1) return group.resources.join(', ');
  const c = group.conflicts[0];
  const [first, second] = c.resources;
  switch (c.type) {
    case 'block':
    case 'platform':
      return first;
    case 'interlocking':
      return `${first} / ${second}`;
    case 'low_battery':
      return `from ${first}, lowest ${c.detail?.['lowest']}`;
    case 'insufficient_charge':
      return `leaves ${first} below 80`;
    // The earlier service first.
    case 'vehicle_overlap':
      return `${c.services[1]} leaves before ${c.services[0]} is back`;
    case 'discontinuity':
      return c.services.length === 2 ? `ends at ${first}, next starts at ${second}` : `starts at ${second}, vehicle is at ${first}`;
    case 'dwell_too_short':
      return `${first}, due to leave ${c.end}`;
    case 'past_midnight':
      return `arrives at ${first}`;
    case 'not_returned':
      return `ends at ${first}`;
  }
}
