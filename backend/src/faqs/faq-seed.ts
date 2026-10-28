import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export interface FaqSeedEntry {
  question: string;
  answer: string;
}

export function validateFaqSeed(input: unknown): FaqSeedEntry[] {
  if (!Array.isArray(input) || !input.length) throw new Error('초기 FAQ 목록이 비어 있습니다.');
  const questions = new Set<string>();
  for (const entry of input) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'answer,question' ||
      typeof entry.question !== 'string' ||
      !/\S/u.test(entry.question) ||
      entry.question.includes('\0') ||
      [...entry.question].length > 1000 ||
      typeof entry.answer !== 'string' ||
      !/\S/u.test(entry.answer) ||
      entry.answer.includes('\0') ||
      [...entry.answer].length > 20000
    )
      throw new Error('초기 FAQ에는 유효한 질문·답변만 있어야 합니다.');
    if (questions.has(entry.question)) throw new Error('초기 FAQ에 중복 질문이 있습니다.');
    questions.add(entry.question);
  }
  return input as FaqSeedEntry[];
}

export async function seedFaqs(
  pool: Pick<Pool, 'connect'>,
  loginId: string,
  input: unknown,
): Promise<{ inserted: number; skipped: boolean }> {
  if (!/^[A-Za-z0-9]{1,20}$/.test(loginId))
    throw new Error('유효한 관리자 로그인 ID가 필요합니다.');
  const entries = validateFaqSeed(input);
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query('BEGIN');
    const admin = (
      await client.query<{ id: number }>(
        "SELECT admin_user_seq AS id FROM admin_users WHERE login_id=$1 AND status='ACTIVE' AND role IN ('OPERATOR','SUPERVISOR','SYSTEM_ADMIN') FOR SHARE",
        [loginId],
      )
    ).rows[0];
    if (!admin) throw new Error('활성 관리자 계정이 필요합니다.');
    // API 쓰기도 잠그므로 최초 등록과 관리자 편집이 경쟁해 덮어쓰는 일을 막는다.
    await client.query('LOCK TABLE faq_entries IN SHARE ROW EXCLUSIVE MODE');
    if ((await client.query('SELECT 1 FROM faq_entries LIMIT 1')).rowCount) {
      await client.query('COMMIT');
      return { inserted: 0, skipped: true };
    }
    const requestId = randomUUID();
    for (const entry of entries) {
      const id = (
        await client.query<{ id: number }>(
          'INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq) VALUES($1,$2,$3) RETURNING faq_entry_seq AS id',
          [entry.question, entry.answer, admin.id],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata) VALUES('ADMIN',$1,'FAQ_BOOTSTRAPPED','FAQ_ENTRY',$2,$3,'SUCCESS','{}')",
        [admin.id, id, requestId],
      );
    }
    await client.query('COMMIT');
    return { inserted: entries.length, skipped: false };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      releaseError = new Error('FAQ 초기 등록 롤백 실패');
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
