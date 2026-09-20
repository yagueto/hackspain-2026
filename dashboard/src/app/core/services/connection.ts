import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { IncidentStore } from '../../features/incidents/incident-store';
import { OperationLogStore } from '../../features/home/operation-log/operation-log-store';

interface NetworkInformation extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

@Injectable({ providedIn: 'root' })
export class Connection {
  private readonly incidents = inject(IncidentStore);
  private readonly log = inject(OperationLogStore);
  private readonly network = (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
  private readonly online = signal(navigator.onLine);
  private readonly slow = signal(false);
  readonly stable = computed(
    () =>
      this.online() && !this.slow() && !this.incidents.updateError() && !this.log.incomingError(),
  );
  readonly bars = computed(() => (this.stable() ? 3 : this.online() ? 1 : 0));

  constructor() {
    const update = () => {
      this.online.set(navigator.onLine);
      this.slow.set(
        ['slow-2g', '2g'].includes(this.network?.effectiveType ?? '') ||
          (this.network?.downlink ?? Infinity) < 0.5 ||
          (this.network?.rtt ?? 0) > 1000,
      );
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    this.network?.addEventListener('change', update);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      this.network?.removeEventListener('change', update);
    });
  }
}
