import { Pool, PoolClient, QueryResultRow } from 'pg';
import { PaginationQueryDto } from './dto/pagination-query.dto';

export interface PageRows<T> {
  rows: T[];
  total_count: number;
}

// sql·orderBy·pageSelect는 저장소의 고정 SQL만 사용하고 검색값은 values에 바인딩한다.
export async function readPage<T extends QueryResultRow>(
  database: Pool | PoolClient,
  sql: string | ((limit: string, offset: string) => string),
  values: unknown[],
  query: PaginationQueryDto,
  orderBy: string,
  pageSelect = 'page.*',
  knownTotal?: number,
): Promise<PageRows<T>> {
  const limit = values.length + 1;
  const offset = values.length + 2;
  const parameters = [...values, query.limit + 1, query.offset];
  let totalSql = 'SELECT count(*) AS __total_count FROM matching';
  if (knownTotal !== undefined) {
    parameters.push(knownTotal);
    totalSql = `SELECT $${parameters.length}::bigint AS __total_count`;
  }
  const pageSql =
    typeof sql === 'string'
      ? `WITH matching AS NOT MATERIALIZED (${sql}),
     page AS (
       SELECT matching.*,row_number() OVER (ORDER BY ${orderBy}) AS __page_ordinal
       FROM matching ORDER BY ${orderBy} LIMIT $${limit} OFFSET $${offset}
     )`
      : sql(`$${limit}`, `$${offset}`);
  const result = await database.query<T & { __page_ordinal: string | null; __total_count: string }>(
    `${pageSql}
     SELECT ${pageSelect},totals.__total_count FROM (${totalSql}) totals
     LEFT JOIN page ON true ORDER BY page.__page_ordinal`,
    parameters,
  );
  const total_count = Number(result.rows[0]?.__total_count ?? NaN);
  if (!Number.isSafeInteger(total_count) || total_count < 0)
    throw new RangeError('Invalid query total count');
  const rows = result.rows
    .filter((row) => row.__page_ordinal !== null)
    .map((row) => {
      const item: QueryResultRow = { ...row };
      delete item.__page_ordinal;
      delete item.__total_count;
      return item as T;
    });
  return { rows, total_count };
}
