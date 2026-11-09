module.exports = function promptFieldsMigration({ test, pool, assert }) {
  test('060 separates existing prompts without changing snapshots or metadata, and protects the new history fields', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { composePersonaPrompt } = require('../dist/ai-settings/persona-prompt');
    const columns = [
      'role_text',
      'personality_text',
      'tone_text',
      'speed_instruction',
      'backchannel_text',
      'interruption_text',
    ];
    const fields = {
      role: '역할\n둘째 줄',
      personality: '밝게',
      tone: '존댓말',
      speedInstruction: '빠르게',
      backchannel: '가끔',
      interruption: '즉시 멈춤',
    };
    const original = composePersonaPrompt(fields);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['ai_persona_versions', 'ai_persona_drafts']) {
        await client.query(
          `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
        );
        await client.query(
          `ALTER TABLE pg_temp.${table} ${columns.map((c) => 'DROP COLUMN ' + c).join(',')}`,
        );
      }
      const aliases =
        '# 페르소나\n## Identity / 역할\n상담사\n## Personality / 성격\n차분함\n## Speaking Style / 발화 스타일\n### Tone / 발화 톤\n공손하게\n### Pace / 발화 속도\n천천히\n## Backchannel Policy / 맞장구\n조용하게\n## Interruption Policy\n멈춤\n# 업무 규칙\n기존 업무를 보존';
      for (const [index, text] of [original, ' 자유 원문\n보존 ', aliases].entries())
        await client.query(
          `INSERT INTO pg_temp.ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,name,prompt_text,turn_wait_level)
          VALUES($1,1,$2,'이관 검증',$3,'NORMAL')`,
          [900001 + index, index + 1, text],
        );
      await client.query(
        `INSERT INTO pg_temp.ai_persona_drafts(ai_persona_seq,draft_revision,base_version,name,prompt_text,turn_wait_level,updated_by_admin_user_seq)
        VALUES(1,'00000000-0000-4000-8000-000000000060',3,'기존 초안',$1,'NORMAL',1)`,
        [original],
      );
      const snapshot = async (table) =>
        (
          await client.query(
            `SELECT jsonb_agg(to_jsonb(v)-$1::text[]) AS rows FROM pg_temp.${table} v`,
            [columns],
          )
        ).rows[0].rows;
      const before = await snapshot('ai_persona_versions');
      const beforeDraft = await snapshot('ai_persona_drafts');
      await client.query(
        readFileSync(join(__dirname, '../migrations/060-persona-prompt-fields.sql'), 'utf8'),
      );
      assert.deepEqual(await snapshot('ai_persona_versions'), before);
      assert.deepEqual(await snapshot('ai_persona_drafts'), beforeDraft);
      const read = async (table, where = '') =>
        (
          await client.query(
            `SELECT role_text AS role,personality_text AS personality,tone_text AS tone,speed_instruction AS "speedInstruction",backchannel_text AS backchannel,interruption_text AS interruption FROM pg_temp.${table} ${where}`,
          )
        ).rows[0];
      assert.deepEqual(
        await read('ai_persona_versions', 'WHERE ai_persona_version_seq=900001'),
        fields,
      );
      assert.deepEqual(await read('ai_persona_drafts'), fields);
      const free = await read('ai_persona_versions', 'WHERE ai_persona_version_seq=900002');
      assert.equal(free.role, ' 자유 원문\n보존 ');
      for (const key of ['personality', 'tone', 'speedInstruction', 'backchannel', 'interruption'])
        assert.equal(free[key], '');
      const bilingual = await read('ai_persona_versions', 'WHERE ai_persona_version_seq=900003');
      assert.equal(bilingual.personality, '차분함');
      assert.equal(bilingual.tone, '공손하게');
      assert.equal(bilingual.speedInstruction, '천천히');
      assert.equal(bilingual.backchannel, '조용하게');
      assert.equal(bilingual.interruption, '멈춤');
      assert.ok(bilingual.role.includes('# 업무 규칙\n기존 업무를 보존'));
      await client.query(
        'CREATE TRIGGER prompt_fields_history_guard BEFORE UPDATE ON pg_temp.ai_persona_versions FOR EACH ROW EXECUTE FUNCTION guard_persona_history()',
      );
      await assert.rejects(
        client.query(
          "UPDATE pg_temp.ai_persona_versions SET tone_text='덮어쓰기' WHERE ai_persona_version_seq=900001",
        ),
        (e) => e.code === '23514',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
};
