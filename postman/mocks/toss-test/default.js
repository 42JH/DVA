// Minimal consumed Payment fields, derived from the official Toss API reference.
// Local fixtures only. Neither real keys nor real payments are used.
const http = require("http");
// State is local to this running simulation, reset when the mock process restarts.
const payments = new Map();
http
  .createServer(async (req, res) => {
    const input = req.body || {};
    const path = new URL(req.url, "http://localhost").pathname;
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (
      req.headers.authorization !==
      "Basic " + Buffer.from("test_gsk_fixture:").toString("base64")
    )
      return json(401, { code: "UNAUTHORIZED_KEY" });
    // @endpoint POST /v1/payments/confirm
    if (req.method === "POST" && path === "/v1/payments/confirm") {
      if (
        typeof input.paymentKey !== "string" ||
        typeof input.orderId !== "string" ||
        !Number.isSafeInteger(input.amount) ||
        !req.headers["idempotency-key"]
      )
        return json(400, { code: "INVALID_REQUEST" });
      const key = "toss-test:payment:" + input.paymentKey;
      const existing = payments.get(key);
      if (existing) return json(400, { code: "ALREADY_PROCESSED_PAYMENT" });
      const payment = {
        paymentKey: input.paymentKey,
        orderId: input.orderId,
        totalAmount: input.amount,
        currency: "KRW",
        status: "DONE",
        approvedAt: "2026-10-30T01:00:00+09:00",
      };
      if (input.paymentKey.startsWith("reject_"))
        return json(403, { code: "REJECT_CARD_PAYMENT" });
      payments.set(key, payment);
      if (input.paymentKey.startsWith("uncertain_"))
        return json(500, { code: "PROVIDER_ERROR" });
      return json(200, payment);
    }
    // @endpoint GET /v1/payments/:paymentKey
    if (req.method === "GET" && path.startsWith("/v1/payments/")) {
      const result = payments.get(
        "toss-test:payment:" +
          decodeURIComponent(path.slice("/v1/payments/".length)),
      );
      return json(result ? 200 : 404, result || { code: "NOT_FOUND_PAYMENT" });
    }
    return json(501, { code: "UNMODELED_ENDPOINT" });
  })
  .listen(process.env.PORT || 4500);
