import { Component, Injector, afterNextRender, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';

import { Api, failureMessage } from '../core/api';
import {
  CATEGORY_LABELS,
  CATEGORY_OF,
  ConflictCategory,
  ConflictGroup,
  conflictsOf,
  describe,
  foldConflicts,
  groupDetails,
  groupTime,
  groupType,
  sortGroups,
} from '../core/conflicts';
import { Conflict, Service, VehicleTimeline } from '../core/models';
import { LOW_BATTERY, StopRow, chartPosition, chartRange, serviceSpan, spanLabel, stopRows } from '../core/schedule';
import { JUMP_LEAD_SECONDS } from '../core/simulation';
import { formatDuration, formatHms, parseHms } from '../core/time';
import { ConflictMark, PointedConflicts } from '../shared/conflict-mark';
import { Chart, ScheduleChart } from './schedule-chart';
import { Simulation } from './simulation';

type Mode = 'schedule' | 'simulation';
/** Which conflicts the conflicts table lists. */
type Filter = 'all' | ConflictCategory;

interface ServiceRow {
  service: Service;
  groups: ConflictGroup[];
}

interface VehicleSection {
  vehicle: string;
  rows: ServiceRow[];
  /** Conflicts of this vehicle's services, a run between two services counted once. */
  total: number;
}

/**
 * Schedule Viewer. Schedule mode groups services by vehicle;
 * simulation mode plays them back on the track map. Both read the URL, e.g.
 * /viewer?mode=simulation&t=08:00:30.
 */
@Component({
  selector: 'app-viewer',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatTabsModule,
    MatTooltipModule,
    ConflictMark,
    ScheduleChart,
    Simulation,
  ],
  providers: [PointedConflicts],
  templateUrl: './viewer.html',
  styleUrl: './viewer.css',
})
export class Viewer {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  // Query parameters, bound by the router.
  readonly mode = input<Mode, string | undefined>('schedule', { transform: (v) => (v === 'simulation' ? 'simulation' : 'schedule') });
  readonly t = input<string>();
  readonly filter = input<Filter, string | undefined>('all', { transform: toFilter });

  protected readonly vehicles = signal<string[]>([]);
  protected readonly services = signal<Service[]>([]);
  protected readonly conflicts = signal<Conflict[]>([]);
  protected readonly timelines = signal<VehicleTimeline[] | null>(null);
  protected readonly loadError = signal<string | null>(null);

