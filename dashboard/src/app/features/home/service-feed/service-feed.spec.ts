import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MOCK_COMMUNICATIONS, MOCK_UNITS } from '../../../core/data/operations.mock';
import { ServiceFeed } from './service-feed';

const communications = MOCK_COMMUNICATIONS.slice(0, 6);

describe('ServiceFeed', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));
  async function setup() {
    const fixture = TestBed.createComponent(ServiceFeed);
    fixture.componentRef.setInput('communications', communications);
    fixture.componentRef.setInput('resources', []);
    fixture.componentRef.setInput('selectedIncidentId', 'INC-001');
    await fixture.whenStable();
    return fixture;
  }

  it('keeps resource identity, service, agent, timestamp and message in the compact row', async () => {
    const fixture = await setup();
    const row = (fixture.nativeElement as HTMLElement).querySelector('.resource-select')!;
    expect(row.textContent).toContain('Bomberos');
    expect(row.textContent).toContain('B-03');
    expect(row.textContent).toContain('A. Ruiz');
    expect(row.textContent).toContain('INC-001');
    expect(row.querySelector('time')?.textContent).toBe(communications[0].time);
    expect(row.querySelector('.resource-mission')?.textContent).toBe(communications[0].message);
  });

  it('highlights related resources and emits selection from the button', async () => {
    const fixture = await setup();
    expect(fixture.nativeElement.querySelectorAll('.communication').length).toBe(6);
    expect(fixture.nativeElement.querySelectorAll('.communication.related').length).toBe(3);
    const selected: string[] = [];
    fixture.componentInstance.unitSelected.subscribe((id) => selected.push(id));
    fixture.nativeElement.querySelectorAll('.resource-select')[1].click();
    expect(selected).toEqual(['BUS-04']);
  });

  it('highlights only the selected resource instead of every related unit', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('selectedUnitId', 'B-03');
    await fixture.whenStable();
    const rows = fixture.nativeElement.querySelectorAll(
      '.communication.related',
    ) as NodeListOf<HTMLElement>;
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
    expect(rows[0].querySelector('button')?.getAttribute('aria-label')).toContain(
      'Mostrar recurso B-03',
    );
  });

  function category(element: HTMLElement, label: string): HTMLButtonElement {
    return [...element.querySelectorAll<HTMLButtonElement>('.category-chip')].find(
      (button) => button.textContent?.trim() === label,
    )!;
  }

  it('shows resource status and an independent detail link', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h2')?.textContent?.trim()).toBe('Recursos');
    expect(element.querySelector('.heading-title .count-badge')?.textContent?.trim()).toBe('6');
    expect(element.querySelector('.communication-status')?.textContent).toBe(
      communications[0].status,
    );
    expect(element.querySelector('.detail-link')?.getAttribute('href')).toBe('/?recurso=B-03');
  });

  it('uses category chips starting with Todos', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    expect(element.querySelector('select')).toBeNull();
    expect(element.querySelector('.clear-filters')).toBeNull();
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
    expect(category(element, 'Aéreos').getAttribute('aria-pressed')).toBe('false');
  });

  it('returns to Todos when the final category is deselected', async () => {
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

  it('keeps the scrollable list complete and updates the count after filtering', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput(
      'communications',
      Array.from({ length: 13 }, (_, index) => ({
        ...communications[index % communications.length],
        id: `COM-${index}`,
      })),
    );
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.communication').length).toBe(13);
    expect(element.querySelector('app-pagination')).toBeNull();
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    category(element, 'Bomberos').click();
    await fixture.whenStable();
    expect(element.querySelector('.count-badge')?.textContent?.trim()).toBe('3');
    expect(element.querySelectorAll('.communication').length).toBe(3);
    category(element, 'Todos').click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(13);
  });

  it('renders an empty list without a clear button', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('communications', []);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No hay recursos disponibles');
    expect(fixture.nativeElement.querySelector('.clear-filters')).toBeNull();
  });

  it('preserves authoritative backend status even if stale route geometry is present', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('resources', [{ ...MOCK_UNITS[0], resourceStatus: 'Reservado' }]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.communication-status')?.textContent).toBe(
      'Reservado',
    );
  });
});
