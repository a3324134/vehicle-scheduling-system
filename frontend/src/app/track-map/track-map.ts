import { Component, computed, input, output, signal } from '@angular/core';

import { Segment } from '../core/models';
import {
  BLOCK_LINES,
  BLOCK_LINE_BY_ID,
  JUNCTIONS,
  Point,
  STATIONS,
  STATION_GROUPS,
  STATION_SIZE,
  VIEW_BOX,
} from './layout';

export interface VehicleMarker {
  /** Unique per marker; a vehicle in two places at once has two. */
  key: string;
  vehicle: string;
  service: number | null;
  position: Point;
  /** Stranded by the schedule (a `gap` interval). */
  stranded: boolean;
  /** Part of a conflict shown right now. */
  warning: boolean;
}

const VEHICLE_COLORS: Record<string, string> = {
  V1: '#1f6feb',
  V2: '#8250df',
  V3: '#1a7f37',
  V4: '#bf8700',
  V5: '#0598bc',
};

/** A vehicle's colour on the map, also used to tie other panels to it. */
export function vehicleColor(vehicle: string): string {
  return VEHICLE_COLORS[vehicle] ?? '#57606a';
}

/**
 * The spec's track map, drawn as SVG by the Angular template.
 * The Viewer passes vehicles and conflicts to show; the Editor turns on
 * `picking` and passes the path being built (Bonus 2.1).
 */
@Component({
  selector: 'app-track-map',
  templateUrl: './track-map.html',
  styleUrl: './track-map.css',
})
export class TrackMap {
  /** Blocks and platforms to draw in red. */
  readonly lit = input<ReadonlySet<string>>(new Set());
  readonly vehicles = input<VehicleMarker[]>([]);

  // --- building a path (Bonus 2.1) ---
  readonly picking = input(false);
  /** Stations and blocks already on the path. */
  readonly selected = input<ReadonlySet<string>>(new Set());
  /** Segments the next click can add. */
  readonly options = input<readonly Segment[]>([]);
  /** The station the path has reached; marked "you are here". */
  readonly current = input<string | null>(null);
  /** The station that removes the last stop when clicked. */
  readonly removable = input<string | null>(null);
  /** A block or station was clicked. */
  readonly picked = output<string>();

  protected readonly viewBox = `0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`;
  protected readonly blocks = BLOCK_LINES;
  protected readonly junctions = JUNCTIONS;
  protected readonly groups = STATION_GROUPS;
  protected readonly size = STATION_SIZE;
  protected readonly stations = Object.entries(STATIONS).map(([id, center]) => ({ id, center }));

  private readonly hovered = signal<string | null>(null);
  /** Hovering any part of a segment previews the whole segment. */
  private readonly preview = computed(() => {
    const id = this.hovered();
    const segment = id === null ? undefined : this.options().find((s) => s.end === id || s.blocks.includes(id));
    return new Set(segment ? [...segment.blocks, segment.end] : []);
  });
  private readonly optionParts = computed(() => new Set(this.options().flatMap((s) => [...s.blocks, s.end])));
  /**
   * The blocks the next click can take, drawn as a second layer on top of
   * the path. On a loop they are often on the path already, so a style on
   * the same line would hide one or the other.
   */
  protected readonly nextLines = computed(() =>
    this.options().flatMap((segment) =>
      segment.blocks.map((id) => {
        const line = BLOCK_LINE_BY_ID.get(id)!;
        // B1 and B2: point the arrow the way this segment goes.
        return { line, backward: line.backwardToward === segment.end };
      }),
    ),
  );
  /**
   * Hit lines with the clickable ones drawn last, so they are on top where
   * lines cross (B4/B13, B8/B10): a click there means the one you can take.
   */
  protected readonly hitOrder = computed(() => {
    const parts = this.optionParts();
    return [...BLOCK_LINES].sort((a, b) => Number(parts.has(a.id)) - Number(parts.has(b.id)));
  });

  protected readonly color = vehicleColor;

  protected isSelected(id: string): boolean {
    return this.picking() && this.selected().has(id);
  }

  protected isOption(id: string): boolean {
    return this.picking() && this.optionParts().has(id);
  }

  protected isPreview(id: string): boolean {
    return this.picking() && this.preview().has(id);
  }

  protected isFaded(id: string): boolean {
    return this.picking() && !this.selected().has(id) && !this.optionParts().has(id);
  }

  protected arrow(id: string): string {
    if (this.lit().has(id)) return 'url(#arrow-lit)';
    if (this.isSelected(id)) return 'url(#arrow-path)';
    return 'url(#arrow)';
  }

  protected hint(id: string): string | null {
    if (!this.picking()) return null;
    if (id === this.removable()) return 'Click to remove';
    return this.isOption(id) ? 'Click to add' : null;
  }

  protected hover(id: string | null): void {
    this.hovered.set(id);
  }

  protected pick(id: string): void {
    if (this.picking()) this.picked.emit(id);
  }
}
