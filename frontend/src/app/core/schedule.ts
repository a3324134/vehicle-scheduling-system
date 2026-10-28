import { Conflict, Interval, Service } from './models';
import { formatHms, parseHms } from './time';

/** Below this the battery is low (spec, Bonus 1.3). */
export const LOW_BATTERY = 30;

const BLOCK = /^B\d+$/;

/** One line of a service's timetable in the Viewer. */
export interface StopRow {
  at: string;
  /** Blocks driven through from the previous stop. */
  via: string[];
  arrival: number | null;
  departure: number | null;
  /** How long the vehicle stops here. */
  dwell: number | null;
  /** On arrival, or at departure for the first stop; null when unknown. */
  battery: number | null;
  /** The conflicts that make each cell red, to explain on hover. */
  marks: StopMarks;
}

export interface StopMarks {
  station: Conflict[];
  /** By block in `via`. */
  via: Map<string, Conflict[]>;
  arrival: Conflict[];
  departure: Conflict[];
  battery: Conflict[];
}

/**
 * The timetable of one service.
 *
 * Each kind of conflict marks the cell where the problem is: the place two
 * vehicles want, the times that contradict, the battery
 * that is too low, or the stations that don't connect.
 *
 * Battery comes from the vehicle's timeline, so the battery rules are not
 * written twice: on arrival it is the battery of the last block driven
 * through (it drops on entering a block); at the first stop it is what the
 * wait before departure ended with.
 *
 * @param intervals the timeline of the service's vehicle
 * @param conflicts conflicts that include this service
 */
export function stopRows(service: Service, intervals: Interval[], conflicts: Conflict[]): StopRow[] {
  const via = viaBlocks(service);
  const last = service.stops.length - 1;
  const rows: StopRow[] = service.stops.map((stop, i) => {
    const arrival = stop.arrival === null ? null : parseHms(stop.arrival);
    const departure = stop.departure === null ? null : parseHms(stop.departure);
    return {
      at: stop.at,
      via: via[i],
      arrival,
      departure,
      dwell: arrival !== null && departure !== null ? departure - arrival : null,
      battery: batteryAt(service, i, arrival, departure, intervals),
      marks: { station: [], via: new Map(), arrival: [], departure: [], battery: [] },
    };
  });

  for (const conflict of conflicts) {
    const [first] = conflict.resources;
    const start = conflict.start === null ? null : parseHms(conflict.start);
    const end = conflict.end === null ? null : parseHms(conflict.end);
    switch (conflict.type) {
      // Between vehicles: the places both want, while this one is there.
      case 'block':
      case 'interlocking':
      case 'platform': {
        const window = conflictWindow(conflict);
        rows.forEach((row, i) => {
          const here: [number, number] = [row.arrival ?? row.departure ?? 0, row.departure ?? row.arrival ?? 0];
          if (conflict.resources.includes(row.at) && overlaps(window, here)) row.marks.station.push(conflict);
          const previous = i > 0 ? rows[i - 1].departure : null;
          if (previous === null || row.arrival === null || !overlaps(window, [previous, row.arrival])) return;
          for (const block of row.via) {
            if (!conflict.resources.includes(block)) continue;
            const marked = row.marks.via.get(block) ?? [];
            if (!marked.includes(conflict)) row.marks.via.set(block, [...marked, conflict]);
          }
        });
        break;
      }
      case 'not_returned':
        rows[last].marks.station.push(conflict);
        break;
      // The times that contradict: arrives start, departs end.
      case 'dwell_too_short':
        for (const row of rows) {
          if (row.at !== first || row.arrival !== start) continue;
          row.marks.arrival.push(conflict);
          row.marks.departure.push(conflict);
        }
        break;
      case 'past_midnight':
        for (const row of rows) if (row.at === first && row.arrival === start) row.marks.arrival.push(conflict);
        break;
      // The later service leaves (start) before the earlier one arrives (end).
      case 'vehicle_overlap':
        if (rows[last].arrival === end) rows[last].marks.arrival.push(conflict);
        if (rows[0].departure === start) rows[0].marks.departure.push(conflict);
        break;
      // From the first block below 30 until back in the yard.
      case 'low_battery':
        for (const row of rows) {
          const time = row.arrival ?? row.departure;
          if (time !== null && start !== null && time >= start && (end === null || time <= end)) row.marks.battery.push(conflict);
        }
        break;
      case 'insufficient_charge':
        rows[0].marks.battery.push(conflict);
        break;
      // The end of the earlier service and the start of the later one. With
      // one service it is the first of the day: its start.
      case 'discontinuity':
        if (conflict.services.length === 2 && conflict.services[0] === service.id) {
          rows[last].marks.station.push(conflict);
        } else {
          rows[0].marks.station.push(conflict);
        }
        break;
    }
  }
  return rows;
}

