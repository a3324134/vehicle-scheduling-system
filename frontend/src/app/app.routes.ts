import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'viewer' },
  {
    path: 'editor',
    title: 'Schedule Editor',
    loadComponent: () => import('./editor/editor').then((m) => m.Editor),
  },
  {
    path: 'viewer',
    title: 'Schedule Viewer',
    loadComponent: () => import('./viewer/viewer').then((m) => m.Viewer),
  },
  {
    path: 'blocks',
    title: 'Block Configuration',
    loadComponent: () => import('./blocks/blocks').then((m) => m.Blocks),
  },
  { path: '**', redirectTo: 'viewer' },
];
