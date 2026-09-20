import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Inicio · Centro de coordinación',
    loadComponent: () => import('./features/home/home').then((module) => module.Home),
  },
  {
    path: 'incidencias',
    title: 'Incidencias · Centro de coordinación',
    loadComponent: () =>
      import('./features/incidents/incidents').then((module) => module.Incidents),
  },
  {
    path: 'recursos',
    title: 'Recursos · Centro de coordinación',
    loadComponent: () =>
      import('./features/resources/resources').then((module) => module.Resources),
  },
  { path: '**', redirectTo: '' },
];
