import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from '../icon/icon';

@Component({
  selector: 'app-pagination',
  imports: [Icon],
  templateUrl: './pagination.html',
  styleUrl: './pagination.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Pagination {
  readonly page = input.required<number>();
  readonly pageCount = input.required<number>();
  readonly label = input.required<string>();
  readonly controls = input.required<string>();
  readonly pageChanged = output<number>();
}
