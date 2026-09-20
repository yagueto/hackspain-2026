import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { SplitPane } from './split-pane';

@Component({
  imports: [SplitPane],
  template: '<section><app-split-pane /></section>',
})
class SplitPaneHost {}

describe('SplitPane resize observation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defers layout writes to an animation frame and cancels pending work on destruction', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    let notify = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const fixture = TestBed.createComponent(SplitPaneHost);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const panel = element.querySelector('section')!;
    panel.style.gridTemplateColumns = '1fr';

    notify();
    expect(panel.style.gridTemplateColumns).toBe('1fr');
    frames.at(-1)!(0);
    expect(panel.style.gridTemplateColumns).not.toBe('1fr');

    notify();
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenLastCalledWith(frames.length);
  });
});
