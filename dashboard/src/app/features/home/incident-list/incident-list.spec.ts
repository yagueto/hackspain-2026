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

  it('handles an empty incident list', async () => {
    const fixture = TestBed.createComponent(IncidentList);
    fixture.componentRef.setInput('incidents', []);
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No hay incidencias');
  });
});
