/**
 * Playback of the timeline (Bonus 2.2). Every frame asks one
 * question: at time t, which interval is each vehicle in? Everything here is
 * computed from t alone, so jumping back and forth needs no extra handling.
 */
import { BLOCK_LINE_BY_ID, Point, RUN_BY_BLOCK, STATIONS } from '../track-map/layout';
import { Conflict, Interval, VehicleTimeline } from './models';
import { DAY_SECONDS, parseHms } from './time';

/** How far apart vehicles at the same station are drawn. */
export const STACK_SPACING = 42;

export interface VehicleState {
  vehicle: string;
  interval: Interval;
  position: Point;
}

/**
 * Where a vehicle in `interval` is drawn at time t. On a block it runs from
 * one end to the other, starting or ending at a station's centre where the
 * block touches one, so it moves on from where it was stopped.
 */
export function positionAt(interval: Interval, t: number): Point {
  const line = BLOCK_LINE_BY_ID.get(interval.at);
  const run = RUN_BY_BLOCK.get(interval.at);
  if (!line || !run) return STATIONS[interval.at];
  const span = interval.end - interval.start;
  let ratio = span > 0 ? Math.min(Math.max((t - interval.start) / span, 0), 1) : 0;
  if (line.backwardToward !== undefined && interval.toward === line.backwardToward) {
    ratio = 1 - ratio;
  }
  return alongPoints(run, ratio);
}

/** The point `ratio` of the way along a line through `points`, at an even speed. */
export function alongPoints(points: Point[], ratio: number): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = ratio * lengths.reduce((a, b) => a + b, 0);
  for (const [i, length] of lengths.entries()) {
    if (left <= length || i === lengths.length - 1) {
      const part = length > 0 ? Math.min(left / length, 1) : 0;
      const [a, b] = [points[i], points[i + 1]];
      return { x: a.x + (b.x - a.x) * part, y: a.y + (b.y - a.y) * part };
    }
    left -= length;
  }
  return points[0];
}

/**
 * Every interval that contains t. A vehicle whose services overlap is in
 * two places at once and is drawn twice, which shows the problem.
 * Vehicles at the same station are spread out side by side.
 */
export function vehicleStates(timelines: VehicleTimeline[], t: number): VehicleState[] {
  const states: VehicleState[] = [];
  for (const { vehicle, intervals } of timelines) {
    for (const interval of intervals) {
      if (interval.start <= t && t < interval.end) {
        states.push({ vehicle, interval, position: positionAt(interval, t) });
      }
    }
  }
  const atStation = new Map<string, VehicleState[]>();
  for (const state of states) {
    if (BLOCK_LINE_BY_ID.has(state.interval.at)) continue;
    const list = atStation.get(state.interval.at) ?? [];
    list.push(state);
    atStation.set(state.interval.at, list);
  }
  for (const list of atStation.values()) {
    list.forEach((state, i) => {
      const offset = (i - (list.length - 1) / 2) * STACK_SPACING;
      state.position = { x: state.position.x + offset, y: state.position.y };
    });
  }
  return states;
}

/** What a vehicle is doing, for the table under the map. */
export type VehicleStatus = 'Running' | 'Stopped' | 'Charging' | 'In yard' | 'Two places' | 'Stranded' | 'Not returned';

/** Statuses that are a problem in the schedule, shown in red. */
export const PROBLEM_STATUSES: ReadonlySet<VehicleStatus> = new Set(['Two places', 'Stranded', 'Not returned']);

/** @param here every interval the vehicle is in at t (two when its services overlap) */
export function vehicleStatus(here: Interval[], t: number): VehicleStatus | null {
  if (here.length === 0) return null;
  if (here.length > 1) return 'Two places';
  const [interval] = here;
  if (interval.gap === 'discontinuity') return 'Stranded';
  if (interval.gap === 'not_returned') return 'Not returned';
  if (BLOCK_LINE_BY_ID.has(interval.at)) return 'Running';
  if (interval.at !== 'Y') return 'Stopped';
  const battery = batteryAt(interval, t);
  return battery !== null && interval.battery_end !== null && battery < interval.battery_end ? 'Charging' : 'In yard';
}

