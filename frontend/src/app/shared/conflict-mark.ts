import { Directive, Injectable, computed, effect, inject, input, signal } from '@angular/core';
import { MatTooltip } from '@angular/material/tooltip';

import { Conflict } from '../core/models';

/** The conflicts of the red cell under the pointer or keyboard focus, shared by every cell of a page. */
@Injectable()
export class PointedConflicts {
  readonly conflicts = signal<ReadonlySet<Conflict>>(new Set());
}

/**
 * A cell of a timetable, red when conflicts are marked on it (used by the
 * Viewer's timetable and the Editor's stops). Its styles are global:
 * `.marked`, `.marked.lit` in styles.css.
 *
 * - says why on hover or keyboard focus, in a tooltip;
 * - lights up together with every other red cell of the same conflicts, e.g.
 *   both times of a dwell too short, or each battery of a low battery trip.
 */
@Directive({
  selector: '[appConflictMark]',
  hostDirectives: [MatTooltip],
  host: {
    '[class.marked]': 'marked()',
    '[class.lit]': 'lit()',
    '[attr.tabindex]': 'marked() ? 0 : null',
    '(mouseenter)': 'point()',
    '(focus)': 'point()',
    '(mouseleave)': 'pointed.conflicts.set(none)',
    '(blur)': 'pointed.conflicts.set(none)',
  },
})
export class ConflictMark {
  readonly conflicts = input<Conflict[], Conflict[] | undefined>([], {
    alias: 'appConflictMark',
    transform: (conflicts) => conflicts ?? [],
  });
  /** What the conflicts are about, one per line. */
  readonly explanation = input('', { alias: 'appConflictMarkTip' });

  protected readonly pointed = inject(PointedConflicts);
  protected readonly none: ReadonlySet<Conflict> = new Set();
  protected readonly marked = computed(() => this.conflicts().length > 0);
  protected readonly lit = computed(() => {
    const pointed = this.pointed.conflicts();
    return pointed.size > 0 && this.conflicts().some((c) => pointed.has(c));
  });

  constructor() {
    const tooltip = inject(MatTooltip);
    effect(() => (tooltip.message = this.explanation()));
  }

  protected point(): void {
    if (this.marked()) this.pointed.conflicts.set(new Set(this.conflicts()));
  }
}
