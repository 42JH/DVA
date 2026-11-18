import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { configuration } from "../../../backend/payment-test/config.mjs";
import { PaymentStore } from "../../../backend/payment-test/store.mjs";
import { PaymentTestService } from "../../../backend/payment-test/service.mjs";
import {
  TossTestClient,
  MattermostSender,
} from "../../../backend/payment-test/clients.mjs";
import { paymentServer } from "../../../backend/payment-test/server.mjs";

const simulation =
  process.env.PAYMENT_TEST_SIMULATION_URL || "http://127.0.0.1:4598";
const parsed = new URL(simulation);
assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
const temporaryRoot = process.env.PAYMENT_TEST_TMP_ROOT || tmpdir();
const directory = await mkdtemp(join(temporaryRoot, "dva-payment-simulation-"));
let server;
try {
  const config = configuration({
    NODE_ENV: "test",
    PAYMENT_TEST_ENABLED: "true",
    PORT: "0",
    PAYMENT_TEST_DATA_DIR: directory,
    PAYMENT_TEST_PUBLIC_URL: "http://127.0.0.1/payment-test",
    TOSS_TEST_CLIENT_KEY: "test_gck_fixture",
    TOSS_TEST_SECRET_KEY: "test_gsk_fixture",
    PAYMENT_TEST_OPERATOR_TOKEN: "a".repeat(32),
    MATTERMOST_WEBHOOK_URL: simulation + "/mattermost/hooks/test",
    PAYMENT_TEST_TOSS_BASE_URL: simulation + "/toss",
  });
  const store = new PaymentStore(directory);
  await store.initialize();
  const service = new PaymentTestService(
    config,
    store,
    new TossTestClient(config),
    new MattermostSender(config),
  );
  server = await paymentServer(config, service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, operator = false) => {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1",
        ...(operator
          ? { Authorization: "Bearer " + config.operatorToken }
          : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  for (const mode of ["ok", "uncertain", "reject"]) {
    const created = await post("/internal/payment-test/requests", {}, true);
    assert.equal(created.status, 201);
    const r = created.data;
    const api = `/payment-test/api/requests/${r.token}`;
    if (mode === "ok") {
      assert.equal(
        (
          await post(
            `/internal/payment-test/requests/${r.token}/notify`,
            {},
            true,
          )
        ).data.notificationStatus,
        "SENT",
      );
      assert.equal(
        (
          await post(
            `/internal/payment-test/requests/${r.token}/notify`,
            {},
            true,
          )
        ).status,
        409,
      );
    }
    const input = {
      paymentKey: `${mode}_${r.orderId}`,
      orderId: r.orderId,
      amount: r.amount,
    };
    const first = await post(api + "/confirm", input);
    if (mode === "ok") {
      assert.equal(first.data.status, "PAID");
      assert.equal((await post(api + "/confirm", input)).data.status, "PAID");
    } else if (mode === "uncertain") {
      assert.equal(first.status, 502);
      assert.equal((await post(api + "/reconcile", {})).data.status, "PAID");
    } else {
      assert.equal(first.status, 422);
    }
    console.log(
      `Verified actual service HTTP flow against simulation: ${mode}`,
    );
  }
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.ok(
    resolve(directory).startsWith(
      resolve(temporaryRoot) + sep + "dva-payment-simulation-",
    ),
  );
  await rm(directory, { recursive: true });
}
