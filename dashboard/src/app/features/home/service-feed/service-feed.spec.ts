import { TestBed } from '@angular/core/testing';
import { MOCK_COMMUNICATIONS } from '../../../core/data/operations.mock';
import { ServiceFeed } from './service-feed';

describe('ServiceFeed', () => {
  async function setup() {
    const fixture = TestBed.createComponent(ServiceFeed);
    fixture.componentRef.setInput('communications', MOCK_COMMUNICATIONS);
    fixture.componentRef.setInput('selectedIncidentId', 'INC-001');
    await fixture.whenStable();
    return fixture;
  }

  it('highlights communications related to the selected incident', async () => {
    const fixture = await setup();
    expect(fixture.nativeElement.querySelectorAll('.communication').length).toBe(6);
    expect(fixture.nativeElement.querySelectorAll('.communication.related').length).toBe(3);
    const selected: string[] = [];
    fixture.componentInstance.unitSelected.subscribe((id) => selected.push(id));
    fixture.nativeElement.querySelectorAll('.communication')[1].click();
    expect(selected).toEqual(['BUS-04']);
  });

  it('highlights only the selected resource instead of all resources in its incident', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('selectedUnitId', 'B-03');
    await fixture.whenStable();
    const rows = fixture.nativeElement.querySelectorAll(
      '.communication.related',
    ) as NodeListOf<HTMLButtonElement>;
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute('aria-pressed')).toBe('true');
    expect(rows[0].getAttribute('aria-label')).toContain('Ver recurso B-03');
  });

  function category(element: HTMLElement, label: string): HTMLButtonElement {
    return [...element.querySelectorAll<HTMLButtonElement>('.category-chip')].find(
      (button) => button.textContent?.trim() === label,
    )!;
  }

  it('names the section Recursos and places the status last in each card', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h2')?.textContent).toBe('Recursos');
    expect(
      element
        .querySelector('.communication')
        ?.lastElementChild?.classList.contains('communication-status'),
    ).toBe(true);
  });

  it('replaces the selectors and clear button with category chips starting with Todos', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    expect(element.querySelector('select')).toBeNull();
    expect(element.querySelector('.clear-filters')).toBeNull();
    expect(element.querySelector('.category-chip')?.textContent?.trim()).toBe('Todos');
    expect(category(element, 'Todos').getAttribute('aria-pressed')).toBe('true');
    expect(element.querySelectorAll('.category-chip').length).toBe(7);
  });

  it('combines categories and restores every resource with Todos', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    category(element, 'Bomberos').click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(1);
    expect(category(element, 'Bomberos').getAttribute('aria-pressed')).toBe('true');
    expect(category(element, 'Todos').getAttribute('aria-pressed')).toBe('false');
    category(element, 'Aéreos').click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(2);
    category(element, 'Bomberos').click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(1);
    expect(element.querySelector('.communication')?.textContent).toContain('H-01');
    category(element, 'Todos').click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(6);
    expect(category(element, 'Todos').getAttribute('aria-pressed')).toBe('true');
    expect(category(element, 'Aéreos').getAttribute('aria-pressed')).toBe('false');
  });

  it('returns to Todos when the final active category is deselected', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    category(element, 'Sanitarios').click();
    await fixture.whenStable();
    category(element, 'Sanitarios').click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(6);
    expect(category(element, 'Todos').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders an empty resource list without a clear button', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('communications', []);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No hay recursos disponibles');
    expect(fixture.nativeElement.querySelector('.clear-filters')).toBeNull();
  });
});
