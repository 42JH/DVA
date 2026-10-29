// 실제 서비스 대신 임시 Docker 네트워크와 가짜 웹훅만 사용하는 관측 환경 검증.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resources, render, checks } from "./render.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const id = "dva-obs-test-" + randomBytes(6).toString("hex");
const work = resolve(root, "../../.deploy", id);
mkdirSync(work, { recursive: true });
const created = [];
let network = false;
const password = randomBytes(24).toString("hex");
const images = {
  nginx: "nginx:1.28-alpine",
  alloy: "grafana/alloy:v1.21.2",
  loki: "grafana/loki:3.7.9",
  prometheus: "prom/prometheus:v3.15.1",
  grafana: "grafana/grafana:13.3.0",
  node: "node:24-bookworm-slim",
};
function docker(args, required = true) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
  });
  if (required && (result.error || result.status !== 0))
    throw new Error(
      `Docker ${args[0]} failed: ${result.stderr || result.stdout || result.error}`,
    );
  return (
    (result.stdout || "") + (args[0] === "logs" ? result.stderr || "" : "")
  ).trim();
}
function create(name, alias, image, args = [], command = []) {
  const full = id + "-" + name;
  docker([
    "create",
    "--name",
    full,
    "--network",
    id,
    "--network-alias",
    alias,
    ...args,
    image,
    ...command,
  ]);
  created.push(full);
  return full;
}
function start(container) {
  docker(["start", container]);
}
function copy(source, container, destination) {
  docker(["cp", source, `${container}:${destination}`]);
}
const label = (service) => [
  "--label",
  `com.docker.compose.project=${id}`,
  "--label",
  `com.docker.compose.service=${service}`,
];
let backend;
function inside(code) {
  const output = docker([
    "exec",
    backend,
    "node",
    "-e",
    `Promise.resolve().then(async()=>{${code}}).then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exit(1)})`,
  ]);
  return JSON.parse(output);
}
function get(url, auth = false) {
  return inside(
    `const r=await fetch(${JSON.stringify(url)}, {headers:${JSON.stringify(auth ? { Authorization: "Basic " + Buffer.from("admin:" + password).toString("base64") } : {})},signal:AbortSignal.timeout(4000)}); const text=await r.text(); return {status:r.status,text};`,
  );
}
function post(url, body, credentials = "admin:" + password) {
  return inside(
    `const r=await fetch(${JSON.stringify(url)}, {method:'POST',headers:${JSON.stringify({ Authorization: "Basic " + Buffer.from(credentials).toString("base64"), "Content-Type": "application/json" })},body:${JSON.stringify(JSON.stringify(body))},signal:AbortSignal.timeout(8000)});return {status:r.status,text:await r.text()};`,
  );
}
async function until(label, fn, seconds = 75, container) {
  const end = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < end) {
    if (
      container &&
      docker(["inspect", "--format", "{{.State.Status}}", container]) ===
        "exited"
    )
      throw new Error(label + ": container exited");
    try {
      const result = fn();
      if (result) {
        console.log("PASS: " + label);
        return result;
      }
    } catch (error) {
      last = error.message;
    }
    await delay(1000);
  }
  throw new Error(`Timeout: ${label}${last ? " (" + last + ")" : ""}`);
}

