import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Inicio · Centro de coordinación',
    loadComponent: () => import('./features/home/home').then((module) => module.Home),
  },
  { path: '**', redirectTo: '' },
];
