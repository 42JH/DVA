// Consumed Dver v2 contract. Local fixtures only; never forwards requests.
const http = require("http");
http
  .createServer((req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    // @endpoint POST /parcel
    if (req.method !== "POST" || req.url !== "/parcel")
      return json(501, { code: "UNMODELED_ENDPOINT" });
    if (req.headers["x-api-key"] !== "dver-fixture")
      return json(403, { ok: false });
    const b = req.body || {};
    if (
      !["billing", "credit", "groupBilling"].includes(b.paymentMethodType) ||
      !Number.isFinite(Date.parse(b.pickupRequestedAt)) ||
      !Array.isArray(b.outboundParcels) ||
      !b.outboundParcels.length ||
      b.outboundParcels.some(
        (p) =>
          !p.origin ||
          !p.destination ||
          !p.item ||
          !Number.isInteger(p.notifiedPrice),
      )
    )
      return json(400, { ok: false });
    if (b.outboundParcels.some((p) => p.clientComment === "reject"))
      return json(400, { ok: false });
    return json(200, {
      ok: true,
      parcelNo: "SIM02101",
      receivedAt: new Date().toISOString(),
    });
  })
  .listen(process.env.PORT || 4502);
