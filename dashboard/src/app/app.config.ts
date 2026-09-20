import { provideHttpClient } from '@angular/common/http';
import {
  afterNextRender,
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { Operations } from './core/services/operations';
import { OperationLogStore } from './features/home/operation-log/operation-log-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes),
    provideAppInitializer(() => {
      const operations = inject(Operations);
      const log = inject(OperationLogStore);
      afterNextRender(() => {
        operations.start();
        log.start();
      });
    }),
  ],
};
