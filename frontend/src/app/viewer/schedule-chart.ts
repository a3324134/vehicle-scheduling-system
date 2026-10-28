import { Component, input, output } from '@angular/core';

export interface ChartBar {
  id: number;
  /** Percent of the chart's width. */
  left: number;
  width: number;
  label: string;
  conflict: boolean;
}

export interface Chart {
  ticks: { left: number; label: string }[];
  rows: { vehicle: string; bars: ChartBar[] }[];
}

/**
 * The day at a glance: one line per vehicle, one bar per
 * service from leaving to arriving. Gaps are time in the yard.
 *
 * Plain HTML positioned in percent rather than SVG, so the labels keep their
 * size at any width and each bar is a button for the keyboard.
 */
@Component({
  selector: 'app-schedule-chart',
  template: `
    <div class="chart" role="group" aria-label="Services over the day">
      <div class="line axis" aria-hidden="true">
        <span></span>
        <div class="track">
          @for (tick of chart().ticks; track tick.left) {
            <span class="tick muted time" [style.left.%]="tick.left">{{ tick.label }}</span>
          }
        </div>
      </div>
      @for (row of chart().rows; track row.vehicle) {
        <div class="line">
          <span class="vehicle">{{ row.vehicle }}</span>
          <div class="track">
            @for (tick of chart().ticks; track tick.left) {
              <i class="grid" [style.left.%]="tick.left"></i>
            }
            @for (bar of row.bars; track bar.id) {
              <button
                type="button"
                class="bar"
                [class.conflict]="bar.conflict"
                [style.left.%]="bar.left"
                [style.width.%]="bar.width"
                [title]="bar.label"
                [attr.aria-label]="bar.label + ', show its stops'"
                (click)="picked.emit(bar.id)"
              ></button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .chart {
      margin: 8px 0 16px;
    }
    .line {
      display: grid;
      grid-template-columns: 28px 1fr;
      align-items: center;
      height: 26px;
    }
    .axis {
      height: 20px;
      font-size: 12px;
    }
    .vehicle {
      font-size: 13px;
      font-weight: 500;
    }
    /* Room on both sides for half a time label. */
    .track {
      position: relative;
      height: 100%;
      margin: 0 20px;
    }
    .tick {
      position: absolute;
      top: 0;
      transform: translateX(-50%);
    }
    .grid {
      position: absolute;
      top: 0;
      bottom: 0;
      border-left: 1px solid var(--mat-sys-outline-variant);
    }
    .bar {
      position: absolute;
      top: 5px;
      height: 16px;
      min-width: 3px;
      padding: 0;
      border: none;
      border-radius: 3px;
      background: var(--mat-sys-primary);
      cursor: pointer;
    }
    .bar:hover,
    .bar:focus-visible {
      outline: 2px solid var(--mat-sys-on-surface);
      outline-offset: 1px;
    }
    .bar.conflict {
      background: var(--mat-sys-error);
    }
  `,
})
export class ScheduleChart {
  readonly chart = input.required<Chart>();
  /** A bar was clicked: show that service in the table. */
  readonly picked = output<number>();
}
