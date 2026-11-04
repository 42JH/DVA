function registerCallEventsMigrations(suite) {
  const {
    test,
    pool,
    randomUUID,
    createCall,
    createHash,
    readFileSync,
    join,
    assert,
    success,
    token,
    error,
  } = suite;
  test('025 and 042 migrate legacy evidence and remove result while preserving data and valid retries', async () => {
    const fixtures = [
      {
        hasComplaint: true,
        repeatQuestionCount: 2,
        summary: {
          isNewCustomer: false,
          registeredParcelCount: 3,
          faqAnswerCount: 2,
          orderLookupCount: 1,
          cancelledParcelCount: 1,
          hasHandoffRequest: true,
        },
        complaints: [
          {
            type: 'REPEATED_QUESTION',
            evidenceText: ' 한글 "인용" \\ 경로\n이모지 🙂\t ',
            offsetMs: 31999,
            utteranceOrders: [1, 3],
          },
          {
            type: 'AI_REFUSAL',
            evidenceText: '사람 연결 요청',
            offsetMs: null,
            utteranceOrders: [],
          },
        ],
      },
      {
        hasComplaint: false,
        repeatQuestionCount: 0,
        complaints: [],
        summary: {
          isNewCustomer: false,
          registeredParcelCount: 0,
          faqAnswerCount: 0,
          orderLookupCount: 0,
          cancelledParcelCount: 0,
          hasHandoffRequest: false,
        },
      },
      { hasComplaint: null, repeatQuestionCount: null, complaints: [] },
      {
        hasComplaint: false,
        repeatQuestionCount: null,
        complaints: [],
        summary: { isNewCustomer: true, orderLookupCount: 2147483647 },
      },
    ];
    const before = (await pool.query('SELECT * FROM call_analyses ORDER BY call_session_seq')).rows;
    const cases = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 과거 migration이 이후 계약의 해시까지 재작성하지 않도록 기존 행을 격리한다.
      await client.query(
        'CREATE TEMP TABLE analysis_before_legacy_upgrade ON COMMIT DROP AS SELECT * FROM public.call_analyses',
      );
      await client.query('DELETE FROM public.call_analyses');
      await client.query(
        "ALTER TABLE call_analyses ADD COLUMN result text NOT NULL DEFAULT 'INQUIRY'",
      );
      const versionSeq = (
        await client.query(
          `WITH persona AS (INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq)
         INSERT INTO ai_persona_versions(ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
         SELECT ai_persona_seq,1,'migration-test','과거 실제 버전','NORMAL','INACTIVE' FROM persona
         RETURNING ai_persona_version_seq`,
          ['migration-' + randomUUID()],
        )
      ).rows[0].ai_persona_version_seq;
      for (const fixture of fixtures) {
        const c = await createCall(null, '01012345678', client);
        const body = {
          providerCallId: c.providerCallId,
          startedAt: '2026-10-31T01:00:00.123Z',
          endedAt: '2026-10-31T01:03:00.456Z',
          aiPersonaVersionSeq: fixture.hasComplaint === true ? versionSeq : null,
          result: 'INQUIRY',
          repeatQuestionCount: fixture.repeatQuestionCount,
          hasComplaint: fixture.hasComplaint,
          complaints: fixture.complaints,
          ...fixture.summary,
        };
        await client.query(
          `INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,result,
      repeat_question_count,has_complaint,complaints,payload_hash,ai_persona_version_seq,
      is_new_customer,registered_parcel_count,faq_answer_count,order_lookup_count,cancelled_parcel_count,
      has_handoff_request,analysed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'2026-10-31T02:00:00Z')`,
          [
            c.id,
            body.startedAt,
            body.endedAt,
            body.result,
            body.repeatQuestionCount,
            body.hasComplaint,
            JSON.stringify(body.complaints),
            createHash('sha256').update(JSON.stringify(body)).digest('hex'),
            body.aiPersonaVersionSeq,
            body.isNewCustomer ?? null,
            body.registeredParcelCount ?? null,
            body.faqAnswerCount ?? null,
            body.orderLookupCount ?? null,
            body.cancelledParcelCount ?? null,
            body.hasHandoffRequest ?? null,
          ],
        );
        const next = {
          ...body,
          complaints: body.complaints.map(({ offsetMs, ...item }) => ({
            type: item.type,
            evidenceText: item.evidenceText,
            offsetSeconds: offsetMs === null ? null : Math.floor(offsetMs / 1000),
            utteranceOrders: item.utteranceOrders,
          })),
        };
        delete next.result;
        cases.push({ c, next });
      }
      await client.query(
        readFileSync(join(__dirname, '../migrations/025-call-analysis-seconds.sql'), 'utf8'),
      );
      await client.query(
        readFileSync(join(__dirname, '../migrations/042-remove-call-analysis-result.sql'), 'utf8'),
      );
      await client.query(
        'INSERT INTO public.call_analyses SELECT * FROM analysis_before_legacy_upgrade',
      );
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK');
      throw failure;
    } finally {
      client.release();
    }
    assert.deepEqual(
      (
        await pool.query(
          'SELECT * FROM call_analyses WHERE call_session_seq=ANY($1::int[]) ORDER BY call_session_seq',
          [before.map((row) => row.call_session_seq)],
        )
      ).rows,
      before,
    );
    for (const { c, next } of cases) {
      const stored = (
        await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id])
      ).rows[0];
      assert.deepEqual(stored.complaints, next.complaints);
      assert.equal(Object.hasOwn(stored, 'result'), false);
      assert.equal(stored.ai_persona_version_seq, next.aiPersonaVersionSeq);
      for (const [column, field] of [
        ['is_new_customer', 'isNewCustomer'],
        ['registered_parcel_count', 'registeredParcelCount'],
        ['faq_answer_count', 'faqAnswerCount'],
        ['order_lookup_count', 'orderLookupCount'],
        ['cancelled_parcel_count', 'cancelledParcelCount'],
        ['has_handoff_request', 'hasHandoffRequest'],
      ])
        assert.equal(stored[column], next[field] ?? null);
      assert.equal(
        stored.payload_hash,
        createHash('sha256').update(JSON.stringify(next)).digest('hex'),
      );
      assert.equal(stored.analysed_at.toISOString(), '2026-10-31T02:00:00.000Z');
      await success(
        await fetch(`${suite.base}/api/ai/calls/${c.id}/analysis`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        }),
      );
      await error(
        await fetch(`${suite.base}/api/ai/calls/${c.id}/analysis`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...next, orderLookupCount: next.orderLookupCount === 0 ? 1 : 0 }),
        }),
        409,
        'EVENT_PAYLOAD_CONFLICT',
      );
      assert.deepEqual(
        (await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id])).rows,
        [stored],
      );
    }
  });
}

module.exports = registerCallEventsMigrations;
