import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-split-pane',
  template: '<span aria-hidden="true"></span>',
  styleUrl: './split-pane.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    tabindex: '0',
    'aria-label': 'Redimensionar mapa y paneles',
    'aria-orientation': 'vertical',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    '[attr.aria-valuenow]': 'percentage()',
    '[attr.aria-valuetext]': "percentage() + '% para el mapa'",
    '(pointerdown)': 'startResize($event)',
    '(pointermove)': 'resize($event)',
    '(pointerup)': 'stopResize($event)',
    '(pointercancel)': 'stopResize($event)',
    '(keydown)': 'useKeyboard($event)',
    '(dblclick)': 'reset()',
  },
})
export class SplitPane {
  protected readonly percentage = signal(44);
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  private container?: HTMLElement;
  private observer?: ResizeObserver;
  private resizeFrame?: number;
  private dragging = false;
  private ratio = 0.44;
  private readonly minMap = 320;
  private readonly minPanels = 360;
  private readonly separatorWidth = 20;

  constructor() {
    afterNextRender(() => {
      this.container = this.host.parentElement ?? undefined;
      if (!this.container) return;
      this.observer = new ResizeObserver(() => {
        if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = requestAnimationFrame(() => {
          this.resizeFrame = undefined;
          this.apply();
        });
      });
      this.observer.observe(this.container);
      this.apply();
      this.destroyRef.onDestroy(() => {
        this.observer?.disconnect();
        if (this.resizeFrame !== undefined) cancelAnimationFrame(this.resizeFrame);
        this.restoreBody();
      });
    });
  }

  protected startResize(event: PointerEvent): void {
    if (!this.desktop() || event.button !== 0) return;
    this.dragging = true;
    this.host.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  protected resize(event: PointerEvent): void {
    if (!this.dragging || !this.container) return;
    const bounds = this.container.getBoundingClientRect();
    const paddingLeft = parseFloat(getComputedStyle(this.container).paddingLeft) || 0;
    this.setMapWidth(event.clientX - bounds.left - paddingLeft);
  }

  protected stopResize(event: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.host.hasPointerCapture(event.pointerId))
      this.host.releasePointerCapture(event.pointerId);
    this.restoreBody();
  }

  protected useKeyboard(event: KeyboardEvent): void {
    if (!this.desktop() || !this.container) return;
    const available = this.contentWidth() - this.separatorWidth;
    const step = event.shiftKey ? 50 : 20;
    const current = available * this.ratio;
    if (event.key === 'ArrowLeft') this.setMapWidth(current - step);
    else if (event.key === 'ArrowRight') this.setMapWidth(current + step);
    else if (event.key === 'Home') this.setMapWidth(this.minMap);
    else if (event.key === 'End') this.setMapWidth(available - this.minPanels);
    else return;
    event.preventDefault();
  }

  protected reset(): void {
    this.ratio = 0.44;
    this.apply();
  }

  private setMapWidth(width: number): void {
    if (!this.container) return;
    const available = this.contentWidth() - this.separatorWidth;
    const clamped = Math.max(this.minMap, Math.min(width, available - this.minPanels));
    this.ratio = clamped / available;
    this.apply();
  }

  private apply(): void {
    if (!this.container) return;
    if (!this.desktop()) {
      this.container.style.removeProperty('grid-template-columns');
      this.container.style.removeProperty('column-gap');
      this.percentage.set(44);
      return;
    }
    const available = this.contentWidth() - this.separatorWidth;
    const mapWidth = Math.max(
      this.minMap,
      Math.min(available * this.ratio, available - this.minPanels),
    );
    this.ratio = mapWidth / available;
    this.percentage.set(Math.round(this.ratio * 100));
    this.container.style.gridTemplateColumns = `${mapWidth}px ${this.separatorWidth}px minmax(${this.minPanels}px, 1fr)`;
    this.container.style.columnGap = '0';
  }

  private contentWidth(): number {
    if (!this.container) return 0;
    const style = getComputedStyle(this.container);
    return (
      this.container.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0)
    );
  }

  private restoreBody(): void {
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }

  private desktop(): boolean {
    return window.matchMedia('(min-width: 801px)').matches;
  }
}
