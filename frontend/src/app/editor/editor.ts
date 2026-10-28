import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelect, MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';

import { Api, failureMessage, fieldErrors } from '../core/api';
import { confirmWith } from '../core/confirm';
import { conflictsOf, describe, foldConflicts } from '../core/conflicts';
import { BlockTimes, Conflict, FieldError, Service, Track, YARD } from '../core/models';
import {
  DraftStop,
  MIN_DWELL_SECONDS,
  checkDraft,
  computeArrivals,
  currentStation,
  nextSegments,
  nextStations,
  pathParts,
  pickOnMap,
  startFor,
} from '../core/routing';
import { stopRows } from '../core/schedule';
import { TIME_FORMAT_MSG, formatHms, isFullClock, parseClock, parseHms, stepClock } from '../core/time';
import { TrackMap } from '../track-map/track-map';
import { Generate } from './generate';

interface Draft {
  vehicle: string;
  stops: DraftStop[];
}

/** Default stop time filled in when a stop is added, so the user starts from something sensible. */
const DEFAULT_DWELL_SECONDS = 60;
type Tab = 'manual' | 'generate';

/** Where ↑/↓ start in an empty first-stop box. */
const FIRST_DEPARTURE_SECONDS = 8 * 3600;

/**
 * Schedule Editor. Only stations and departures are entered; arrivals are
 * computed as you type and checked again by the backend on save.
 */
@Component({
  selector: 'app-editor',
  imports: [
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTabsModule,
    TrackMap,
    Generate,
    MatTooltipModule,
  ],
  templateUrl: './editor.html',
  styleUrl: './editor.css',
})
export class Editor {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  /** Query parameter: /editor?tab=generate opens Auto-generate. */
  readonly tab = input<Tab, string | undefined>('manual', {
    transform: (v) => (v === 'generate' ? 'generate' : 'manual'),
  });
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly track = signal<Track | null>(null);
  protected readonly vehicles = signal<string[]>([]);
  protected readonly blockTimes = signal<BlockTimes>({});
  protected readonly services = signal<Service[]>([]);
  protected readonly conflicts = signal<Conflict[]>([]);
  protected readonly loadError = signal<string | null>(null);

  /** null while creating a new service. */
  protected readonly selectedId = signal<number | null>(null);
  protected readonly draft = signal<Draft>({ vehicle: '', stops: [] });
  private readonly savedDraft = signal<string>('');
  protected readonly serverErrors = signal<FieldError[]>([]);
  protected readonly saving = signal(false);

