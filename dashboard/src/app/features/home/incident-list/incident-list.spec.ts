import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MOCK_INCIDENTS } from '../../../core/data/operations.mock';
import { IncidentList } from './incident-list';

describe('IncidentList', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));
  it('renders incidents in priority order and emits the selected incident', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', MOCK_INCIDENTS);
    fixture.componentRef.setInput('selectedId', 'INC-001');
    const selected: string[] = [];
    fixture.componentInstance.incidentSelected.subscribe((id) => selected.push(id));
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.incident-row')).toHaveLength(MOCK_INCIDENTS.length);
    expect(element.querySelector('.selected .incident-select')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    element.querySelector<HTMLButtonElement>('[aria-label="Mostrar INC-002 en el mapa"]')!.click();
    expect(selected).toEqual(['INC-002']);
  });

  it('keeps the scrollable list complete and reveals the incident selected on the map', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput(
      'incidents',
      Array.from({ length: 13 }, (_, index) => ({ ...MOCK_INCIDENTS[0], id: `INC-${index}` })),
    );
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.incident-row')).toHaveLength(13);
    expect(element.querySelector('app-pagination')).toBeNull();
    fixture.componentRef.setInput('selectedId', 'INC-12');
    await fixture.whenStable();
    expect(element.querySelector('.incident-row.selected')?.textContent).toContain('INC-12');
    expect(element.querySelectorAll('.incident-row')).toHaveLength(13);
  });

  it('handles an empty incident list', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', []);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No hay incidencias');
  });
});
