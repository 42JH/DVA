import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ApiException } from '../common/errors/api.exception';

export async function writeOrder<T>(
  database: DatabaseService,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '2s'");
      return work(client);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '55P03')
      throw new ApiException(
        409,
        'REQUEST_IN_PROGRESS',
        '다른 작업의 완료 대기 시간을 초과했습니다. 잠시 후 재시도해 주세요.',
      );
    throw error;
  }
}
