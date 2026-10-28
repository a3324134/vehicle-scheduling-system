import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router } from '@angular/router';

import { Api, failureMessage } from '../core/api';
import { Segment } from '../core/models';

interface Row {
  id: string;
  usedOn: string;
  saved: number;
  value: number | null;
}

/** Block Configuration: all 14 traversal times, saved together. */
@Component({
  selector: 'app-blocks',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, MatSnackBarModule],
  templateUrl: './blocks.html',
  styleUrl: './blocks.css',
})
export class Blocks {
  private readonly api = inject(Api);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);

  protected readonly rows = signal<Row[]>([]);
  protected readonly saving = signal(false);
  protected readonly loadError = signal<string | null>(null);

  protected readonly dirty = computed(() => this.rows().some((r) => r.value !== r.saved));
  protected readonly valid = computed(() => this.rows().every((r) => isValidSeconds(r.value)));

  constructor() {
    this.load();
  }

  private async load(): Promise<void> {
    try {
      const [blocks, track] = await Promise.all([this.api.blocks(), this.api.track()]);
      this.rows.set(
        blocks.map((b) => ({
          id: b.id,
          usedOn: usedOn(b.id, track.segments),
          saved: b.traversal_seconds,
          value: b.traversal_seconds,
        })),
      );
    } catch (error) {
      this.loadError.set(failureMessage(error));
    }
  }

  protected setValue(id: string, text: string): void {
    const value = text === '' ? null : Number(text);
    this.rows.update((rows) => rows.map((r) => (r.id === id ? { ...r, value } : r)));
  }

  protected isValid(value: number | null): boolean {
    return isValidSeconds(value);
  }

  protected discard(): void {
    this.rows.update((rows) => rows.map((r) => ({ ...r, value: r.saved })));
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    try {
      const saved = await this.api.saveBlocks(
        this.rows().map((r) => ({ id: r.id, traversal_seconds: r.value! })),
      );
      const savedById = new Map(saved.map((b) => [b.id, b.traversal_seconds]));
      this.rows.update((rows) => rows.map((r) => ({ ...r, saved: savedById.get(r.id)!, value: savedById.get(r.id)! })));
      // A new block time can make saved services inconsistent; those are flagged, not rejected.
      const conflicts = await this.api.conflicts();
      const message = conflicts.length === 0 ? 'Saved. No conflicts.' : `Saved. ${conflicts.length} conflicts in the schedule.`;
      const ref = this.snackBar.open(message, conflicts.length ? 'View' : undefined, { duration: 6000 });
      ref.onAction().subscribe(() => this.router.navigate(['/viewer']));
    } catch (error) {
      this.snackBar.open(failureMessage(error), 'Close');
    } finally {
      this.saving.set(false);
    }
  }
}

function isValidSeconds(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value >= 1;
}

/** "Y ↔ P1A" for a block used both ways, otherwise "P1A → P2A, P1B → P2A". */
function usedOn(block: string, segments: Segment[]): string {
  const using = segments.filter((s) => s.blocks.includes(block));
  const parts: string[] = [];
  for (const s of using) {
    if (using.some((o) => o.start === s.end && o.end === s.start)) {
      const pair = `${s.end} ↔ ${s.start}`;
      if (!parts.includes(pair) && !parts.includes(`${s.start} ↔ ${s.end}`)) parts.push(pair);
    } else {
      parts.push(`${s.start} → ${s.end}`);
    }
  }
  return parts.join(', ');
}
