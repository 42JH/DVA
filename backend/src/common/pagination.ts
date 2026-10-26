export class ListResponse<T> {
  readonly data: T[];
  readonly hasNext: boolean;

  constructor(rows: T[], limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid page limit');
    this.data = rows.slice(0, limit);
    this.hasNext = rows.length > limit;
  }
}
