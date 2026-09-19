import {
  afterNextRender,
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

export function pageCapacity(
  height: number,
  rowHeight: number,
  gap: number,
  mobile: boolean,
): number {
  return mobile ? 5 : Math.max(1, Math.floor((height + gap) / (rowHeight + gap)));
}

@Directive({ selector: '[appPaginatedList]', exportAs: 'paginatedList' })
export class PaginatedList<T> {
  readonly items = input.required<readonly T[]>({ alias: 'appPaginatedList' });
  readonly itemKey = input.required<(item: T) => string>();
  readonly selectedKey = input<string | null>(null);
  readonly pageSize = signal(10);
  private readonly requestedPage = signal(0);
  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.items().length / this.pageSize())),
  );
  readonly pageIndex = computed(() => Math.min(this.requestedPage(), this.pageCount() - 1));
  readonly visibleItems = computed(() =>
    this.items().slice(
      this.pageIndex() * this.pageSize(),
      (this.pageIndex() + 1) * this.pageSize(),
    ),
  );
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    effect(() => {
      this.items();
      this.requestedPage.set(0);
    });
    effect(() => {
      const selected = this.selectedKey();
      const size = this.pageSize();
      untracked(() => {
        const index = selected
          ? this.items().findIndex((item) => this.itemKey()(item) === selected)
          : -1;
        if (index >= 0) this.requestedPage.set(Math.floor(index / size));
      });
    });
    afterNextRender(() => {
      const media = window.matchMedia?.('(max-width: 800px)');
      const measure = () => {
        if (this.destroyRef.destroyed) return;
        const mobile = media?.matches ?? window.innerWidth <= 800;
        if (!mobile && !this.element.clientHeight) return;
        const style = getComputedStyle(this.element);
        const rowHeight = parseFloat(style.getPropertyValue('--page-row-height')) || 60;
        const gap = parseFloat(style.rowGap) || 0;
        const padding =
          (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        this.pageSize.set(
          pageCapacity(this.element.clientHeight - padding, rowHeight, gap, mobile),
        );
      };
      const observer =
        typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
      observer?.observe(this.element);
      media?.addEventListener('change', measure);
      window.addEventListener('resize', measure);
      measure();
      this.destroyRef.onDestroy(() => {
        observer?.disconnect();
        media?.removeEventListener('change', measure);
        window.removeEventListener('resize', measure);
      });
    });
  }

  goToPage(index: number): void {
    this.requestedPage.set(Math.max(0, Math.min(index, this.pageCount() - 1)));
  }
}
