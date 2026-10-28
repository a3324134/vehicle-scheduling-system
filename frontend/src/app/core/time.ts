export const DAY_SECONDS = 24 * 3600;

/** "08:01:30" -> 28890. Hours may pass 24. */
export function parseHms(text: string): number {
  const [hours, minutes, seconds = 0] = text.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

/** 28890 -> "08:01:30". Hours may pass 24. */
export function formatHms(seconds: number): string {
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export const TIME_FORMAT_MSG = 'Use 24-hour time, HH:MM:SS (e.g. 13:05:00)';
export const TIME_FORMAT_MSG_MINUTES = 'Use 24-hour time, HH:MM (e.g. 08:00)';

/** Departures are typed to the second; a time range for generating, to the minute. */
export type ClockParts = 2 | 3;

const CLOCK_PATTERNS: Record<ClockParts, RegExp> = {
  3: /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  2: /^(\d{1,2}):(\d{2})$/,
};

/**
 * A time typed by hand, 24-hour: "13:05:00", "13:05" or "8:05" (only the
 * last two with `parts` 2). Returns seconds since midnight, or null if it is
 * not a time of day.
 */
export function parseClock(text: string, parts: ClockParts = 3): number | null {
  const match = CLOCK_PATTERNS[parts].exec(text.trim());
  if (!match) return null;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** 300 -> "5 min", 135 -> "2 min 15 s", 40 -> "40 s". */
export function formatDuration(seconds: number): string {
  // A stop can be negative when a slower block makes the vehicle arrive after it should leave.
  if (seconds < 0) return `-${formatDuration(-seconds)}`;
  const [minutes, rest] = [Math.floor(seconds / 60), seconds % 60];
  if (rest === 0) return `${minutes} min`;
  return minutes ? `${minutes} min ${rest} s` : `${rest} s`;
}

/** "08:05:00", or "08:05" with `parts` 2. Within one day. */
export function formatClock(seconds: number, parts: ClockParts = 3): string {
  return formatHms(seconds).slice(0, parts * 3 - 1);
}

/** Typed in full ("08:05:00", or "08:05"), so it can be used while the user is still typing. */
export function isFullClock(text: string, parts: ClockParts = 3): boolean {
  const full = parts === 3 ? /^\d{2}:\d{2}:\d{2}$/ : /^\d{2}:\d{2}$/;
  return full.test(text) && parseClock(text, parts) !== null;
}

const PART_SECONDS = [3600, 60, 1];

export interface ClockStep {
  seconds: number;
  text: string;
  /** The part that was changed, to keep it selected for the next key press. */
  selection: [number, number];
}

/**
 * ↑/↓ in a time box: change the hour, minute or second the cursor is in by
 * one, carrying into the next part (08:59:59 + 1 s = 09:00:00) and staying
 * within the day (up to 23:59:59, or 23:59). An empty box is filled with
 * `empty`, hours selected.
 * Returns null for text that is not a time, which is left for the user to fix.
 */
export function stepClock(
  text: string,
  caret: number,
  delta: 1 | -1,
  empty: number,
  parts: ClockParts = 3,
): ClockStep | null {
  if (text.trim() === '') return clockStep(empty, 0, parts);
  const current = parseClock(text, parts);
  if (current === null) return null;
  const part = Math.min(parts - 1, text.slice(0, caret).split(':').length - 1);
  return clockStep(current + delta * PART_SECONDS[part], part, parts);
}

function clockStep(seconds: number, part: number, parts: ClockParts): ClockStep {
  const last = DAY_SECONDS - PART_SECONDS[parts - 1];
  const clamped = Math.min(last, Math.max(0, seconds));
  return { seconds: clamped, text: formatClock(clamped, parts), selection: [part * 3, part * 3 + 2] };
}
