import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

interface RowPosition {
  left: number;
  top: number;
}

@Directive({ selector: '[appAnimateList]' })
export class AnimateList {
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  private positions = new Map<HTMLElement, RowPosition>();
  private readonly animations = new Map<HTMLElement, Animation>();

  constructor() {
    afterNextRender(() => {
      // `matchMedia` no existe en todos los entornos de render; sin él se asume que no hay
      // preferencia declarada, nunca se lanza desde un hook de render.
      const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      this.remember();
      const mutations = new MutationObserver(() => this.reflow(!!motion?.matches));
      mutations.observe(this.host, { childList: true });
      const resize =
        typeof ResizeObserver === 'undefined'
          ? undefined
          : new ResizeObserver(() => this.remember());
      resize?.observe(this.host);
      const stop = () => {
        this.cancel();
        this.remember();
      };
      motion?.addEventListener?.('change', stop);
      this.destroyRef.onDestroy(() => {
        mutations.disconnect();
        resize?.disconnect();
        motion?.removeEventListener?.('change', stop);
        this.cancel();
      });
    });
  }

  private measure(): Map<HTMLElement, RowPosition> {
    return new Map(
      [...this.host.children]
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .map((row) => [row, { left: row.offsetLeft, top: row.offsetTop }]),
    );
  }

  private remember(): void {
    this.positions = this.host.getClientRects().length ? this.measure() : new Map();
  }

  private cancel(): void {
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
  }

  private reflow(reducedMotion: boolean): void {
    if (!this.host.getClientRects().length || reducedMotion || !this.host.animate) {
      this.cancel();
      this.remember();
      return;
    }
    const previous = this.positions;
    const next = this.measure();
    const offsets = new Map<HTMLElement, RowPosition>();
    for (const [row, position] of next) {
      const old = previous.get(row);
      if (!old) continue;
      const transform = this.animations.has(row) ? getComputedStyle(row).transform : 'none';
      const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
      offsets.set(row, {
        left: old.left - position.left + matrix.m41,
        top: old.top - position.top + matrix.m42,
      });
    }
    this.cancel();
    this.positions = next;
    if (!previous.size) return;
    for (const row of next.keys()) {
      const offset = offsets.get(row);
      let animation: Animation;
      if (offset) {
        if (Math.abs(offset.left) < 1 && Math.abs(offset.top) < 1) continue;
        animation = row.animate(
          [
            { transform: `translate(${offset.left}px, ${offset.top}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: 360, easing: 'cubic-bezier(.2, .8, .2, 1)' },
        );
      } else {
        animation = row.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 240,
          delay: 80,
          fill: 'backwards',
          easing: 'ease-out',
        });
      }
      this.animations.set(row, animation);
      animation.onfinish = () => {
        if (this.animations.get(row) === animation) this.animations.delete(row);
      };
    }
  }
}
