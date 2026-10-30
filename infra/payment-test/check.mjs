// Disposable Docker verification: no production ports, credentials, volumes or outbound API calls.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../..", import.meta.url));
const run = "dva-payment-check-" + randomBytes(6).toString("hex");
const image = run + ":test";
const temporaryRoot = process.env.PAYMENT_TEST_TMP_ROOT || tmpdir();
const directory = mkdtempSync(join(temporaryRoot, "dva-payment-infra-"));
const settings = join(directory, "settings");
const env = { ...process.env, PAYMENT_TEST_SETTINGS: settings };
const checks = new Set();
let built = false,
  started = false;
function docker(args, expected = 0) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.error || result.status !== expected) {
    throw new Error(
      `Docker verification failed: ${args[0]}\n${result.stderr || ""}`,
    );
  }
  return result.stdout;
}
function checkContainer(suffix, entrypoint, containerImage, args) {
  const name = run + "-" + suffix;
  docker([
    "create",
    "--name",
    name,
    "--network=none",
    "--user=0",
    "--security-opt=no-new-privileges",
    "--memory=128m",
    "--pids-limit=64",
    "--entrypoint",
    entrypoint,
    containerImage,
    ...args,
  ]);
  checks.add(name);
  return name;
}
// The CLI streams these files to the daemon. A Jenkins agent's paths are not
// necessarily present on its separate Docker-in-Docker daemon's filesystem.
function copyTo(name, source, destination) {
  docker(["cp", source, `${name}:${destination}`]);
}
try {
  writeFileSync(
    settings,
    "PAYMENT_TEST_ENABLED=true\nPAYMENT_TEST_PUBLIC_URL=https://localhost/payment-test\n" +
      "TOSS_TEST_CLIENT_KEY=test_gck_fixture\nTOSS_TEST_SECRET_KEY=test_gsk_fixture\n" +
      "PAYMENT_TEST_OPERATOR_TOKEN=" +
      "a".repeat(32) +
      "\nMATTERMOST_WEBHOOK_URL=https://mattermost.invalid/hooks/test\n",
  );
  docker([
    "compose",
    "-f",
    "infra/payment-test/compose.yaml",
    "config",
    "--quiet",
  ]);
  docker(["build", "-f", "infra/payment-test/Dockerfile", "-t", image, "."]);
  built = true;
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    run,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=128m",
    "--pids-limit=64",
    "--tmpfs",
    "/data:uid=1000,gid=1000,mode=0700",
    "--tmpfs",
    "/tmp",
    "--env-file",
    settings,
    image,
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        run,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))",
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.ok(ready, "Dedicated service must become healthy");
  docker([
    "exec",
    run,
    "node",
    "-e",
    "if(process.getuid()!==1000)process.exit(1);if((require('fs').statSync('/data/requests.json').mode&511)!==384)process.exit(1)",
  ]);
  docker(["exec", run, "flock", "-n", "/data/service.lock", "true"], 1);
  const shell = checkContainer("shell", "bash", image, [
    "-n",
    "/tmp/deploy.sh",
  ]);
  copyTo(shell, join(root, "infra/payment-test/deploy.sh"), "/tmp/deploy.sh");
  docker(["start", "--attach", shell]);
  const original = readFileSync(settings, "utf8");
  writeFileSync(
    settings,
    original.replace(/^PAYMENT_TEST_OPERATOR_TOKEN=.*\n/m, ""),
  );
  const configure = checkContainer("configure", "node", image, [
    "/tmp/configure.mjs",
  ]);
  copyTo(
    configure,
    join(root, "infra/payment-test/configure.mjs"),
    "/tmp/configure.mjs",
  );
  copyTo(configure, directory, "/settings");
  docker(["start", "--attach", configure]);
  const configured = join(directory, "configured.settings");
  docker(["cp", `${configure}:/settings/settings`, configured]);
  const prepared = readFileSync(configured, "utf8");
  assert.ok(
    prepared.includes(
      "MATTERMOST_WEBHOOK_URL=https://mattermost.invalid/hooks/test",
    ),
  );
  assert.ok(prepared.includes("TOSS_TEST_SECRET_KEY=test_gsk_fixture"));
  assert.match(prepared, /^PAYMENT_TEST_OPERATOR_TOKEN=[a-f0-9]{64}$/m);
  docker(["start", "--attach", configure]);
  docker(["cp", `${configure}:/settings/settings`, configured]);
  assert.equal(
    readFileSync(configured, "utf8"),
    prepared,
    "Settings initialization must preserve existing values",
  );
  const nginx =
    "events {}\nhttp { server { listen 8080; location /internal/ { return 404; }\n" +
    readFileSync(join(root, "infra/payment-test/nginx.conf"), "utf8") +
    "\n} }\n";
  writeFileSync(join(directory, "nginx.conf"), nginx);
  const proxy = checkContainer("nginx", "nginx", "nginx:alpine", [
    "-t",
    "-c",
    "/tmp/payment-nginx.conf",
  ]);
  copyTo(proxy, join(directory, "nginx.conf"), "/tmp/payment-nginx.conf");
  docker(["start", "--attach", proxy]);
  console.log(
    "Payment Docker build, Compose, non-root health, file permissions, process lock, Bash and Nginx checks passed",
  );
} finally {
  for (const name of checks)
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  if (started) spawnSync("docker", ["rm", "-f", run], { stdio: "ignore" });
  if (built) spawnSync("docker", ["image", "rm", image], { stdio: "ignore" });
  assert.ok(
    resolve(directory).startsWith(
      resolve(temporaryRoot) + sep + "dva-payment-infra-",
    ),
  );
  rmSync(directory, { recursive: true });
}
