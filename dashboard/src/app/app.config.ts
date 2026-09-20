import {
  afterNextRender,
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { IncidentStore } from './features/incidents/incident-store';
import { DemoRouteSimulation } from './core/services/demo-route-simulation';
import { OperationLogStore } from './features/home/operation-log/operation-log-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideAppInitializer(() => {
      const simulation = inject(DemoRouteSimulation);
      const log = inject(OperationLogStore);
      const incidents = inject(IncidentStore);
      afterNextRender(() => {
        log.start();
        simulation.start(incidents.units());
      });
    }),
  ],
};
