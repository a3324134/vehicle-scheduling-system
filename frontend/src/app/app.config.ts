import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { MAT_TOOLTIP_DEFAULT_OPTIONS, MatTooltipDefaultOptions } from '@angular/material/tooltip';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    // Query parameters such as ?mode=simulation&t=08:00:30 arrive as component inputs.
    provideRouter(routes, withComponentInputBinding()),
    // Tooltips explain red cells: quickly, and above the cell so the rows below stay readable.
    {
      provide: MAT_TOOLTIP_DEFAULT_OPTIONS,
      useValue: { showDelay: 150, hideDelay: 0, touchendHideDelay: 0, position: 'above' } satisfies MatTooltipDefaultOptions,
    },
  ],
};
