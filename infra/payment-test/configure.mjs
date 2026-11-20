// Run in the documented one-shot Docker command with /srv/dva-payment-test mounted at /settings.
// Obtain the public documentation key pair without putting it in Git or terminal output.
import { lstat, readFile, open, rename, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const revision = "8d0df11d14dadfe355050bdc9ba38618f6a9c028";
const target = "/settings/settings";
try {
  if (process.getuid?.() !== 0 || (await lstat("/settings")).isSymbolicLink())
    throw new Error();
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  const original = await readFile(target, "utf8");
  const values = new Map();
  for (const line of original.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || values.has(match[1])) throw new Error();
    values.set(match[1], match[2]);
  }
  if (
    !/^https:\/\/[^\s]+\/hooks\/[A-Za-z0-9_-]+$/.test(
      values.get("MATTERMOST_WEBHOOK_URL") || "",
    )
  )
    throw new Error();
  if (values.has("TOSS_TEST_CLIENT_KEY") !== values.has("TOSS_TEST_SECRET_KEY"))
    throw new Error();
  const additions = [];
  const add = (key, value) => {
    if (!values.has(key)) additions.push(`${key}=${value}`);
  };
  if (!values.has("PAYMENT_TEST_PUBLIC_URL")) {
    const url = new URL(process.env.PAYMENT_TEST_PUBLIC_URL || "");
    if (
      url.protocol !== "https:" || url.pathname !== "/payment-test" ||
      url.username || url.password || url.search || url.hash
    )
      throw new Error();
    add("PAYMENT_TEST_PUBLIC_URL", url.href);
  }
  if (!values.has("TOSS_TEST_CLIENT_KEY")) {
    const fetchSource = async (path) => {
      const response = await fetch(
        `https://raw.githubusercontent.com/tosspayments/tosspayments-sample/${revision}/${path}`,
        { redirect: "error", signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw new Error();
      const source = await response.text();
      if (source.length > 100000) throw new Error();
      return source;
    };
    const client = await fetchSource(
      "express-javascript/public/widget/checkout.html",
    );
    const server = await fetchSource("express-javascript/server.js");
    const clients = [...client.matchAll(/test_gck_[A-Za-z0-9_-]+/g)];
    const secrets = [...server.matchAll(/test_gsk_[A-Za-z0-9_-]+/g)];
    if (clients.length !== 1 || secrets.length !== 1) throw new Error();
    add("TOSS_TEST_CLIENT_KEY", clients[0][0]);
    add("TOSS_TEST_SECRET_KEY", secrets[0][0]);
  }
  add("PAYMENT_TEST_ENABLED", "true");
  add("PAYMENT_TEST_OPERATOR_TOKEN", randomBytes(32).toString("hex"));
  if (additions.length) {
    const temporary = `/settings/.configure-${randomBytes(8).toString("hex")}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        original.trimEnd() + "\n" + additions.join("\n") + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const directory = await open("/settings", "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  await chmod(target, 0o600);
  console.log(
    "Payment test settings prepared. Existing webhook and configured values preserved.",
  );
} catch {
  console.error(
    "Payment test settings setup failed. Check the settings, public URL and pinned official sample; no values were printed.",
  );
  process.exitCode = 1;
}