  protected readonly vehicleOf = computed(() => new Map(this.services().map((s) => [s.id, s.vehicle])));
  protected readonly sortedServices = computed(() =>
    [...this.services()].sort(
      (a, b) => a.vehicle.localeCompare(b.vehicle) || departureOf(a) - departureOf(b) || a.id - b.id,
    ),
  );
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== this.savedDraft());
  protected readonly arrivals = computed(() =>
    computeArrivals(this.draft().stops, this.track()?.segments ?? [], this.blockTimes()),
  );
  protected readonly draftErrors = computed(() =>
    checkDraft(this.draft().stops, this.track()?.segments ?? [], this.blockTimes()),
  );
  /** Stops whose departure box holds text that is not a time; Save waits for a fix. */
  protected readonly badTimes = signal<ReadonlySet<number>>(new Set());
  protected readonly selectedConflicts = computed(() => {
    const id = this.selectedId();
    return id === null ? [] : conflictsOf(this.conflicts(), id);
  });

  /** The list, one group per vehicle in fleet order, each by departure. */
  protected readonly serviceGroups = computed(() =>
    this.vehicles()
      .map((vehicle) => ({ vehicle, services: this.sortedServices().filter((s) => s.vehicle === vehicle) }))
      .filter((group) => group.services.length > 0),
  );

  // --- conflicts of the open service ---------------------------------------

  /** Conflicts of the open service, a run between two services counted once (as in the Viewer). */
  protected readonly conflictGroups = computed(() => foldConflicts(this.selectedConflicts()));

  /**
   * The conflicts on each stop, to mark the table red. They belong to the
   * saved service, so they are left off while the draft differs from it.
   * The table has no Via or Battery column, so the whole row is marked and
   * explains every conflict of the stop; the arrival is red for its own.
   */
  protected readonly stopMarks = computed(() => {
    const service = this.services().find((s) => s.id === this.selectedId());
    if (!service || this.dirty()) return [];
    return stopRows(service, [], this.selectedConflicts()).map(({ marks }) => ({
      stop: [...new Set([...marks.station, ...[...marks.via.values()].flat(), ...marks.arrival, ...marks.departure, ...marks.battery])],
      arrival: marks.arrival,
    }));
  });
  protected readonly canAddStop = computed(() => {
    const stops = this.draft().stops;
    const last = stops.at(-1);
    if (!last || last.at === '') return false;
    // Y can only end a service: nothing can follow a return to the yard.
    return !(last.at === YARD && stops.length > 1);
  });

  constructor() {
    this.load();
  }

  private async load(): Promise<void> {
    try {
      const [track, vehicles, blocks] = await Promise.all([this.api.track(), this.api.vehicles(), this.api.blocks()]);
      this.track.set(track);
      this.vehicles.set(vehicles);
      this.blockTimes.set(Object.fromEntries(blocks.map((b) => [b.id, b.traversal_seconds])));
      await this.reloadSchedule();
      this.startNew();
    } catch (error) {
      this.loadError.set(failureMessage(error));
    }
  }

  private async reloadSchedule(): Promise<void> {
    const [services, conflicts] = await Promise.all([this.api.services(), this.api.conflicts()]);
    this.services.set(services);
    this.conflicts.set(conflicts);
    // Forget ticks on services that are gone.
    const ids = new Set(services.map((s) => s.id));
    this.checked.update((checked) => new Set([...checked].filter((id) => ids.has(id))));
  }

  /** The draft stays as it is while Auto-generate is open. */
  protected selectTab(index: number): void {
    this.router.navigate([], {
      queryParams: { tab: index === 1 ? 'generate' : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // --- choosing what to edit ---------------------------------------------

  protected async newService(): Promise<void> {
    if (await this.leaveDraft()) this.startNew();
  }

  protected async select(service: Service): Promise<void> {
    if (service.id === this.selectedId() || !(await this.leaveDraft())) return;
    this.open(service);
  }

  private startNew(): void {
    this.selectedId.set(null);
    const vehicle = this.vehicles()[0] ?? '';
    this.setDraft({ vehicle, stops: [{ at: startFor(this.services(), vehicle), departure: null }] });
  }

  private open(service: Service): void {
    this.selectedId.set(service.id);
    this.setDraft({
      vehicle: service.vehicle,
      stops: service.stops.map((s) => ({ at: s.at, departure: s.departure === null ? null : parseHms(s.departure) })),
    });
  }

  private setDraft(draft: Draft): void {
    this.draft.set(draft);
    this.badTimes.set(new Set());
    this.mapMessage.set(null);
    this.savedDraft.set(JSON.stringify(draft));
    this.serverErrors.set([]);
  }

  /** Back to the saved service, or an empty new one. */
  protected discard(): void {
    const service = this.services().find((s) => s.id === this.selectedId());
    if (service) this.open(service);
    else this.startNew();
  }

  private async leaveDraft(): Promise<boolean> {
    return (
      !this.dirty() ||
      confirmWith(this.dialog, { title: 'Discard changes?', message: 'This service has unsaved changes.', confirm: 'Discard' })
    );
  }

  // --- editing -----------------------------------------------------------

  private edit(change: (draft: Draft) => Draft): void {
    this.draft.update(change);
    // Rows that were removed take their typing mistakes with them.
    const count = this.draft().stops.length;
    this.badTimes.update((bad) => new Set([...bad].filter((i) => i < count)));
    this.mapMessage.set(null);
    // Errors from the last save no longer match what is on screen.
    this.serverErrors.set([]);
  }

  /**
   * A new service starts where the vehicle is. Switching
   * vehicles moves the start along, until the path has a second stop.
   */
  protected setVehicle(vehicle: string): void {
    this.edit((d) => {
      const fresh = this.selectedId() === null && d.stops.length === 1;
      return fresh ? { vehicle, stops: [{ ...d.stops[0], at: startFor(this.services(), vehicle) }] } : { ...d, vehicle };
    });
  }

  /**
   * Changing a stop in the middle clears the stops after it, so the path can
   * never be left unconnected.
   */
  protected async setStation(index: number, at: string, select: MatSelect): Promise<void> {
    const stops = this.draft().stops;
    const after = stops.length - 1 - index;
    if (after > 0) {
      const ok = await confirmWith(this.dialog, {
        title: `Change stop ${index + 1}?`,
        message: `The ${after} stop${after > 1 ? 's' : ''} after it will be cleared.`,
        confirm: 'Change',
      });
      if (!ok) {
        // The select already shows the new value; put the old one back.
        select.value = stops[index].at;
        return;
      }
    }
    this.edit((d) => ({
      ...d,
      stops: [...d.stops.slice(0, index), { at, departure: index === 0 ? d.stops[0].departure : null }],
    }));
  }

  /**
   * While typing, only a full HH:MM:SS is taken, so arrivals update without
   * the box being rewritten under the cursor.
   */
  protected typeDeparture(index: number, text: string): void {
    if (text.trim() === '') this.commitDeparture(index, null);
    else if (isFullClock(text)) this.commitDeparture(index, parseClock(text));
  }

  /** On leaving the box: accept "8:05" as well, and show it as "08:05:00". */
  protected finishDeparture(index: number, input: HTMLInputElement): void {
    const text = input.value.trim();
    if (text === '') {
      this.commitDeparture(index, null);
      return;
    }
    const departure = parseClock(text);
    if (departure === null) {
      this.badTimes.update((bad) => new Set(bad).add(index));
      return;
    }
    this.commitDeparture(index, departure);
    input.value = formatHms(departure);
  }

  /** ↑/↓ change the hour, minute or second under the cursor. */
  protected stepDeparture(index: number, event: KeyboardEvent, input: HTMLInputElement): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const arrival = this.arrivals()[index];
    // An empty box starts at the earliest allowed time.
    const empty = arrival === null || arrival === undefined ? FIRST_DEPARTURE_SECONDS : arrival + MIN_DWELL_SECONDS;
    const step = stepClock(input.value, input.selectionStart ?? 0, event.key === 'ArrowUp' ? 1 : -1, empty);
    if (!step) return;
    input.value = step.text;
    input.setSelectionRange(...step.selection);
    this.commitDeparture(index, step.seconds);
  }

  private commitDeparture(index: number, departure: number | null): void {
    this.badTimes.update((bad) => new Set([...bad].filter((i) => i !== index)));
    if (this.draft().stops[index]?.departure === departure) return;
    this.edit((d) => ({ ...d, stops: d.stops.map((s, i) => (i === index ? { ...s, departure } : s)) }));
  }

  /** Adds a stop; from the table it starts unchosen, from the map it is the clicked station. */
  protected addStop(at = ''): void {
    this.edit((d) => {
      const lastIndex = d.stops.length - 1;
      const arrival = this.arrivals()[lastIndex];
      const stops = d.stops.map((s, i) => {
        if (i !== lastIndex || s.departure !== null) return s;
        // The old last stop now needs a departure; start from a one-minute stop.
        const departure = lastIndex === 0 ? null : arrival === null ? null : arrival + DEFAULT_DWELL_SECONDS;
        return { ...s, departure };
      });
      return { ...d, stops: [...stops, { at, departure: null }] };
    });
  }

  protected removeLastStop(): void {
    this.edit((d) => {
      const stops = d.stops.slice(0, -1);
      // The new last stop has no departure, unless it is also the first stop.
      const last = stops.length - 1;
      return { ...d, stops: stops.map((s, i) => (i === last && last > 0 ? { ...s, departure: null } : s)) };
    });
  }

  // --- the track map (Bonus 2.1) -------------------------------------------

  /** Why the last click on the map did nothing. */
  protected readonly mapMessage = signal<string | null>(null);
  protected readonly pathOnMap = computed(() => pathParts(this.draft().stops, this.track()?.segments ?? []));
  protected readonly mapOptions = computed(() => nextSegments(this.draft().stops, this.track()?.segments ?? []));
  /** Where the path has got to; marked on the map, which matters on a loop. */
  protected readonly currentOnMap = computed(() => currentStation(this.draft().stops));
  /** Clicking the current station removes it. The first stop is changed in the table. */
  protected readonly removableStation = computed(() =>
    this.draft().stops.length > 1 ? this.currentOnMap() : null,
  );

  protected onMapClick(clicked: string): void {
    const result = pickOnMap(this.draft().stops, this.track()?.segments ?? [], clicked);
    if (result.kind === 'refuse') {
      this.mapMessage.set(result.msg);
    } else if (result.kind === 'remove') {
      this.removeLastStop();
    } else if (this.draft().stops.at(-1)?.at === '') {
      // Fill the row added with "+ Add stop" instead of adding another.
      const station = result.station;
      this.edit((d) => ({ ...d, stops: d.stops.map((s, i) => (i === d.stops.length - 1 ? { ...s, at: station } : s)) }));
    } else {
      this.addStop(result.station);
    }
  }

  // --- options and messages shown in the form ------------------------------

  protected stationOptions(index: number): string[] {
    const track = this.track();
    if (!track) return [];
    const stops = this.draft().stops;
    if (index === 0) return track.stations;
    const options = nextStations(track.segments, stops[index - 1].at);
    const isLast = index === stops.length - 1;
    return isLast ? options : options.filter((s) => s !== YARD);
  }

  protected errorFor(index: number, field: 'at' | 'departure'): string | null {
    if (field === 'departure' && this.badTimes().has(index)) return TIME_FORMAT_MSG;
    const local = this.draftErrors().find((e) => e.index === index && e.field === field);
    if (local) return local.msg;
    const server = this.serverErrors().find((e) => e.loc[1] === 'stops' && e.loc[2] === index && e.loc[3] === field);
    return server?.msg ?? null;
  }

  protected generalErrors(): string[] {
    return this.serverErrors()
      .filter((e) => !(e.loc[1] === 'stops' && typeof e.loc[2] === 'number'))
      .map((e) => e.msg);
  }

  protected time(seconds: number | null | undefined): string {
    return seconds === null || seconds === undefined ? '' : formatHms(seconds);
  }

  /** Conflicts of a service, a run between two services counted once (as in the Viewer). */
  protected conflictCount(service: Service): number {
    return foldConflicts(conflictsOf(this.conflicts(), service.id)).length;
  }

  /** What a red row is about, one line per conflict; empty for no tooltip. */
  protected tip(conflicts: Conflict[] | undefined): string {
    return (conflicts ?? []).map((c) => describe(c, this.selectedId(), this.vehicleOf())).join('\n');
  }


  protected departureText(service: Service): string {
    return service.stops[0].departure ?? '';
  }

  protected arrivalText(service: Service): string {
    return service.stops.at(-1)?.arrival ?? '';
  }

  // --- saving --------------------------------------------------------------

  protected async save(): Promise<void> {
    const draft = this.draft();
    const last = draft.stops.length - 1;
    const body = {
      vehicle: draft.vehicle,
      stops: draft.stops.map((s, i) =>
        i === last || s.departure === null ? { at: s.at } : { at: s.at, departure: formatHms(s.departure) },
      ),
    };
    this.saving.set(true);
    try {
      const id = this.selectedId();
      const saved = id === null ? await this.api.createService(body) : await this.api.replaceService(id, body);
      // Conflicts are flagged, not rejected, so they show up after saving.
      await this.reloadSchedule();
      this.open(saved);
      const count = this.selectedConflicts().length;
      this.snackBar.open(
        count ? `Saved service ${saved.id} with ${count} conflict${count > 1 ? 's' : ''}` : `Saved service ${saved.id}`,
        undefined,
        { duration: 4000 },
      );
    } catch (error) {
      const errors = fieldErrors(error);
      if (errors) this.serverErrors.set(errors);
      else this.snackBar.open(failureMessage(error), 'Close');
    } finally {
      this.saving.set(false);
    }
  }

  // --- deleting --------------------------------------------------------------

  /** Services ticked in the list, to delete together. */
  protected readonly checked = signal<ReadonlySet<number>>(new Set());
  protected readonly deleting = signal(false);
  protected readonly allChecked = computed(
    () => this.services().length > 0 && this.services().every((s) => this.checked().has(s.id)),
  );

  protected check(id: number, on: boolean): void {
    this.checked.update((ids) => {
      const next = new Set(ids);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected checkAll(on: boolean): void {
    this.checked.set(new Set(on ? this.services().map((s) => s.id) : []));
  }

  protected async deleteChecked(): Promise<void> {
    const ids = [...this.checked()].sort((a, b) => a - b);
    if (ids.length === 0) return;
    const open = this.selectedId();
    const losesDraft = open !== null && ids.includes(open) && this.dirty();
    const ok = await confirmWith(this.dialog, {
      title: ids.length === 1 ? `Delete service ${ids[0]}?` : `Delete ${ids.length} services?`,
      message:
        "This can't be undone. Any gap it leaves is flagged as a conflict." +
        (losesDraft ? ` Your unsaved changes to service ${open} will be lost too.` : ''),
      confirm: 'Delete',
    });
    if (!ok) return;
    this.deleting.set(true);
    try {
      await this.api.deleteServices(ids);
      this.checked.set(new Set());
      await this.reloadSchedule();
      if (open !== null && ids.includes(open)) this.startNew();
      const what = ids.length === 1 ? `service ${ids[0]}` : `${ids.length} services`;
      this.snackBar.open(`Deleted ${what}`, undefined, { duration: 4000 });
    } catch (error) {
      // Someone else may have deleted some already; show the list as it is now.
      this.snackBar.open(failureMessage(error), 'Close');
      await this.reloadSchedule().catch(() => undefined);
    } finally {
      this.deleting.set(false);
    }
  }
}

function departureOf(service: Service): number {
  return parseHms(service.stops[0].departure ?? '0:0:0');
}
