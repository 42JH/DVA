import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resources, render, checks, securityChecks } from "./render.mjs";

const work = mkdtempSync(join(tmpdir(), "dva-observability-check-"));
try {
  const paused = resources();
  assert.ok(paused.groups[0].rules.every((rule) => rule.isPaused));
  assert.equal(paused.policies[0].repeat_interval, "24h");
  assert.deepEqual(paused.policies[0].group_by, ["service", "incident"]);
  assert.equal(
    paused.contactPoints[0].receivers[0].disableResolveMessage,
    true,
  );
  assert.equal(checks.length, 6);
  assert.equal(securityChecks.length, 4);
  assert.equal(paused.groups[0].rules.length, 10);
  for (const [uid] of securityChecks) {
    const rule = paused.groups[0].rules.find((row) => row.uid === `dva_${uid}`);
    assert.equal(rule.data[0].datasourceUid, "loki");
    assert.equal(rule.data[0].model.queryType, "instant");
    assert.equal(rule.execErrState, "Error");
    assert.deepEqual(rule.labels, { service: "backend", incident: uid });
    assert.ok(rule.data[0].model.expr.endsWith("or vector(0)"));
    assert.ok(!rule.annotations.summary.includes("{{"));
  }
  assert.ok(
    paused.templates[0].template.includes(
      'eq .Labels.alertname "DatasourceError"',
    ),
  );
  assert.ok(!paused.templates[0].template.includes(".Annotations.Error"));
  for (const uid of ["backend_down", "database_down", "nginx_down"])
    assert.equal(checks.find((row) => row[0] === uid)[3], "1m");
  assert.throws(() => resources("http://example.invalid/hooks/test"));
  assert.throws(() =>
    resources("https://example.invalid/hooks/test?token=private"),
  );
  const environment = {
    OBS_DATA_DIR: "/srv/dva-observability/data",
    OBS_RUNTIME_DIR: "/srv/dva-observability/runtime",
    GRAFANA_ADMIN_USER: "test-admin",
    GRAFANA_ADMIN_PASSWORD: "static-check-only-password",
    GRAFANA_ROOT_URL: "https://example.invalid/grafana/",
  };
  assert.throws(
    () => render(work, { ...environment, GRAFANA_ADMIN_PASSWORD: "short" }),
    /administrator password/,
  );
  render(work, environment);
  assert.deepEqual(
    JSON.parse(readFileSync(join(work, "alerting/resources.json"), "utf8")),
    paused,
  );
  const production = readFileSync(
    new URL("./compose.yaml", import.meta.url),
    "utf8",
  );
  assert.ok(!production.match(/\n\s+-?\s*["']?(3100|9090|12345|2375):/));
  assert.ok(production.includes("127.0.0.1:3001:3000"));
  console.log(
    "PASS: observability configuration, private ports and alert policy",
  );
} finally {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert.ok(work.startsWith(join(tmpdir(), "dva-observability-check-")));
  rmSync(work, { recursive: true, force: true });
}
