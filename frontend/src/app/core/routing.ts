/**
 * Path and time rules the Editor applies while typing. The backend checks
 * them again on save.
 */
import { BlockTimes, Segment, Service, YARD } from './models';
import { DAY_SECONDS, formatHms, parseHms } from './time';

export const MIN_DWELL_SECONDS = 1;

export interface DraftStop {
  at: string;
  /** Seconds since midnight; null while not filled in. */
  departure: number | null;
}

export function findSegment(segments: Segment[], start: string, end: string): Segment | undefined {
  return segments.find((s) => s.start === start && s.end === end);
}

/** Stations reachable from `from` in one segment, in track order. */
export function nextStations(segments: Segment[], from: string): string[] {
  return segments.filter((s) => s.start === from).map((s) => s.end);
}

/**
 * Arrival at each stop: the previous departure plus the blocks in between.
 * The first stop has none. Stops after a missing departure have none either.
 */
export function computeArrivals(
  stops: DraftStop[],
  segments: Segment[],
  blockTimes: BlockTimes,
): (number | null)[] {
  const arrivals: (number | null)[] = [null];
  for (let i = 1; i < stops.length; i++) {
    const departure = stops[i - 1].departure;
    const segment = findSegment(segments, stops[i - 1].at, stops[i].at);
    if (departure === null || !segment) {
      arrivals.push(null);
      continue;
    }
    arrivals.push(departure + segment.blocks.reduce((sum, b) => sum + blockTimes[b], 0));
  }
  return arrivals;
}

/**
 * Where a new service for this vehicle should start: the end of its latest
 * service (by departure), or Y if it has none. A new service has no time yet,
 * so "latest" is the best guess; the user can still change it in the table.
 */
export function startFor(services: Service[], vehicle: string): string {
  let latest: Service | undefined;
  for (const service of services) {
    if (service.vehicle !== vehicle) continue;
    if (!latest || departureOf(service) > departureOf(latest)) latest = service;
  }
  return latest?.stops.at(-1)?.at ?? YARD;
}

function departureOf(service: Service): number {
  const departure = service.stops[0]?.departure;
  return departure ? parseHms(departure) : -1;
}

/** Problems with one field of the draft, keyed like the API's `loc`. */
export interface DraftError {
  index: number;
  field: 'at' | 'departure';
  msg: string;
}

/** The same checks as the backend's validate.py, for instant feedback. */
export function checkDraft(
  stops: DraftStop[],
  segments: Segment[],
  blockTimes: BlockTimes,
): DraftError[] {
  if (stops.length < 2) {
    return [{ index: 0, field: 'at', msg: 'A service needs at least two stops' }];
  }
  const errors: DraftError[] = [];
  const last = stops.length - 1;
  stops.forEach((stop, i) => {
    if (stop.at === '') {
      errors.push({ index: i, field: 'at', msg: 'Choose a station' });
    } else if (i > 0 && i < last && stop.at === YARD) {
      errors.push({ index: i, field: 'at', msg: 'Y can only be the first or last stop' });
    }
    if (i > 0 && stop.at !== '' && stops[i - 1].at !== '' && !findSegment(segments, stops[i - 1].at, stop.at)) {
      errors.push({ index: i, field: 'at', msg: `No direct route from ${stops[i - 1].at} to ${stop.at}` });
    }
    if (i < last && stop.departure === null) {
      errors.push({ index: i, field: 'departure', msg: 'Departure time is required' });
    }
  });
  if (errors.length > 0) {
    return errors;
  }

  const arrivals = computeArrivals(stops, segments, blockTimes);
  for (let i = 1; i < last; i++) {
    const earliest = arrivals[i]! + MIN_DWELL_SECONDS;
    if (stops[i].departure! < earliest) {
      errors.push({ index: i, field: 'departure', msg: `Departure must be ${formatHms(earliest)} or later` });
    }
  }
  for (let i = 1; i <= last; i++) {
    if (arrivals[i]! >= DAY_SECONDS) {
      errors.push({
        index: i - 1,
        field: 'departure',
        msg: `Arrival at ${stops[i].at} would be ${formatHms(arrivals[i]!)}, past midnight`,
      });
    }
  }
  return errors;
}

// --- Bonus 2.1: building a path by clicking the track map ---

/** The station new stops are added after; skips a trailing stop not chosen yet. */
function currentStop(stops: DraftStop[]): { index: number; at: string } | null {
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i].at !== '') return { index: i, at: stops[i].at };
  }
  return null;
}

/** The station the path has reached so far; null before the first stop is chosen. */
export function currentStation(stops: DraftStop[]): string | null {
  return currentStop(stops)?.at ?? null;
}

/** A service that has come back to the yard is finished; nothing can follow Y. */
function finished(stops: DraftStop[]): boolean {
  const last = stops.at(-1);
  return stops.length > 1 && last?.at === YARD;
}

/** Segments the next click can add. Empty once the service is back in the yard. */
export function nextSegments(stops: DraftStop[], segments: Segment[]): Segment[] {
  const current = currentStop(stops);
  if (!current || finished(stops)) return [];
  return segments.filter((s) => s.start === current.at);
}

/** Stations and blocks on the path so far, to highlight. */
export function pathParts(stops: DraftStop[], segments: Segment[]): Set<string> {
  const parts = new Set<string>();
  stops.forEach((stop, i) => {
    if (stop.at === '') return;
    parts.add(stop.at);
    const segment = i > 0 ? findSegment(segments, stops[i - 1].at, stop.at) : undefined;
    segment?.blocks.forEach((b) => parts.add(b));
  });
  return parts;
}

export type MapPick =
  | { kind: 'add'; station: string }
  | { kind: 'remove' }
  | { kind: 'refuse'; msg: string };

/**
 * What clicking a block or station does. Any block of a segment, or its end
 * station, adds that segment's end. Clicking the last station removes it.
 * Blocks never remove: B1 and B2 run both ways, so a click on B1 after
 * Y → P1A means "go back to Y".
 */
export function pickOnMap(stops: DraftStop[], segments: Segment[], clicked: string): MapPick {
  const current = currentStop(stops);
  if (!current) return { kind: 'refuse', msg: 'Choose the first stop in the table below' };

  // The last chosen station; with an unchosen row after it, this undoes that row.
  if (clicked === current.at) {
    return stops.length > 1
      ? { kind: 'remove' }
      : { kind: 'refuse', msg: 'Change the first stop in the table below' };
  }
  if (finished(stops)) {
    return { kind: 'refuse', msg: 'The service already ends in the yard. Click Y to remove it.' };
  }
  const segment = nextSegments(stops, segments).find((s) => s.end === clicked || s.blocks.includes(clicked));
  return segment
    ? { kind: 'add', station: segment.end }
    : { kind: 'refuse', msg: `Can't reach ${clicked} from ${current.at}` };
}
