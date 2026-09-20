import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { pageCapacity, PaginatedList } from './paginated-list';

@Component({
  imports: [PaginatedList],
  template: `<div
    [appPaginatedList]="items()"
    [itemKey]="key"
    [selectedKey]="selected()"
    #pager="paginatedList"
    style="--page-row-height: 60px; row-gap: 8px"
  >
    @for (item of pager.visibleItems(); track key(item)) {
      <span>{{ item }}</span>
    }
  </div>`,
})
class TestList {
  readonly items = signal(Array.from({ length: 13 }, (_, index) => String(index + 1)));
  readonly selected = signal<string | null>(null);
  readonly key = (item: string) => item;
  readonly pager = viewChild.required(PaginatedList);
}

describe('PaginatedList', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const fixture = TestBed.createComponent(TestList);
    await fixture.whenStable();
    return fixture;
  }

  it('calculates desktop capacity including gaps and keeps five items on mobile', () => {
    expect(pageCapacity(332, 60, 8, false)).toBe(5);
    expect(pageCapacity(331, 60, 8, false)).toBe(4);
    expect(pageCapacity(0, 60, 8, false)).toBe(1);
    expect(pageCapacity(2000, 60, 8, true)).toBe(5);
    expect(pageCapacity(100, 60, 8, true)).toBe(5);
  });

  it('navigates between pages, clamps bounds and resets when data changes', async () => {
    const fixture = await setup();
    const pager = fixture.componentInstance.pager();
    pager.pageSize.set(5);
    await fixture.whenStable();
    expect(pager.pageCount()).toBe(3);
    pager.goToPage(2);
    await fixture.whenStable();
    expect(pager.visibleItems()).toEqual(['11', '12', '13']);
    pager.goToPage(100);
    expect(pager.pageIndex()).toBe(2);
    fixture.componentInstance.items.set(['1', '2']);
    await fixture.whenStable();
    expect(pager.pageIndex()).toBe(0);
    expect(pager.visibleItems()).toEqual(['1', '2']);
    pager.goToPage(-1);
    expect(pager.pageIndex()).toBe(0);
  });

  it('reveals external selections without blocking manual page navigation', async () => {
    const fixture = await setup();
    const pager = fixture.componentInstance.pager();
    pager.pageSize.set(5);
    fixture.componentInstance.selected.set('12');
    await fixture.whenStable();
    expect(pager.pageIndex()).toBe(2);
    pager.goToPage(0);
    await fixture.whenStable();
    expect(pager.pageIndex()).toBe(0);
    pager.pageSize.set(4);
    await fixture.whenStable();
    expect(pager.visibleItems()).toContain('12');
  });

  it('recalculates desktop capacity when the list is resized', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement.querySelector('div') as HTMLElement;
    let height = 332;
    Object.defineProperty(element, 'clientHeight', { get: () => height });
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    expect(fixture.componentInstance.pager().pageSize()).toBe(5);
    height = 196;
    window.dispatchEvent(new Event('resize'));
    await fixture.whenStable();
    expect(fixture.componentInstance.pager().pageSize()).toBe(3);
  });

  it('uses five items per page on mobile and releases listeners on destroy', async () => {
    const removeEventListener = vi.fn();
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener,
    }));
    const fixture = await setup();
    expect(fixture.componentInstance.pager().pageSize()).toBe(5);
    expect(fixture.nativeElement.querySelectorAll('span').length).toBe(5);
    fixture.destroy();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('handles empty data without creating invalid pages', async () => {
    const fixture = await setup();
    fixture.componentInstance.items.set([]);
    await fixture.whenStable();
    const pager = fixture.componentInstance.pager();
    expect(pager.pageCount()).toBe(1);
    expect(pager.pageIndex()).toBe(0);
    expect(pager.visibleItems()).toEqual([]);
  });
});
