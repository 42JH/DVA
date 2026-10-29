const http = require("node:http");
const state = { review: 0, auth: 0, stale: 0, db: 1, errors: 0 };
const messages = [];
http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/control/state") {
      if (req.method === "POST") Object.assign(state, JSON.parse(raw));
      return res.end(JSON.stringify(state));
    }
    if (req.url === "/control/messages")
      return res.end(JSON.stringify(messages));
    if (req.url === "/control/emit") {
      console.log(raw);
      return res.end("{}");
    }
    if (req.url === "/hooks/test") {
      messages.push(JSON.parse(raw));
      return res.end("ok");
    }
    if (req.url === "/internal/metrics") {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      return res.end(
        [
          `dva_database_up ${state.db}`,
          "dva_order_metrics_success 1",
          `dva_orders_attention{status="REVIEW_REQUIRED"} ${state.review}`,
          `dva_orders_attention{status="AUTH_FAILED"} ${state.auth}`,
          `dva_orders_attention{status="SUBMITTING"} ${state.stale}`,
          `dva_orders_stale_submitting ${state.stale}`,
          "# TYPE dva_submission_http_errors_total counter",
          `dva_submission_http_errors_total ${state.errors}`,
        ].join("\n") + "\n",
      );
    }
    return res.end("{}");
  })
  .listen(3000, "0.0.0.0");
process.on("SIGTERM", () => process.exit(0));
