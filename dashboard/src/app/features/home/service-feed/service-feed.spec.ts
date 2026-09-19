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

  it('combines filters and clears them from the empty state', async () => {
    const fixture = await setup();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector<HTMLButtonElement>('.filter-button')!.click();
    await fixture.whenStable();
    const selects = element.querySelectorAll('select');
    selects[0].value = 'Bomberos';
    selects[0].dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(1);
    selects[1].value = 'INC-003';
    selects[1].dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(0);
    expect(element.textContent).toContain('No hay comunicaciones');
    element.querySelector<HTMLButtonElement>('.empty-state button')!.click();
    await fixture.whenStable();
    expect(element.querySelectorAll('.communication').length).toBe(6);
  });
});
