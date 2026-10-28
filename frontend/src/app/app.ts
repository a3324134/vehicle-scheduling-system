import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatToolbarModule, MatButtonModule],
  template: `
    <mat-toolbar class="toolbar">
      <span class="title">Vehicle Scheduling System</span>
      <nav>
        <a mat-button routerLink="/editor" routerLinkActive="active" ariaCurrentWhenActive="page">Editor</a>
        <a mat-button routerLink="/viewer" routerLinkActive="active" ariaCurrentWhenActive="page">Viewer</a>
        <a mat-button routerLink="/blocks" routerLinkActive="active" ariaCurrentWhenActive="page">Blocks</a>
      </nav>
    </mat-toolbar>
    <main>
      <router-outlet />
    </main>
  `,
  styles: `
    /* The site's navigation: a dark bar that stands apart from the light page
       without competing with the blue of the buttons and the timeline. The
       current page is underlined like a chosen page tab. */
    .toolbar {
      gap: 32px;
      --nav-bg: #1f2328;
      --nav-text: #d1d9e0;
      --nav-current: #ffffff;
      --nav-underline: #8ab4f8;
      --mat-toolbar-container-background-color: var(--nav-bg);
      --mat-toolbar-container-text-color: var(--nav-current);
    }
    .title {
      font-size: 18px;
      font-weight: 600;
    }
    nav {
      display: flex;
      align-self: stretch;
      gap: 4px;
    }
    nav a {
      height: 100%;
      padding: 0 20px;
      --mat-button-text-container-height: 64px;
      --mat-button-text-container-shape: 0;
      --mat-button-text-label-text-size: 16px;
      --mat-button-text-label-text-weight: 600;
      --mat-button-text-state-layer-color: #ffffff;
    }
    /* Doubled class: mat-toolbar sets its buttons' text colour with a doubled class too. */
    nav a.mat-mdc-button-base.mat-mdc-button-base {
      --mat-button-text-label-text-color: var(--nav-text);
    }
    nav a.active.mat-mdc-button-base.mat-mdc-button-base {
      --mat-button-text-label-text-color: var(--nav-current);
    }
    nav a.active::after {
      content: '';
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 0;
      height: 3px;
      border-radius: 3px 3px 0 0;
      background: var(--nav-underline);
    }
    nav a:focus-visible {
      outline: 2px solid var(--nav-underline);
      outline-offset: -4px;
    }
    main {
      padding: 16px 24px 48px;
      max-width: 1400px;
      margin: 0 auto;
    }
  `,
})
export class App {}
