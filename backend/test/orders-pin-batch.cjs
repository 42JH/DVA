module.exports = function registerPinBatch(suite) {
  const { test, assert, pool, address } = suite;
  test('batch PIN ownership filters foreign/deleted/company references and holds share locks until rollback', async () => {
    const owner = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('일괄 PIN 검증','01088888001','ACTIVE') RETURNING customer_seq",
      )
    ).rows[0].customer_seq;
    const foreign = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('다른 PIN 검증','01088888002','ACTIVE') RETURNING customer_seq",
      )
    ).rows[0].customer_seq;
    const pins = [];
    for (const [ordinal, customer] of [owner, owner, foreign].entries())
      pins.push(
        (
          await pool.query(
            'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
            [
              customer,
              {
                ...address,
                roadAddress: '일괄 검증로 ' + ordinal,
                detailAddress: '검증 ' + ordinal,
              },
            ],
          )
        ).rows[0].personal_pin_seq,
      );
    const deleted = (
      await pool.query(
        'INSERT INTO personal_pins(customer_seq,address_data,deleted_at) VALUES($1,$2,clock_timestamp()) RETURNING personal_pin_seq',
        [owner, address],
      )
    ).rows[0].personal_pin_seq;
    const client = await pool.connect(),
      writer = await pool.connect();
    let count = 0;
    const traced = {
      query: (...args) => {
        count++;
        return client.query(...args);
      },
    };
    try {
      await client.query('BEGIN');
      const selected = await suite.repository.usablePersonalPinIds(
        traced,
        owner,
        [pins[1], pins[0], pins[0], pins[2], deleted]
          .map((pinSeq) => ({ scope: 'PERSONAL', pinSeq }))
          .concat({ scope: 'COMPANY', pinSeq: pins[0] }),
      );
      assert.deepEqual(
        [...selected],
        [pins[0], pins[1]].sort((a, b) => a - b),
      );
      assert.equal(count, 1);
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(
        writer.query(
          'UPDATE personal_pins SET deleted_at=clock_timestamp() WHERE personal_pin_seq=$1',
          [pins[0]],
        ),
        (error) => error.code === '55P03',
      );
      await writer.query('ROLLBACK');
      await client.query('ROLLBACK');
      await writer.query(
        'UPDATE personal_pins SET deleted_at=clock_timestamp() WHERE personal_pin_seq=$1',
        [pins[0]],
      );
      count = 0;
      assert.deepEqual([...(await suite.repository.usablePersonalPinIds(traced, owner, []))], []);
      assert.equal(count, 0);
      assert.deepEqual(
        [
          ...(await suite.repository.usablePersonalPinIds(traced, owner, [
            { scope: 'PERSONAL', pinSeq: pins[0] },
          ])),
        ],
        [],
      );
    } finally {
      await writer.query('ROLLBACK');
      await client.query('ROLLBACK');
      writer.release();
      client.release();
    }
  });
};
