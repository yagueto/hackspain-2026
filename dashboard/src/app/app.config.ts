import {
  afterNextRender,
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { MOCK_UNITS } from './core/data/operations.mock';
import { DemoRouteSimulation } from './core/services/demo-route-simulation';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAppInitializer(() => {
      const simulation = inject(DemoRouteSimulation);
      afterNextRender(() => simulation.start(MOCK_UNITS));
    }),
  ],
};
