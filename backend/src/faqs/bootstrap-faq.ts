import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { seedFaqs } from './faq-seed';

export async function bootstrapFaq(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 1 || !/^[A-Za-z0-9]{1,20}$/.test(args[0]))
    throw new Error('사용법: node dist/faqs/bootstrap-faq.js <관리자 로그인 ID>');
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'])
    if (!process.env[key]) throw new Error('DB 연결 환경변수를 설정해 주세요.');
  const entries: unknown = JSON.parse(
    readFileSync(join(__dirname, '../../data/delivery-faq.json'), 'utf8'),
  );
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    options: '-c statement_timeout=5000',
    max: 1,
  });
  try {
    const result = await seedFaqs(pool, args[0], entries);
    console.log(
      result.skipped
        ? '기존 FAQ가 있어 초기 등록을 건너뛰었습니다.'
        : `초기 FAQ ${result.inserted}건을 등록했습니다.`,
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  bootstrapFaq().catch(() => {
    console.error(
      'FAQ 초기 등록 실패. 사용법·DB 설정·활성 관리자 계정을 확인해 주세요. 초기 데이터는 부분 등록하지 않습니다.',
    );
    process.exitCode = 1;
  });
}
