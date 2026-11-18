import { configuration } from './config.mjs';
import { PaymentStore } from './store.mjs';
import { TossTestClient, MattermostSender } from './clients.mjs';
import { PaymentTestService } from './service.mjs';
import { paymentServer } from './server.mjs';

try {
  const config = configuration();
  const store = new PaymentStore(config.dataDir);
  await store.initialize();
  const service = new PaymentTestService(
    config,
    store,
    new TossTestClient(config),
    new MattermostSender(config),
  );
  const server = await paymentServer(config, service);
  server.on('error', () => {
    process.stderr.write('{"event":"payment_test_server_failed"}\n');
    process.exitCode = 1;
  });
  server.listen(config.port, '0.0.0.0', () => {
    process.stdout.write(
      JSON.stringify({ event: 'payment_test_started', port: server.address().port }) + '\n',
    );
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch {
  process.stderr.write('{"event":"payment_test_startup_failed"}\n');
  process.exitCode = 1;
}
