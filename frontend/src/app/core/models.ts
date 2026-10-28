/** Shapes of the backend API. */

export const YARD = 'Y';

export interface Segment {
  start: string;
  end: string;
  blocks: string[];
}

export interface Track {
  stations: string[];
  blocks: string[];
  segments: Segment[];
  interlocking_groups: { id: number; blocks: string[] }[];
}

export interface Block {
  id: string;
  traversal_seconds: number;
}

export type BlockTimes = Record<string, number>;

export interface StopIn {
  at: string;
  departure?: string;
}

export interface ServiceIn {
  vehicle: string;
  stops: StopIn[];
}

export interface StopOut {
  at: string;
  arrival: string | null;
  departure: string | null;
}

export interface Service {
  id: number;
  vehicle: string;
  path: string[];
  stops: StopOut[];
}

export type ConflictType =
  | 'dwell_too_short'
  | 'past_midnight'
  | 'vehicle_overlap'
  | 'discontinuity'
  | 'not_returned'
  | 'block'
  | 'interlocking'
  | 'platform'
  | 'low_battery'
  | 'insufficient_charge';

export interface Conflict {
  type: ConflictType;
  services: number[];
  resources: string[];
  /** "HH:MM:SS"; hours can pass 24 for flagged arrivals. */
  start: string | null;
  end: string | null;
  detail: Record<string, number> | null;
}

/** Times are seconds since midnight. */
export interface Interval {
  at: string;
  toward: string | null;
  start: number;
  end: number;
  service: number | null;
  gap: 'discontinuity' | 'not_returned' | null;
  battery_start: number | null;
  battery_end: number | null;
}

export interface VehicleTimeline {
  vehicle: string;
  intervals: Interval[];
}

/** One entry of a 422 response (FastAPI's default shape). */
export interface FieldError {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/** The Auto-generate tab (Bonus 3). */
export interface ScheduleLimits {
  shortest_interval_minutes: number | null;
  longest_interval_minutes: number;
  /** Why one minute less than the shortest fails, or why nothing works. */
  reason: string | null;
}

export interface GenerateIn {
  interval_minutes: number;
  start: string;
  end: string;
}

export interface Generated {
  services: number;
  replaced: number;
  vehicles: string[];
  route: string[];
  /** Seconds between vehicles, [shortest, longest]; can be less than the interval. */
  gap_seconds: [number, number];
}
