import { PaginationQueryDto } from './dto/pagination-query.dto';
import { ListResponse } from './pagination';

const MAX_KEYS = 128;
const MAX_PAGE_SIZE = 100;

interface PendingPage<Q, R> {
  query: Q;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
  promise: Promise<R>;
}

interface ReadGroup<Q, R> {
  pending: Map<string, PendingPage<Q, R>>;
}

export class CoalescedPages<Q extends PaginationQueryDto, R extends ListResponse<unknown>> {
  private readonly groups = new Map<string, ReadGroup<Q, R>>();

  read(scope: readonly number[], query: Q, load: (page: Q) => Promise<R>): Promise<R> {
    const { offset, limit, ...filters } = query;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      !Number.isSafeInteger(offset + limit)
    )
      return load(query);

    const key = JSON.stringify([scope, filters]);
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= MAX_KEYS) return load(query);
      const next = { pending: new Map<string, PendingPage<Q, R>>() };
      this.groups.set(key, next);
      setImmediate(() => void this.drain(key, next, load));
      group = next;
    }
    const slot = offset + ':' + limit;
    const samePage = group.pending.get(slot);
    if (samePage) return samePage.promise;
    if (group.pending.size >= MAX_KEYS) return load(query);
    let deferred!: Pick<PendingPage<Q, R>, 'resolve' | 'reject'>;
    const promise = new Promise<R>((resolve, reject) => {
      deferred = { resolve, reject };
    });
    group.pending.set(slot, { query, promise, ...deferred });
    return promise;
  }

  private async drain(key: string, group: ReadGroup<Q, R>, load: (page: Q) => Promise<R>) {
    while (group.pending.size) {
      // A request that arrives after this point must read from a later snapshot.
      const pending = [...group.pending.values()].sort((a, b) => a.query.offset - b.query.offset);
      group.pending.clear();
      for (let start = 0; start < pending.length;) {
        const offset = pending[start].query.offset;
        let end = offset;
        let index = start;
        while (index < pending.length) {
          const query = pending[index].query;
          if (query.offset + query.limit - offset > MAX_PAGE_SIZE) break;
          end = Math.max(end, query.offset + query.limit);
          index++;
        }
        await this.loadWindow(pending.slice(start, index), offset, end, load);
        start = index;
      }
    }
    this.groups.delete(key);
  }

  private async loadWindow(
    requests: PendingPage<Q, R>[],
    offset: number,
    end: number,
    load: (page: Q) => Promise<R>,
  ) {
    const first = requests[0];
    try {
      if (requests.length === 1) {
        first.resolve(await load(first.query));
        return;
      }
      const query = Object.assign(Object.create(Object.getPrototypeOf(first.query)), first.query, {
        offset,
        limit: end - offset,
      }) as Q;
      const page = await load(query);
      for (const request of requests) {
        const { offset: start, limit } = request.query;
        const relative = start - offset;
        request.resolve(
          Object.assign(Object.create(Object.getPrototypeOf(page)), page, {
            data: page.data.slice(relative, relative + limit),
            hasNext: page.total_count > start + limit,
          }) as R,
        );
      }
    } catch (error) {
      for (const request of requests) request.reject(error);
    }
  }
}
