import { TestBed } from '@angular/core/testing';
import { MOCK_INCIDENTS } from '../../../core/data/operations.mock';
import { IncidentList } from './incident-list';

describe('IncidentList', () => {
  it('renders incidents and emits the selected incident', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', MOCK_INCIDENTS);
    fixture.componentRef.setInput('selectedId', 'INC-001');
    const selected: string[] = [];
    fixture.componentInstance.incidentSelected.subscribe((id) => selected.push(id));
    await fixture.whenStable();
    const buttons = fixture.nativeElement.querySelectorAll(
      '.incident-row',
    ) as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(4);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    buttons[1].click();
    expect(selected).toEqual(['INC-002']);
  });

  it('paginates independently and reveals the incident selected on the map', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput(
      'incidents',
      Array.from({ length: 13 }, (_, index) => ({ ...MOCK_INCIDENTS[0], id: `INC-${index}` })),
    );
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.incident-row').length).toBe(10);
    expect(element.querySelector<HTMLButtonElement>('.previous')!.disabled).toBe(true);
    element.querySelector<HTMLButtonElement>('.next')!.click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.incident-row').length).toBe(3);
    expect(element.querySelector<HTMLButtonElement>('.next')!.disabled).toBe(true);
    fixture.componentRef.setInput('selectedId', 'INC-0');
    await fixture.whenStable();
    expect(element.querySelector('.incident-row.selected')?.textContent).toContain('INC-0');
    expect(element.querySelectorAll('.incident-row').length).toBe(10);
  });

  it('handles an empty incident list', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', []);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No hay incidencias');
  });
});
