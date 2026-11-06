import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = mkdtempSync(join(tmpdir(), "dva-security-check-"));
const { resources, securityChecks } = await import(
  pathToFileURL(join(repo, "infra/observability/render.mjs"))
);
const run = "dva-s10-check-" + randomBytes(5).toString("hex");
const fixture = join(output, run);
mkdirSync(fixture);
const containers = [];
let network = false;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const mount = (source, destination) => [
  "--mount",
  `type=bind,src=${resolve(source)},dst=${destination},readonly`,
];
async function port(name, target) {
  for (let i = 0; i < 5; i++) {
    const data = JSON.parse(docker("inspect", name))[0];
    if (!data.State.Running)
      throw new Error(
        "container exited: " + name + " " + JSON.stringify(data.State),
      );
    const value = data.NetworkSettings.Ports?.[target + "/tcp"]?.[0]?.HostPort;
    if (value) return value;
    await delay(100);
  }
  throw new Error("port was not published: " + name);
}
function start(name, image, args, command = []) {
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "dva.security-check=" + run,
    "--network",
    run,
    ...args,
    image,
    ...command,
  );
  containers.push(name);
}
async function wait(url, headers = {}) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).ok)
        return;
    } catch {}
    await delay(500);
  }
  throw new Error("service not ready: " + url);
}
const report = { run, checks: [] };
try {
  docker("network", "create", "--label", "dva.security-check=" + run, run);
  network = true;
  const loki = run + "-loki";
  start(
    loki,
    "grafana/loki:3.7.9",
    [
      "--network-alias",
      "loki",
      "-p",
      "127.0.0.1::3100",
      "--memory",
      "512m",
      "--tmpfs",
      "/loki:uid=10001,gid=10001,mode=0700",
      ...mount(
        join(repo, "infra/observability/loki.yaml"),
        "/etc/loki/check.yaml",
      ),
    ],
    ["-config.file=/etc/loki/check.yaml"],
  );
  const lokiUrl = "http://127.0.0.1:" + (await port(loki, 3100));
  report.lokiUrl = lokiUrl;
  await wait(lokiUrl + "/ready");
  const base = Date.now() - 60000;
  report.base = new Date(base).toISOString();
  const time = (ms) => (BigInt(ms) * 1000000n).toString();
  const hash = (n) => n.toString(16).padStart(64, "0");
  const login = (account, source) => ({
    event: "authentication_failure",
    authType: "admin_login",
    reason: "invalid_credentials",
    accountKey: hash(account),
    sourceKey: hash(source),
  });
  let stamp = 0n;
  async function push(records) {
    const values = records.map((record) => {
      const now = BigInt(Date.now()) * 1000000n;
      stamp = (now > stamp ? now : stamp) + 1n;
      return [stamp.toString(), JSON.stringify(record)];
    });
    const response = await fetch(lokiUrl + "/loki/api/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streams: [
          { stream: { service: "backend", environment: "production" }, values },
        ],
      }),
    });
    assert.equal(response.status, 204, await response.text());
  }
  async function query(index) {
    const response = await fetch(
      lokiUrl +
        "/loki/api/v1/query?" +
        new URLSearchParams({ query: securityChecks[index][2] }),
    );
    const raw = await response.text();
    assert.equal(response.status, 200, "query " + index + ": " + raw);
    const data = JSON.parse(raw);
    assert.equal(data.status, "success");
    assert.equal(data.data.result.length, 1, JSON.stringify(data));
    assert.deepEqual(data.data.result[0].metric, {});
    return Number(data.data.result[0].value[1]);
  }
  const noise = [];
  for (const reason of [
    "rate_limited",
    "account_pending",
    "account_inactive",
    "access_denied",
    "invalid_input",
    "service_unconfigured",
  ])
    for (let i = 0; i < 35; i++) noise.push({ ...login(9999, 9999), reason });
  for (let i = 0; i < 35; i++)
    noise.push({
      ...login(9999, 9999),
      event: "authentication_success",
      reason: "authenticated",
    });
  await push(noise);
  for (let i = 0; i < 4; i++) assert.equal(await query(i), 0);
  report.checks.push(
    "success, throttling, account policy and invalid input do not inflate attack counts",
  );
  await push([
    ...Array.from({ length: 4 }, (_, i) => login(1, 100 + i)),
    ...Array.from({ length: 5 }, (_, i) => login(20 + i, 100)),
  ]);
  assert.equal(await query(0), 0);
  await push([login(1, 100)]);
  assert.equal(await query(0), 1);
  report.checks.push(
    "production Loki account threshold 4/5 across multiple sources",
  );
  await push(Array.from({ length: 3 }, (_, i) => login(30 + i, 100)));
  assert.equal(await query(1), 0);
  await push([login(33, 100)]);
  assert.equal(await query(1), 1);
  report.checks.push(
    "production Loki distinct-source-account threshold 9/10 without duplicate-account inflation",
  );
  await push(Array.from({ length: 15 }, (_, i) => login(100 + i, 300 + i)));
  assert.equal(await query(2), 0);
  await push([login(115, 315)]);
  assert.equal(await query(2), 1);
  report.checks.push("production Loki global login failure threshold 29/30");
  await push(
    ["ai_business", "ai_persona"].flatMap((authType) =>
      Array.from({ length: 4 }, () => ({
        event: "authentication_failure",
        authType,
        reason: "invalid_service_token",
      })),
    ),
  );
  assert.equal(await query(3), 0);
  await push([
    {
      event: "authentication_failure",
      authType: "ai_business",
      reason: "invalid_service_token",
    },
  ]);
  assert.equal(await query(3), 1);
  report.checks.push(
    "production Loki AI kind threshold 4/5 keeps business and persona failures separate",
  );
  await push(Array.from({ length: 1200 }, (_, i) => login(10000 + i, 500)));
  for (let i = 0; i < 4; i++) assert.equal(await query(i), 1);
  report.checks.push(
    "1200 pseudonyms retain a single aggregate result without identifier labels",
  );
  await push(
    Array.from({ length: 1200 }, (_, i) => login(20000 + i, 20000 + i)),
  );
  for (let i = 0; i < 4; i++) assert.equal(await query(i), 1);
  report.checks.push("1200 distinct sources also retain bounded alert results");

  const source = readFileSync(
    join(repo, "infra/observability/config.alloy"),
    "utf8",
  );
  const privacy = source.slice(
    source.indexOf('loki.process "privacy"'),
    source.indexOf('loki.write "local"'),
  );
  const unsafe = "PRIVATE-password-token-ip-address";
  const safe = {
    ...login(8888, 7777),
    requestId: randomUUID(),
    password: unsafe,
    Authorization: unsafe,
    ip: unsafe,
  };
  const invalid = {
    ...safe,
    accountKey: unsafe,
    sourceKey: unsafe,
    authType: unsafe,
  };
  writeFileSync(
    join(fixture, "events.log"),
    [safe, invalid].map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  writeFileSync(
    join(fixture, "check.alloy"),
    `logging { level = "warn" }\nloki.source.file "fixture" {\n targets = [{__path__ = "/fixture/events.log", service = "backend", environment = "production"}]\n forward_to = [loki.process.privacy.receiver]\n}\n${privacy}\nloki.write "local" {\n endpoint {\n url = "http://loki:3100/loki/api/v1/push"\n }\n}\n`,
  );
  const alloy = run + "-alloy";
  start(
    alloy,
    "grafana/alloy:v1.21.2",
    ["--memory", "128m", ...mount(fixture, "/fixture")],
    ["run", "--storage.path=/tmp/alloy", "/fixture/check.alloy"],
  );
  let collected = [];
  for (let i = 0; i < 80; i++) {
    const response = await fetch(
      lokiUrl +
        "/loki/api/v1/query_range?" +
        new URLSearchParams({
          query:
            '{service="backend",environment="production"} |= "' +
            safe.requestId +
            '"',
          start: time(Date.now() - 120000),
          limit: "10",
        }),
    );
    const result = await response.json();
    if (response.ok) {
      collected = result.data.result.flatMap((s) => {
        assert.deepEqual(s.stream, {
          environment: "production",
          service: "backend",
        });
        return s.values.map((v) => JSON.parse(v[1]));
      });
      if (collected.length === 2) break;
    }
    await delay(500);
  }
  assert.equal(collected.length, 2, JSON.stringify(collected));
  assert.ok(!JSON.stringify(collected).includes(unsafe));
  assert.ok(
    collected.some(
      (x) =>
        x.accountKey === safe.accountKey &&
        x.sourceKey === safe.sourceKey &&
        x.authType === "admin_login",
    ),
  );
  assert.ok(
    collected.some(
      (x) => x.accountKey === "" && x.sourceKey === "" && x.authType === "",
    ),
  );
  report.checks.push(
    "actual Alloy privacy pipeline preserves safe pseudonyms and removes secrets and invalid fields",
  );

  writeFileSync(join(fixture, "resources.json"), JSON.stringify(resources()));
  const grafana = run + "-grafana";
  const password = randomBytes(24).toString("hex");
  start(grafana, "grafana/grafana:13.3.0", [
    "-p",
    "127.0.0.1::3000",
    "--memory",
    "512m",
    "-e",
    "GF_SECURITY_ADMIN_USER=test-admin",
    "-e",
    "GF_SECURITY_ADMIN_PASSWORD=" + password,
    "-e",
    "GF_ANALYTICS_REPORTING_ENABLED=false",
    "-e",
    "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
    "-e",
    "GF_PLUGINS_PREINSTALL_DISABLED=true",
    ...mount(
      join(fixture, "resources.json"),
      "/etc/grafana/provisioning/alerting/s10.json",
    ),
    ...mount(
      join(
        repo,
        "infra/observability/grafana/provisioning/datasources/datasources.yaml",
      ),
      "/etc/grafana/provisioning/datasources/check.yaml",
    ),
  ]);
  const grafanaUrl = "http://127.0.0.1:" + (await port(grafana, 3000));
  const authorization =
    "Basic " + Buffer.from("test-admin:" + password).toString("base64");
  await wait(grafanaUrl + "/api/health");
  const rulesResponse = await fetch(
    grafanaUrl + "/api/v1/provisioning/alert-rules",
    { headers: { Authorization: authorization } },
  );
  assert.equal(rulesResponse.status, 200);
  const rules = await rulesResponse.json();
  assert.equal(rules.length, 10);
  assert.ok(rules.every((r) => r.isPaused));
  const model = rules.find((r) => r.uid === "dva_login_account_failures")
    .data[0].model;
  const evaluation = await fetch(grafanaUrl + "/api/ds/query", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: String(base),
      to: String(Date.now()),
      queries: [
        {
          ...model,
          datasource: { type: "loki", uid: "loki" },
          maxDataPoints: 1,
        },
      ],
    }),
  });
  const evaluated = await evaluation.json();
  assert.equal(evaluation.status, 200, JSON.stringify(evaluated));
  assert.ok(!evaluated.results.A.error, JSON.stringify(evaluated));
  assert.ok(evaluated.results.A.frames.length > 0, JSON.stringify(evaluated));
  assert.ok(
    evaluated.results.A.frames.some((f) => f.data.values.flat().includes(1)),
    JSON.stringify(evaluated),
  );
  report.checks.push(
    "Grafana provisions all 10 paused rules and evaluates the actual Loki instant query model",
  );
  assert.ok(
    rules
      .filter((r) => securityChecks.some(([uid]) => r.uid === "dva_" + uid))
      .every((r) => r.execErrState === "Error"),
  );
  for (const alertname of ["DatasourceError", "login_account_failures"]) {
    const privateValue = "PRIVATE-security-error-body-and-token";
    const body = {
      name: "dva-message",
      template: resources().templates[0].template,
      alerts: [
        {
          status: "firing",
          labels: {
            alertname,
            service: "backend",
            incident: "login_account_failures",
            accountKey: "a".repeat(64),
          },
          annotations: {
            summary:
              alertname === "DatasourceError" ? privateValue : "정상 고정 요약",
            Error: privateValue,
          },
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 60000).toISOString(),
          generatorURL: "https://example.invalid/",
        },
      ],
    };
    const response = await fetch(
      grafanaUrl + "/api/alertmanager/grafana/config/api/v1/templates/test",
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const tested = await response.json();
    assert.equal(response.status, 200, JSON.stringify(tested));
    assert.ok(!tested.errors?.length, JSON.stringify(tested));
    const rendered = tested.results.map((r) => r.text).join("\n");
    assert.ok(rendered.length);
    assert.ok(!rendered.includes(privateValue));
    assert.ok(!rendered.includes("a".repeat(64)));
    assert.ok(
      rendered.includes(
        alertname === "DatasourceError"
          ? "보안 탐지 조회에 실패"
          : "정상 고정 요약",
      ),
      JSON.stringify(tested),
    );
  }
  report.checks.push(
    "Grafana renders fixed query-error and normal notifications without raw errors or pseudonyms",
  );
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  for (const name of containers) {
    try {
      const log = spawnSync("docker", ["logs", name], {
        encoding: "utf8",
        windowsHide: true,
      });
      writeFileSync(join(output, name + ".log"), log.stdout + log.stderr);
    } catch {}
  }
  throw error;
} finally {
  writeFileSync(
    join(output, "observability-runtime-result.json"),
    JSON.stringify(report, null, 2),
  );
  for (const name of containers.reverse()) {
    assert.equal(
      docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "dva.security-check"}}',
        name,
      ),
      run,
    );
    docker("rm", "-f", name);
  }
  if (network) {
    assert.equal(
      docker(
        "network",
        "inspect",
        "--format",
        '{{index .Labels "dva.security-check"}}',
        run,
      ),
      run,
    );
    docker("network", "rm", run);
  }
  if (report.passed) {
    assert.equal(dirname(resolve(output)), resolve(tmpdir()));
    assert.ok(basename(output).startsWith("dva-security-check-"));
    rmSync(output, { recursive: true, force: true });
  } else console.error("Diagnostics: " + output);
}
