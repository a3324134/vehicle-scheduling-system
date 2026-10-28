import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router } from '@angular/router';

import { Api, failureMessage, fieldErrors } from '../core/api';
import { confirmWith } from '../core/confirm';
import { ScheduleLimits } from '../core/models';
import { TIME_FORMAT_MSG_MINUTES, formatClock, formatDuration, isFullClock, parseClock, stepClock } from '../core/time';

/** The spec's example range. */
const DEFAULT_START = '08:00';
const DEFAULT_END = '18:00';
/** Wait for typing to pause before asking for the shortest interval. */
const LIMITS_DELAY_MS = 250;

type RangeField = 'start' | 'end';

/**
 * The Editor's Auto-generate tab (Bonus 3): replaces the
 * whole schedule with a generated one.
 */
@Component({
  selector: 'app-generate',
  imports: [MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSnackBarModule],
  templateUrl: './generate.html',
  styleUrl: './generate.css',
})
export class Generate {
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);

  /** Services that generating deletes. */
  readonly serviceCount = input(0);
  /** The Manual tab has a draft that generating throws away. */
  readonly unsavedChanges = input(false);

  // What is typed; a time is taken once it is complete or the box is left.
  protected readonly start = signal(DEFAULT_START);
  protected readonly end = signal(DEFAULT_END);
  protected readonly intervalText = signal('');

  protected readonly limits = signal<ScheduleLimits | null>(null);
  protected readonly limitsError = signal<string | null>(null);
  protected readonly serverError = signal<string | null>(null);
  protected readonly generating = signal(false);

  private readonly startSeconds = computed(() => parseClock(this.start(), 2));
  private readonly endSeconds = computed(() => parseClock(this.end(), 2));

  protected readonly rangeError = computed<{ field: RangeField; msg: string } | null>(() => {
    if (this.startSeconds() === null) return { field: 'start', msg: TIME_FORMAT_MSG_MINUTES };
    if (this.endSeconds() === null) return { field: 'end', msg: TIME_FORMAT_MSG_MINUTES };
    if (this.endSeconds()! <= this.startSeconds()!) return { field: 'end', msg: 'End must be later than start' };
    return null;
  });

  protected readonly interval = computed(() => {
    const text = this.intervalText().trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  });

  protected readonly intervalError = computed(() => {
    if (this.serverError()) return this.serverError();
    if (this.intervalText().trim() === '') return 'Enter the interval in minutes';
    const minutes = this.interval();
    if (minutes === null || minutes < 1) return 'Whole minutes, 1 or more';
    const limits = this.limits();
    if (!limits || limits.shortest_interval_minutes === null) return null;
    if (minutes < limits.shortest_interval_minutes) {
      return `At least ${limits.shortest_interval_minutes} min with the current block times`;
    }
    if (minutes > limits.longest_interval_minutes) {
      return `At most ${limits.longest_interval_minutes} min for this time range`;
    }
    return null;
  });

  protected readonly canGenerate = computed(
    () =>
      !this.generating() &&
      this.rangeError() === null &&
      this.intervalError() === null &&
      this.limits()?.shortest_interval_minutes != null,
  );

  /** Ignores answers to older requests. */
  private request = 0;

  constructor() {
    // Ask for the shortest interval whenever the range changes: at
    // once for the first range, then once typing pauses.
    effect((onCleanup) => {
      const [start, end] = [this.startSeconds(), this.endSeconds()];
      const request = ++this.request;
      if (this.rangeError() !== null || start === null || end === null) {
        untracked(() => this.limits.set(null));
        return;
      }
      const load = () => this.loadLimits(formatClock(start, 2), formatClock(end, 2), request);
      if (request === 1) {
        load();
        return;
      }
      const timer = setTimeout(load, LIMITS_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async loadLimits(start: string, end: string, request: number): Promise<void> {
    try {
      const limits = await this.api.scheduleLimits(start, end);
      if (request !== this.request) return;
      this.limits.set(limits);
      this.limitsError.set(null);
      // Start from the shortest interval that works, until the user types one.
      if (this.intervalText() === '' && limits.shortest_interval_minutes !== null) {
        this.intervalText.set(String(limits.shortest_interval_minutes));
      }
    } catch (error) {
      if (request === this.request) this.limitsError.set(failureMessage(error));
    }
  }

  // --- the time boxes, 24-hour HH:MM like the departures in Manual ---

  protected typeTime(field: RangeField, text: string): void {
    if (isFullClock(text, 2)) this.setTime(field, text);
  }

  protected finishTime(field: RangeField, input: HTMLInputElement): void {
    const seconds = parseClock(input.value, 2);
    const text = seconds === null ? input.value.trim() : formatClock(seconds, 2);
    input.value = text;
    this.setTime(field, text);
  }

  protected stepTime(field: RangeField, event: KeyboardEvent, input: HTMLInputElement): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const empty = parseClock(field === 'start' ? DEFAULT_START : DEFAULT_END, 2)!;
    const step = stepClock(input.value, input.selectionStart ?? 0, event.key === 'ArrowUp' ? 1 : -1, empty, 2);
    if (!step) return;
    input.value = step.text;
    input.setSelectionRange(...step.selection);
    this.setTime(field, step.text);
  }

  private setTime(field: RangeField, text: string): void {
    (field === 'start' ? this.start : this.end).set(text);
    this.serverError.set(null);
  }

  protected readonly replacesText = computed(() => {
    const count = this.serviceCount();
    if (count === 0) return 'There are no services yet.';
    return count === 1 ? 'Replaces the 1 service.' : `Replaces all ${count} services.`;
  });

  protected setInterval(text: string): void {
    this.intervalText.set(text);
    this.serverError.set(null);
  }

  // --- generating ---

  protected async generate(): Promise<void> {
    const count = this.serviceCount();
    if (count > 0 || this.unsavedChanges()) {
      const deleted = count === 1 ? 'the 1 service' : `all ${count} services`;
      const lost = this.unsavedChanges() ? ' Your unsaved changes in Manual will be lost too.' : '';
      const ok = await confirmWith(this.dialog, {
        title: 'Replace the schedule?',
        message: `This deletes ${deleted} and generates new ones.${lost}`,
        confirm: 'Replace',
      });
      if (!ok) return;
    }
    this.generating.set(true);
    try {
      const result = await this.api.generateSchedule({
        interval_minutes: this.interval()!,
        start: formatClock(this.startSeconds()!, 2),
        end: formatClock(this.endSeconds()!, 2),
      });
      this.snackBar.open(
        `Generated ${result.services} services with ${result.vehicles.length} vehicles, ${describeGap(result.gap_seconds)}`,
        undefined,
        { duration: 5000 },
      );
      await this.router.navigate(['/viewer']);
    } catch (error) {
      const errors = fieldErrors(error);
      if (errors) {
        this.serverError.set(errors.map((e) => e.msg).join(' '));
      } else {
        this.snackBar.open(failureMessage(error), 'Close');
      }
    } finally {
      this.generating.set(false);
    }
  }
}

/** [300, 300] -> "one every 5 min"; [299, 300] -> "one every 4 min 59 s to 5 min". */
function describeGap([shortest, longest]: [number, number]): string {
  const range = shortest === longest ? formatDuration(shortest) : `${formatDuration(shortest)} to ${formatDuration(longest)}`;
  return `one every ${range}`;
}
