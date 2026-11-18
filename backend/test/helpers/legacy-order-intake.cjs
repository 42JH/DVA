// These regression fixtures represent calls registered before migration 055.
// New-call rejection and finalization are exercised without this adapter in order-intake.integration.test.cjs.
function legacyOrderIntake(app) {
  const { CallSessionRepository } = require('../../dist/consultations/call-session.repository');
  const sessions = app.get(CallSessionRepository);
  const ensure = sessions.ensureCall;
  sessions.ensureCall = async function (client, input) {
    const result = await ensure.call(this, client, input);
    if (result.created)
      await client.query(
        'UPDATE call_sessions SET order_intake_enabled=false WHERE call_session_seq=$1',
        [result.id],
      );
    return result;
  };
  return app;
}
module.exports = { legacyOrderIntake };
