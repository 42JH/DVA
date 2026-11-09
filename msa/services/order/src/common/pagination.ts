import { type PageRows } from './pagination-query';
export class ListResponse<T> {
  readonly data: T[];
  readonly hasNext: boolean;
  readonly total_count: number;
  constructor(page: PageRows<T>, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid page limit');
    if (!Number.isSafeInteger(page.total_count) || page.total_count < 0)
      throw new RangeError('Invalid total count');
    this.data = page.rows.slice(0, limit);
    this.hasNext = page.rows.length > limit;
    this.total_count = page.total_count;
  }
}