/** For each stop, the blocks from the previous stop: Y B1 P1A B3 B5 P2A -> [[], [B1], [B3, B5]]. */
export function viaBlocks(service: Service): string[][] {
  const via: string[][] = [[]];
  let blocks: string[] = [];
  for (const node of service.path.slice(1)) {
    if (BLOCK.test(node)) {
      blocks.push(node);
    } else {
      via.push(blocks);
      blocks = [];
    }
  }
  return via;
}

function batteryAt(
  service: Service,
  index: number,
  arrival: number | null,
  departure: number | null,
  intervals: Interval[],
): number | null {
  if (index === 0) {
    const wait = intervals.find((i) => i.end === departure && i.service !== service.id);
    return wait?.battery_end ?? null;
  }
  const block = intervals.find((i) => i.service === service.id && i.end === arrival && BLOCK.test(i.at));
  return block?.battery_end ?? null;
}

/** A conflict's time window; missing ends are open. Some windows are given end first. */
function conflictWindow(conflict: Conflict): [number, number] {
  const start = conflict.start === null ? -Infinity : parseHms(conflict.start);
  const end = conflict.end === null ? Infinity : parseHms(conflict.end);
  return [Math.min(start, end), Math.max(start, end)];
}

function overlaps([a1, a2]: [number, number], [b1, b2]: [number, number]): boolean {
  return a1 <= b2 && b1 <= a2;
}

// --- the day at a glance -----------------------------------------------------

/** From the first departure to the last arrival. */
export function serviceSpan(service: Service): [number, number] | null {
  const departure = service.stops[0]?.departure;
  const arrival = service.stops.at(-1)?.arrival;
  return departure && arrival ? [parseHms(departure), parseHms(arrival)] : null;
}

export interface ChartRange {
  start: number;
  end: number;
  /** Hour lines, labelled every 1, 2 or 3 hours so the labels don't crowd. */
  ticks: number[];
}

/**
 * Whole hours around all services, e.g. 08:00:00–19:05:00 -> 08:00–20:00.
 * It runs past 24:00 when a service does. Null when there are no services.
 */
export function chartRange(services: Service[]): ChartRange | null {
  const spans = services.map(serviceSpan).filter((s): s is [number, number] => s !== null);
  if (spans.length === 0) return null;
  const start = Math.floor(Math.min(...spans.map((s) => s[0])) / 3600) * 3600;
  let end = Math.ceil(Math.max(...spans.map((s) => s[1])) / 3600) * 3600;
  if (end === start) end += 3600;
  const hours = (end - start) / 3600;
  const step = (hours <= 12 ? 1 : hours <= 24 ? 2 : 3) * 3600;
  const ticks: number[] = [];
  for (let t = start; t <= end; t += step) ticks.push(t);
  return { start, end, ticks };
}

/** Where a span sits on the chart, in percent of its width. */
export function chartPosition([from, to]: [number, number], range: ChartRange): { left: number; width: number } {
  const length = range.end - range.start;
  return { left: ((from - range.start) / length) * 100, width: ((to - from) / length) * 100 };
}

/** "118 · 08:00:00–09:02:30". */
export function spanLabel(service: Service): string {
  const span = serviceSpan(service);
  return span ? `${service.id} · ${formatHms(span[0])}–${formatHms(span[1])}` : String(service.id);
}
