import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSliderModule } from '@angular/material/slider';

import { CATEGORY_OF, foldConflicts, groupDetails, groupType, sortGroups } from '../core/conflicts';
import { Conflict, VehicleTimeline } from '../core/models';
import {
  activeWindows,
  batteryAt,
  conflictWindows,
  jumpTargets,
  nextTarget,
  openingTime,
  PROBLEM_STATUSES,
  playbackEnd,
  previousTarget,
  VehicleStatus,
  vehicleStates,
  vehicleStatus,
} from '../core/simulation';
import { LOW_BATTERY } from '../core/schedule';
import { formatHms } from '../core/time';
import { TrackMap, VehicleMarker, vehicleColor } from '../track-map/track-map';

export const SPEEDS = [10, 60, 300, 600];

interface Row {
  vehicle: string;
  /** Its colour on the map. */
  color: string;
  location: string;
  service: string;
  battery: number | null;
  status: VehicleStatus | null;
  /** In a conflict shown right now (red ring on the map). */
  conflict: boolean;
}

/** A line of "Conflicts now", in the words of the schedule's conflicts table. */
interface ConflictNow {
  type: string;
  details: string;
  services: string;
  /** When it stops being shown. */
  until: string;
}

/** Viewer's simulation mode: plays the timeline back on the track map (Bonus 2.2). */
@Component({
  selector: 'app-simulation',
  imports: [TrackMap, MatButtonModule, MatButtonToggleModule, MatSliderModule],
  templateUrl: './simulation.html',
  styleUrl: './simulation.css',
})
export class Simulation {
  readonly timelines = input.required<VehicleTimeline[]>();
  readonly conflicts = input.required<Conflict[]>();
  readonly vehicleOf = input.required<ReadonlyMap<number, string>>();
  /** Where to start, e.g. from a time in the conflicts table. */
  readonly startAt = input<number | null>(null);
  /** Emitted when playback stops somewhere, so the page can keep it in the URL. */
  readonly timeSettled = output<number>();

  protected readonly speeds = SPEEDS;
  protected readonly time = signal(0);
  protected readonly playing = signal(false);
  protected readonly speed = signal(60);

  protected readonly end = computed(() => playbackEnd(this.timelines()));
  protected readonly windows = computed(() => conflictWindows(this.conflicts(), this.timelines()));
  private readonly targets = computed(() => jumpTargets(this.windows()));
  protected readonly hasNext = computed(() => nextTarget(this.targets(), this.time()) !== null);
  protected readonly hasPrevious = computed(() => previousTarget(this.targets(), this.time()) !== null);

  private readonly states = computed(() => vehicleStates(this.timelines(), this.time()));
  private readonly active = computed(() => activeWindows(this.windows(), this.time()));

  /**
   * Places two vehicles are fighting over light up red. Other conflicts only
   * mark the vehicle: their resources aren't occupied places, e.g. a
   * discontinuity's resources are "ended here, next starts there".
   */
  protected readonly lit = computed(
    () =>
      new Set(
        this.active()
          .filter((w) => w.exact && CATEGORY_OF[w.conflict.type] === 'cross')
          .flatMap((w) => w.conflict.resources),
      ),
  );
  private readonly warnedVehicles = computed(
    () => new Set(this.active().flatMap((w) => w.conflict.services.map((id) => this.vehicleOf().get(id)))),
  );
  protected readonly markers = computed<VehicleMarker[]>(() =>
    this.states().map((s, i, all) => ({
      // A vehicle is normally drawn once; a second marker only when its services overlap.
      key: `${s.vehicle}-${all.slice(0, i).filter((o) => o.vehicle === s.vehicle).length}`,
      vehicle: s.vehicle,
      service: s.interval.service,
      position: s.position,
      stranded: s.interval.gap !== null,
      warning: this.warnedVehicles().has(s.vehicle),
    })),
  );
  protected readonly rows = computed<Row[]>(() =>
    this.timelines().map(({ vehicle }) => {
      const here = this.states().filter((s) => s.vehicle === vehicle);
      const t = this.time();
      return {
        vehicle,
        color: vehicleColor(vehicle),
        location: here.map((s) => (s.interval.toward ? `${s.interval.at} → ${s.interval.toward}` : s.interval.at)).join(' and ') || '—',
        service: here.map((s) => s.interval.service ?? '—').join(', ') || '—',
        battery: here.length ? batteryAt(here[0].interval, t) : null,
        status: vehicleStatus(
          here.map((s) => s.interval),
          t,
        ),
        conflict: this.warnedVehicles().has(vehicle),
      };
    }),
  );
  protected readonly problemStatuses = PROBLEM_STATUSES;

  /** The conflicts shown right now, folded and worded like the schedule's conflicts table. */
  protected readonly conflictsNow = computed<ConflictNow[]>(() => {
    const until = new Map<Conflict, number>();
    for (const w of this.active()) until.set(w.conflict, Math.max(until.get(w.conflict) ?? 0, w.end));
    return sortGroups(foldConflicts([...until.keys()])).map((group) => ({
      type: groupType(group),
      details: groupDetails(group),
      services: group.services.map((id) => `${this.vehicleOf().get(id) ?? '?'}·${id}`).join(', '),
      until: formatHms(Math.max(...group.conflicts.map((c) => until.get(c)!))),
    }));
  });

  private frame: number | null = null;
  private lastTimestamp: number | null = null;

  constructor() {
    // Start where the link pointed, or a minute before the first departure.
    effect(() => {
      const start = this.startAt();
      const timelines = this.timelines();
      untracked(() => this.time.set(start ?? openingTime(timelines)));
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Also the slider's displayWith, so it must not rely on `this`. */
  protected readonly format = (seconds: number): string => formatHms(seconds);

  protected isLow(battery: number | null): boolean {
    return battery !== null && battery < LOW_BATTERY;
  }

  protected toggle(): void {
    if (this.playing()) {
      this.pause();
      return;
    }
    if (this.time() >= this.end()) this.time.set(0);
    this.playing.set(true);
    this.lastTimestamp = null;
    this.frame = requestAnimationFrame((ts) => this.tick(ts));
  }

  private tick(timestamp: number): void {
    if (this.lastTimestamp !== null) {
      const next = this.time() + ((timestamp - this.lastTimestamp) / 1000) * this.speed();
      if (next >= this.end()) {
        this.time.set(this.end());
        this.pause();
        return;
      }
      this.time.set(next);
    }
    this.lastTimestamp = timestamp;
    this.frame = requestAnimationFrame((ts) => this.tick(ts));
  }

  private stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.playing.set(false);
  }

  private pause(): void {
    this.stop();
    this.time.set(Math.floor(this.time()));
    this.timeSettled.emit(this.time());
  }

  protected seek(seconds: number): void {
    this.time.set(seconds);
  }

  /** The slider was released. */
  protected settle(): void {
    if (!this.playing()) this.timeSettled.emit(this.time());
  }

  protected jumpTo(target: number | null): void {
    if (target === null) return;
    this.stop();
    this.time.set(target);
    this.timeSettled.emit(target);
  }

  protected next(): void {
    this.jumpTo(nextTarget(this.targets(), this.time()));
  }

  protected previous(): void {
    this.jumpTo(previousTarget(this.targets(), this.time()));
  }

  protected restart(): void {
    this.jumpTo(openingTime(this.timelines()));
  }
}