try {
  const paused = resources();
  assert.ok(paused.groups[0].rules.every((rule) => rule.isPaused));
  assert.equal(paused.policies[0].repeat_interval, "24h");
  assert.deepEqual(paused.policies[0].group_by, ["service", "incident"]);
  assert.equal(
    paused.contactPoints[0].receivers[0].disableResolveMessage,
    true,
  );
  assert.equal(checks.length, 7);
  for (const uid of ["backend_down", "database_down", "nginx_down"])
    assert.equal(checks.find((row) => row[0] === uid)[3], "1m");
  assert.throws(() => resources("http://example.invalid/hooks/test"));
  assert.throws(() =>
    resources("https://example.invalid/hooks/test?token=private"),
  );
  assert.throws(() =>
    render(resolve(work, "invalid"), { GRAFANA_ADMIN_PASSWORD: "short" }),
  );
  const production = readFileSync(resolve(root, "compose.yaml"), "utf8");
  assert.ok(!production.match(/\n\s+-?\s*["']?(3100|9090|12345|2375):/));
  assert.ok(production.includes("127.0.0.1:3001:3000"));
  console.log(
    "PASS: notification policy, disabled-unconfigured alerts and secret validation",
  );

  docker(["network", "create", "--internal", id]);
  network = true;
  backend = create(
    "backend",
    "backend",
    images.node,
    ["--memory", "128m", ...label("backend")],
    ["node", "/fixture.cjs"],
  );
  copy(resolve(root, "test/fixture.cjs"), backend, "/fixture.cjs");
  start(backend);
  await until(
    "local backend/webhook fixture",
    () => get("http://127.0.0.1:3000/").status === 200,
    30,
  );
  const db = create(
    "db",
    "db",
    images.node,
    ["--memory", "64m", ...label("db")],
    [
      "node",
      "-e",
      'console.log("2026-10-29 00:00:00 UTC [1] 23505 ERROR: PRIVATE-PHONE-01012345678 SQL value");setInterval(()=>{},60000)',
    ],
  );
  start(db);
  const excluded = create(
    "ai-excluded",
    "ai-excluded",
    images.node,
    ["--memory", "64m", ...label("ai")],
    [
      "node",
      "-e",
      'console.log(JSON.stringify({event:"AI-MUST-BE-EXCLUDED"}));setInterval(()=>{},60000)',
    ],
  );
  start(excluded);
  const nginx = create("nginx", "nginx", images.nginx, [
    "--memory",
    "64m",
    ...label("nginx"),
  ]);
  copy(
    resolve(root, "../nginx/default.prod.conf"),
    nginx,
    "/etc/nginx/conf.d/default.conf",
  );
  start(nginx);
  docker(["exec", nginx, "nginx", "-t"]);
  for (const route of [
    "/internal/metrics",
    "/api/internal/metrics",
    "/api/internal/metrics/",
    "/api/health/ready",
  ])
    assert.equal(get("http://nginx" + route).status, 404);
  assert.equal(get("http://nginx/api/health").status, 200);
  get(
    "http://nginx/api/check?phone=PRIVATE-PHONE-01012345678&token=PRIVATE-TOKEN",
  );
  console.log("PASS: real Nginx config hides internal metrics and readiness");

  const reader = create(
    "reader",
    "docker-reader",
    images.node,
    [
      "--memory",
      "96m",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "-e",
      `APP_PROJECT=${id}`,
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
    ],
    ["node", "/docker-reader.mjs"],
  );
  copy(resolve(root, "docker-reader.mjs"), reader, "/docker-reader.mjs");
  start(reader);
  await until(
    "restricted Docker reader",
    () => get("http://docker-reader:2375/_ping").status === 200,
    30,
  );
  const metadata = get(
    "http://docker-reader:2375/containers/" +
      docker(["inspect", "--format", "{{.Id}}", backend]) +
      "/json",
  );
  assert.equal(metadata.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(metadata.text).Config), ["Tty"]);
  assert.equal(
    get(
      "http://docker-reader:2375/containers/" +
        docker(["inspect", "--format", "{{.Id}}", excluded]) +
        "/json",
    ).status,
    403,
  );
  const refused = inside(
    'const r=await fetch("http://docker-reader:2375/containers/create",{method:"POST",body:"{}"});return r.status;',
  );
  assert.equal(refused, 403);
  console.log(
    "PASS: Docker secret fields, AI access and write APIs are denied",
  );

  const loki = create(
    "loki",
    "loki",
    images.loki,
    ["--memory", "512m", "--tmpfs", "/loki:uid=10001,gid=10001"],
    ["-config.file=/etc/loki/config.yaml"],
  );
  copy(resolve(root, "loki.yaml"), loki, "/etc/loki/config.yaml");
  start(loki);
  const prometheus = create(
    "prometheus",
    "prometheus",
    images.prometheus,
    ["--memory", "384m", "--tmpfs", "/prometheus:uid=65534,gid=65534"],
    [
      "--config.file=/etc/prometheus/prometheus.yaml",
      "--storage.tsdb.retention.time=7d",
      "--storage.tsdb.retention.size=2GB",
      "--web.enable-remote-write-receiver",
    ],
  );
  copy(
    resolve(root, "prometheus.yaml"),
    prometheus,
    "/etc/prometheus/prometheus.yaml",
  );
  start(prometheus);
  const alloy = create(
    "alloy",
    "alloy",
    images.alloy,
    [
      "--memory",
      "256m",
      "--user",
      "65534:65534",
      "--tmpfs",
      "/var/lib/alloy:uid=65534,gid=65534",
      "-e",
      `APP_PROJECT=${id}`,
      "--mount",
      "type=bind,source=/proc,target=/host/proc,readonly",
      "--mount",
      "type=bind,source=/sys,target=/host/sys,readonly",
    ],
    [
      "run",
      "--server.http.listen-addr=0.0.0.0:12345",
      "--storage.path=/var/lib/alloy",
      "/etc/alloy/config.alloy",
    ],
  );
  copy(resolve(root, "config.alloy"), alloy, "/etc/alloy/config.alloy");
  start(alloy);
  await until("Loki ready", () => get("http://loki:3100/ready").status === 200);
  await until(
    "Prometheus ready",
    () => get("http://prometheus:9090/-/ready").status === 200,
  );
  const query = (expression) => {
    const response = get(
      "http://prometheus:9090/api/v1/query?" +
        new URLSearchParams({ query: expression }),
    );
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text).data.result;
  };
  await until(
    "host metrics reach Prometheus",
    () => query("node_memory_MemTotal_bytes").length,
  );
  await until("Nginx probes reach Prometheus", () =>
    query('probe_success{job="service_probe"}').some((x) => x.value[1] === "1"),
  );
  for (const row of checks) assert.ok(Array.isArray(query(row[2])), row[0]);
  const emit = (payload) =>
    inside(
      `const r=await fetch('http://localhost:3000/control/emit',{method:'POST',body:${JSON.stringify(JSON.stringify(payload))}});return r.status;`,
    );
  emit({
    event: "request_failed",
    requestId: "e01d28da-261d-49c0-9f91-dc332846d6fa",
    orderSeq: 112,
    statusCode: 500,
    level: "error",
    body: "PRIVATE-PHONE-01012345678",
    headers: { authorization: "PRIVATE-TOKEN" },
  });
  const logs = (selector) => {
    const response = get(
      "http://loki:3100/loki/api/v1/query_range?" +
        new URLSearchParams({ query: selector, limit: "1000" }),
    );
    assert.equal(response.status, 200, response.text);
    return JSON.parse(response.text).data.result;
  };
  await until(
    "sanitized backend logs reach Loki",
    () =>
      logs('{service="backend"} |= "e01d28da-261d-49c0-9f91-dc332846d6fa"')
        .length,
  );
  const all = logs('{environment="production"}');
  assert.ok(
    !JSON.stringify(all).match(
      /PRIVATE-PHONE|PRIVATE-TOKEN|AI-MUST-BE-EXCLUDED/,
    ),
  );
  assert.ok(
    all.some(
      (stream) =>
        stream.stream.service === "db" &&
        stream.values.some(([, line]) => JSON.parse(line).sqlstate === "23505"),
    ),
  );
  assert.ok(
    all.every((stream) =>
      Object.keys(stream.stream).every((key) =>
        ["service", "environment"].includes(key),
      ),
    ),
    JSON.stringify(all.map((stream) => stream.stream)),
  );
  console.log(
    "PASS: backend/DB/proxy privacy filtering, AI exclusion and bounded Loki labels",
  );
  docker(["stop", alloy]);
  emit({
    event: "backend_started",
    requestId: "d85b5352-d57a-4dce-8d8f-2971471e05f3",
    level: "info",
  });
  start(alloy);
  await until(
    "retained Docker logs are recovered after collector restart",
    () =>
      logs('{service="backend"} |= "d85b5352-d57a-4dce-8d8f-2971471e05f3"')
        .length,
  );

  const alerting = resolve(work, "alerting");
  mkdirSync(alerting);
  writeFileSync(
    resolve(alerting, "resources.json"),
    JSON.stringify(
      resources("http://backend:3000/hooks/test", { allowHttp: true }),
    ),
  );
  const grafana = create("grafana", "grafana", images.grafana, [
    "--memory",
    "512m",
    "-e",
    "GF_SECURITY_ADMIN_USER=admin",
    "-e",
    `GF_SECURITY_ADMIN_PASSWORD=${password}`,
    "-e",
    "GF_SERVER_ROOT_URL=http://grafana:3000/",
    "-e",
    "GF_LOG_LEVEL=error",
    "-e",
    "GF_ANALYTICS_REPORTING_ENABLED=false",
  ]);
  copy(
    resolve(root, "grafana/provisioning/datasources") + "/.",
    grafana,
    "/etc/grafana/provisioning/datasources",
  );
  copy(
    resolve(root, "grafana/provisioning/dashboards") + "/.",
    grafana,
    "/etc/grafana/provisioning/dashboards",
  );
  copy(
    resolve(root, "grafana/dashboards"),
    grafana,
    "/var/lib/grafana/dashboards",
  );
  copy(alerting + "/.", grafana, "/etc/grafana/provisioning/alerting");
  start(grafana);
  await until(
    "Grafana provisions dashboard, sources and seven alert rules",
    () => {
      if (get("http://grafana:3000/api/health").status !== 200) return false;
      const rules = get(
        "http://grafana:3000/api/v1/provisioning/alert-rules",
        true,
      );
      return (
        rules.status === 200 &&
        JSON.parse(rules.text).length === 7 &&
        get("http://grafana:3000/api/dashboards/uid/dva-operations", true)
          .status === 200
      );
    },
    90,
    grafana,
  );
  const user = post("http://grafana:3000/api/admin/users", {
    name: "개발자 검증",
    email: "viewer@example.invalid",
    login: "obs-viewer",
    password,
  });
  assert.equal(user.status, 200, user.text);
  const sourceQuery = post(
    "http://grafana:3000/api/ds/query",
    {
      from: String(Date.now() - 3600000),
      to: String(Date.now()),
      queries: [
        {
          refId: "A",
          datasource: { type: "loki", uid: "loki" },
          expr: '{service="backend"} |= "e01d28da-261d-49c0-9f91-dc332846d6fa"',
          queryType: "range",
          maxLines: 50,
        },
      ],
    },
    "obs-viewer:" + password,
  );
  assert.equal(sourceQuery.status, 200, sourceQuery.text);
  assert.ok(sourceQuery.text.includes("e01d28da-261d-49c0-9f91-dc332846d6fa"));
  assert.equal(
    post(
      "http://grafana:3000/api/datasources",
      { name: "forbidden", type: "prometheus", url: "http://prometheus:9090" },
      "obs-viewer:" + password,
    ).status,
    403,
  );
  console.log(
    "PASS: individual Viewer can query logs but cannot change data sources",
  );
  const states = (body) =>
    inside(
      `const r=await fetch('http://localhost:3000/control/state',{method:'POST',body:${JSON.stringify(JSON.stringify(body))}});return r.status;`,
    );
  states({ review: 1 });
  await until(
    "HTTP success with REVIEW_REQUIRED produces a Mattermost-compatible alert",
    () => {
      const messages = JSON.parse(
        get("http://localhost:3000/control/messages").text,
      );
      return messages.some(
        (message) =>
          typeof message.text === "string" &&
          message.text.includes("submission_review_required"),
      );
    },
    100,
  );
  const messages = JSON.parse(
    get("http://localhost:3000/control/messages").text,
  );
  assert.ok(
    messages.every(
      (message) =>
        Object.keys(message).length === 1 && typeof message.text === "string",
    ),
  );
  assert.ok(
    !JSON.stringify(messages).match(/PRIVATE|requestId|body|password|phone/),
  );
  console.log(
    "PASS: real Grafana rule evaluation delivers only safe text to a local fake webhook",
  );
  const ruleConfig = JSON.parse(
    get("http://grafana:3000/api/v1/provisioning/policies", true).text,
  );
  // Grafana API는 같은 24시간을 1d로 정규화할 수 있다.
  assert.match(ruleConfig.repeat_interval, /^(24h|1d)$/);
  const contacts = JSON.parse(
    get("http://grafana:3000/api/v1/provisioning/contact-points", true).text,
  );
  assert.equal(contacts[0].disableResolveMessage, true);
  const beforeResolved = messages.length;
  states({ review: 0, db: 0 });
  await until(
    "DB outage enters pending state before the one-minute threshold",
    () => {
      const response = get(
        "http://grafana:3000/api/prometheus/grafana/api/v1/rules",
        true,
      );
      if (response.status !== 200) return false;
      return JSON.parse(response.text).data.groups.some((group) =>
        group.rules.some(
          (rule) => rule.name === "database_down" && rule.state === "pending",
        ),
      );
    },
    60,
  );
  await until(
    "DB failure sustained for one minute triggers the distinct database incident",
    () =>
      JSON.parse(get("http://localhost:3000/control/messages").text).some(
        (message) => message.text.includes("database_down"),
      ),
    110,
  );
  const finalMessages = JSON.parse(
    get("http://localhost:3000/control/messages").text,
  );
  assert.equal(
    finalMessages.filter((message) =>
      message.text.includes("submission_review_required"),
    ).length,
    1,
  );
  assert.ok(!JSON.stringify(finalMessages).match(/Resolved|resolved|복구/));
  assert.ok(finalMessages.length >= beforeResolved + 1);
  console.log(
    "PASS: one-minute DB threshold, no recovery message and no repeated same incident",
  );
  console.log(
    "PASS: isolated observability integration complete (no production or external notification).",
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Observability verification failed",
  );
  for (const name of created.filter((value) =>
    /-(alloy|grafana|reader|loki|nginx|prometheus)$/.test(value),
  ))
    console.error(name + "\n" + docker(["logs", "--tail", "25", name], false));
  process.exitCode = 1;
} finally {
  for (const name of created.reverse()) docker(["rm", "-f", "-v", name], false);
  if (network) docker(["network", "rm", id], false);
}
