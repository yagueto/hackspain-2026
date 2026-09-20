import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IconName } from '../../core/models/operations';
import names from './icon-names.json';
import spriteVersion from './icon-sprite-version.json';

export function iconHref(name: IconName): string {
  return `${new URL('tabler-icons.svg', document.baseURI).href}?v=${spriteVersion}#${names[name]}`;
}

export function createIconSvg(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(key, value);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', iconHref(name));
  svg.append(use);
  return svg;
}

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <use [attr.href]="href()" />
  </svg>`,
  styles: `
    :host {
      display: inline-flex;
      width: 17px;
      height: 17px;
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
  protected readonly href = computed(() => iconHref(this.name()));
}