/** The yard charges 1 unit every 12 seconds (spec, Bonus 1.3). */
export const CHARGE_SECONDS_PER_UNIT = 12;

/**
 * Battery at time t. Constant except while charging in the yard, where it
 * climbs one unit per 12 seconds up to what the backend computed for the end.
 */
export function batteryAt(interval: Interval, t: number): number | null {
  const { battery_start: start, battery_end: end } = interval;
  if (start === null || end === null) return null;
  if (end <= start) return end;
  const charged = Math.floor(Math.max(0, t - interval.start) / CHARGE_SECONDS_PER_UNIT);
  return Math.min(end, start + charged);
}

/** When a service runs: from its first departure to its last arrival. */
export function serviceSpans(timelines: VehicleTimeline[]): Map<number, [number, number]> {
  const spans = new Map<number, [number, number]>();
  for (const { intervals } of timelines) {
    for (const i of intervals) {
      if (i.service === null) continue;
      const span = spans.get(i.service);
      spans.set(i.service, span ? [Math.min(span[0], i.start), Math.max(span[1], i.end)] : [i.start, i.end]);
    }
  }
  return spans;
}

export interface ConflictWindow {
  conflict: Conflict;
  start: number;
  end: number;
  /**
   * True when the conflict has a real time window, so its places light up.
   * Otherwise it is shown on the vehicles for as long as their services run.
   */
  exact: boolean;
}

/**
 * When each conflict is shown during playback. Some conflicts are a single
 * moment, have an empty window, or no time at all; at ×60 they would flash
 * for one frame. Those are shown while their services run.
 */
export function conflictWindows(conflicts: Conflict[], timelines: VehicleTimeline[]): ConflictWindow[] {
  const spans = serviceSpans(timelines);
  const windows: ConflictWindow[] = [];
  for (const conflict of conflicts) {
    const start = conflict.start !== null ? parseHms(conflict.start) : null;
    const end = conflict.end !== null ? parseHms(conflict.end) : null;
    if (start !== null && end !== null && end > start) {
      windows.push({ conflict, start, end, exact: true });
      continue;
    }
    for (const id of conflict.services) {
      const span = spans.get(id);
      if (span) windows.push({ conflict, start: span[0], end: span[1], exact: false });
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

export function activeWindows(windows: ConflictWindow[], t: number): ConflictWindow[] {
  return windows.filter((w) => w.start <= t && t < w.end);
}

/** Jumping to a conflict lands a few seconds before it starts. */
export const JUMP_LEAD_SECONDS = 3;

export function jumpTargets(windows: ConflictWindow[]): number[] {
  return [...new Set(windows.map((w) => Math.max(0, w.start - JUMP_LEAD_SECONDS)))].sort((a, b) => a - b);
}

export function nextTarget(targets: number[], t: number): number | null {
  return targets.find((target) => target > t + 0.5) ?? null;
}

export function previousTarget(targets: number[], t: number): number | null {
  return [...targets].reverse().find((target) => target < t - 0.5) ?? null;
}

/** 00:00 to 24:00, longer when a flagged service arrives after midnight. */
export function playbackEnd(timelines: VehicleTimeline[]): number {
  let end = DAY_SECONDS;
  for (const { intervals } of timelines) {
    for (const i of intervals) end = Math.max(end, i.end);
  }
  return end;
}

/** Playback opens a minute before the first departure of the day. */
export function openingTime(timelines: VehicleTimeline[]): number {
  let first = Infinity;
  for (const { intervals } of timelines) {
    for (const i of intervals) {
      if (i.service !== null) first = Math.min(first, i.start);
    }
  }
  return first === Infinity ? 0 : Math.max(0, first - 60);
}
