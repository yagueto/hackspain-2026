import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconName } from '../../core/models/operations';

export const ICON_PATHS: Record<IconName, string> = {
  log: 'M4 3h16v14H9l-5 4V3ZM8 7h8M8 11h8',
  fire: 'M12 3c1 5-4 6-4 10 0 2 1 3 2 3-1-3 2-4 3-6 0 3 4 4 4 7 0 2-2 4-5 4-5 0-8-3-8-7 0-4 3-6 4-8 0 2 1 3 1 3 2-2 3-4 3-6Z',
  walk: 'M14 4h.01M13 7l-2 6 4 3 1 5M11 13l-4 8M13 8l3 4h4M12 8 8 9l-3 4',
  heart:
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8ZM3 12h5l2-4 3 8 2-4h6',
  barrier: 'M3 7h18v8H3zM6 7l-3 5M12 7l-5 8M18 7l-5 8M21 11l-3 4M6 15v6M18 15v6M7 3v1M17 3v1',
  'fire-truck':
    'M2 8h12v10H2zM14 11h4l4 4v3h-8M5 8V4h8M5 5h8M6 12v3M10 12v3M16 12v3h5M5 18a2 2 0 1 0 4 0M16 18a2 2 0 1 0 4 0',
  bus: 'M5 17h14V6c0-3-14-3-14 0v11ZM5 10h14M8 14h.01M16 14h.01M7 17v3M17 17v3M9 4h6',
  helicopter:
    'M7 11h8a4 4 0 0 1 4 4v2H9a4 4 0 0 1-2-6ZM12 7v4M4 7h17M7 13l-5-3v5h5M12 11v5M10 17v3M17 17v3M7 20h14M21 4l-2 3',
  medical: 'M10 2h4v6l5-3 2 4-5 3 5 3-2 4-5-3v6h-4v-6l-5 3-2-4 5-3-5-3 2-4 5 3V2Z',
  truck: 'M2 6h12v12H2zM14 10h4l4 5v3h-8M16 11v4h5M5 18a2 2 0 1 0 4 0M16 18a2 2 0 1 0 4 0',
  tools: 'm4 3 17 17M3 5l3-3 5 5-3 3ZM14 10l5-5M15 3l6 6M3 21l7-7 3 3-7 7Z',
  shield: 'M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6l-9-3ZM12 7v10',
  hospital: 'M5 21V3h14v18M2 21h20M9 7h6M12 4v6M8 13h2M14 13h2M10 21v-4h4v4',
  shelter: 'M3 11 12 3l9 8M5 10v11h14V10M9 21v-7h6v7',
  filter: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  locate:
    'M12 2v3M12 19v3M2 12h3M19 12h3M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  layers: 'm12 3 10 6-10 6L2 9l10-6ZM2 13l10 6 10-6M2 17l10 6 10-6',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  radio:
    'M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14M12 11h.01M12 14v7',
};

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path [attr.d]="paths[name()]" />
  </svg>`,
  styles: `
    :host {
      display: inline-flex;
      width: 20px;
      height: 20px;
      flex-shrink: 0;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly paths = ICON_PATHS;
}