  protected readonly filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    ...(Object.entries(CATEGORY_LABELS) as [ConflictCategory, string][]).map(([value, label]) => ({ value, label })),
  ];

  protected readonly vehicleOf = computed(() => new Map(this.services().map((s) => [s.id, s.vehicle])));
  protected readonly startAt = computed(() => {
    const t = this.t();
    return t && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t) ? parseHms(t) : null;
  });

  /** The whole schedule, whatever the filter: it only filters the conflicts table. */
  protected readonly sections = computed<VehicleSection[]>(() =>
    this.vehicles().map((vehicle) => {
      const rows = this.services()
        .filter((s) => s.vehicle === vehicle)
        .sort((a, b) => departure(a) - departure(b) || a.id - b.id)
        .map((service) => ({ service, groups: foldConflicts(conflictsOf(this.conflicts(), service.id)) }));
      return { vehicle, rows, total: rows.reduce((n, r) => n + r.groups.length, 0) };
    }),
  );

  // --- every conflict once, in one table ---

  /** All conflicts, a run between the same two services folded into one row. */
  protected readonly conflictCount = computed(() => foldConflicts(this.conflicts()).length);
  /** The rows of the table, under the filter. */
  protected readonly conflictRows = computed(() =>
    sortGroups(foldConflicts(this.conflicts().filter((c) => matches(c, this.filter())))),
  );
  /**
   * A ⚠ next to a service was clicked: scroll to its conflicts and flash them,
   * fading in 2 seconds. A filter that hides them is cleared first.
   */
  protected async showConflicts(id: number, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.conflictRows().some((group) => group.services.includes(id))) {
      this.flashConflicts(id);
      return;
    }
    await this.router.navigate([], { queryParams: { filter: null }, queryParamsHandling: 'merge', replaceUrl: true });
    afterNextRender(() => this.flashConflicts(id), { injector: this.injector });
  }

  private flashConflicts(id: number): void {
    const rows = [...document.querySelectorAll<HTMLElement>(`[data-services~="${id}"]`)];
    rows[0]?.scrollIntoView({ block: 'center' });
    for (const row of rows) {
      const color = getComputedStyle(row).getPropertyValue('--mat-sys-error-container');
      row.animate([{ backgroundColor: color }, { backgroundColor: 'transparent' }], { duration: 2000, easing: 'ease-in' });
    }
  }

  protected readonly groupType = groupType;
  protected readonly groupDetails = groupDetails;

  // --- the timetable of a service, opened from its row ---

  /** Services whose stops are shown. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());
  private readonly intervalsOf = computed(
    () => new Map((this.timelines() ?? []).map((timeline) => [timeline.vehicle, timeline.intervals])),
  );
  protected readonly stopsOf = computed(() => {
    const stops = new Map<number, StopRow[]>();
    for (const service of this.services()) {
      if (!this.expanded().has(service.id)) continue;
      const intervals = this.intervalsOf().get(service.vehicle) ?? [];
      stops.set(service.id, stopRows(service, intervals, conflictsOf(this.conflicts(), service.id)));
    }
    return stops;
  });

  protected toggle(id: number): void {
    this.expanded.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // --- the day at a glance ---

  /** Every service; those with conflicts in red. */
  protected readonly chart = computed<Chart | null>(() => {
    const range = chartRange(this.services());
    if (!range) return null;
    return {
      ticks: range.ticks.map((t) => ({ left: chartPosition([t, t], range).left, label: formatHms(t).slice(0, 5) })),
      rows: this.vehicles().map((vehicle) => ({
        vehicle,
        bars: this.services()
          .filter((service) => service.vehicle === vehicle && serviceSpan(service) !== null)
          .map((service) => {
            const conflict = conflictsOf(this.conflicts(), service.id).length > 0;
            return {
              id: service.id,
              ...chartPosition(serviceSpan(service)!, range),
              label: spanLabel(service) + (conflict ? ' · has conflicts' : ''),
              conflict,
            };
          }),
      })),
    };
  });

  /** A bar or a service in the conflicts table was clicked: open that service's stops and scroll to it. */
  protected reveal(id: number): void {
    this.expanded.update((ids) => new Set(ids).add(id));
    afterNextRender(() => document.getElementById(`service-${id}`)?.scrollIntoView({ block: 'center' }), {
      injector: this.injector,
    });
  }

  constructor() {
    this.load();
  }

  private async load(): Promise<void> {
    try {
      const [vehicles, services, conflicts, timelines] = await Promise.all([
        this.api.vehicles(),
        this.api.services(),
        this.api.conflicts(),
        this.api.timeline(),
      ]);
      this.vehicles.set(vehicles);
      this.services.set(services);
      this.conflicts.set(conflicts);
      this.timelines.set(timelines);
    } catch (error) {
      this.loadError.set(failureMessage(error));
    }
  }

  protected setQuery(params: Record<string, string | null>): void {
    this.router.navigate([], { queryParams: params, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected rememberTime(seconds: number): void {
    this.setQuery({ t: formatHms(seconds) });
  }

  /**
   * Query parameters for the simulation, from the time in the conflicts table: a few
   * seconds before the conflict starts. One with no time (not returned) is
   * shown as its service arrives.
   */
  protected simulationLink(group: ConflictGroup): { mode: string; t: string } {
    const start = group.start ?? group.end ?? this.lastArrival(group) ?? '00:00:00';
    return { mode: 'simulation', t: formatHms(Math.max(0, parseHms(start) - JUMP_LEAD_SECONDS)) };
  }

  /** The Time column. A service not returned has no time: it shows when it arrives and stays. */
  protected conflictTime(group: ConflictGroup): string {
    const time = groupTime(group);
    return time === '—' ? (this.lastArrival(group) ?? time) : time;
  }

  private lastArrival(group: ConflictGroup): string | null {
    return this.services().find((s) => s.id === group.services[0])?.stops.at(-1)?.arrival ?? null;
  }

  /** "1 conflict", "2 conflicts". */
  protected count(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  /** What a red cell in the timetable is about, one line per conflict; empty for no tooltip. */
  protected tip(conflicts: Conflict[] | undefined, service: Service): string {
    return (conflicts ?? []).map((c) => describe(c, service.id, this.vehicleOf())).join('\n');
  }

  protected time(seconds: number | null): string {
    return seconds === null ? '—' : formatHms(seconds);
  }

  protected dwell(seconds: number | null): string {
    return seconds === null ? '—' : formatDuration(seconds);
  }

  protected isLow(battery: number | null): boolean {
    return battery !== null && battery < LOW_BATTERY;
  }

  protected isPastMidnight(service: Service): boolean {
    const arrival = service.stops.at(-1)?.arrival;
    return arrival !== null && arrival !== undefined && parseHms(arrival) >= 24 * 3600;
  }
}

function departure(service: Service): number {
  return parseHms(service.stops[0].departure ?? '0:0:0');
}

function toFilter(value: string | undefined): Filter {
  const allowed: Filter[] = ['all', 'time', 'vehicle', 'cross', 'battery'];
  return allowed.includes(value as Filter) ? (value as Filter) : 'all';
}

function matches(conflict: Conflict, filter: Filter): boolean {
  return filter === 'all' || CATEGORY_OF[conflict.type] === filter;
}
