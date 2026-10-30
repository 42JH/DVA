const http = require("http");
let deliveries = 0;
http
  .createServer(async (req, res) => {
    // @endpoint POST /hooks/test
    if (req.method === "POST" && req.url === "/hooks/test") {
      if (
        typeof req.body?.text !== "string" ||
        !(
          req.body.text.includes("[결제하기](") ||
          (req.body.text.includes("결제 완료 안내") &&
            req.body.text.includes("[주문 확인]("))
        )
      ) {
        res.writeHead(400);
        return res.end("invalid text");
      }
      deliveries++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    res.writeHead(501);
    res.end("UNMODELED_ENDPOINT");
  })
  .listen(process.env.PORT || 4501);
