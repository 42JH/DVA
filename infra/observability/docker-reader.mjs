// Alloy가 필요로 하는 Docker 조회만 중계한다. 원본 inspect의 Env/Cmd/Mounts는 전달하지 않는다.
import http from "node:http";
const project = process.env.APP_PROJECT || "dva-prod";
const services = new Set(["backend", "db", "nginx"]);
const selected = (value) =>
  value?.Labels?.["com.docker.compose.project"] === project &&
  services.has(value?.Labels?.["com.docker.compose.service"]);
const labels = (value) =>
  Object.fromEntries(
    ["com.docker.compose.project", "com.docker.compose.service"].map((key) => [
      key,
      value[key],
    ]),
  );

function request(path) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { socketPath: "/var/run/docker.sock", path, timeout: 5000 },
      (response) => {
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024)
            response.destroy(new Error("metadata too large"));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            code: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}
const reply = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

http
  .createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url, "http://docker-reader");
      const path = url.pathname.replace(/^\/v[0-9.]+(?=\/)/, "");
      if (
        !["GET", "HEAD"].includes(incoming.method) ||
        (incoming.method === "HEAD" && path !== "/_ping")
      )
        return reply(response, 403, { error: "denied" });
      if (path === "/_ping") {
        const result = await request("/_ping");
        response.writeHead(result.code, {
          "API-Version": result.headers["api-version"] || "1.44",
          "Docker-Experimental": "false",
        });
        return response.end(incoming.method === "HEAD" ? undefined : "OK");
      }
      if (path === "/version") {
        const result = JSON.parse((await request("/version")).body);
        return reply(response, 200, {
          Version: result.Version,
          ApiVersion: result.ApiVersion,
          MinAPIVersion: result.MinAPIVersion,
          Os: result.Os,
          Arch: result.Arch,
        });
      }
      if (path === "/containers/json") {
        const query = new URLSearchParams({
          filters: JSON.stringify({
            label: [`com.docker.compose.project=${project}`],
          }),
        });
        const result = JSON.parse(
          (await request("/containers/json?" + query)).body,
        );
        if (!Array.isArray(result))
          return reply(response, 503, { error: "unavailable" });
        return reply(
          response,
          200,
          result
            .filter(selected)
            .map((value) => ({
              Id: value.Id,
              Names: value.Names,
              Labels: labels(value.Labels),
              Ports: value.Ports,
              State: value.State,
              Status: value.State,
              NetworkSettings: value.NetworkSettings,
              HostConfig: { NetworkMode: value.HostConfig?.NetworkMode },
            })),
        );
      }
      if (path === "/networks") {
        const result = JSON.parse((await request("/networks")).body);
        if (!Array.isArray(result))
          return reply(response, 503, { error: "unavailable" });
        return reply(
          response,
          200,
          result.map((value) => ({
            Id: value.Id,
            Name: value.Name,
            Internal: value.Internal,
            Scope: value.Scope,
            Ingress: value.Ingress,
          })),
        );
      }
      const match = path.match(
        /^\/containers\/([a-f0-9]{12,64})\/(json|logs)$/,
      );
      if (!match) return reply(response, 403, { error: "denied" });
      const result = await request(`/containers/${match[1]}/json`);
      if (result.code !== 200)
        return reply(response, 404, { error: "not_found" });
      const value = JSON.parse(result.body);
      if (!selected({ Labels: value.Config?.Labels }))
        return reply(response, 403, { error: "denied" });
      if (match[2] === "json")
        return reply(response, 200, {
          Id: value.Id,
          Name: value.Name,
          Created: value.Created,
          Config: { Tty: value.Config.Tty === true },
          State: {
            Running: value.State.Running,
            Status: value.State.Status,
            StartedAt: value.State.StartedAt,
            FinishedAt: value.State.FinishedAt,
            ExitCode: value.State.ExitCode,
          },
          HostConfig: {
            LogConfig: { Type: value.HostConfig?.LogConfig?.Type },
          },
        });
      // 로그는 스트리밍하고 소비자 연결이 닫히면 Docker 연결도 닫는다. details에는 환경변수가 들어갈 수 있어 금지한다.
      const query = new URLSearchParams();
      for (const key of [
        "stdout",
        "stderr",
        "timestamps",
        "follow",
        "since",
        "until",
        "tail",
      ])
        if (url.searchParams.has(key))
          query.set(key, url.searchParams.get(key));
      const stream = http.get(
        {
          socketPath: "/var/run/docker.sock",
          path: `/containers/${match[1]}/logs?${query}`,
        },
        (source) => {
          response.writeHead(source.statusCode, {
            "Content-Type":
              source.headers["content-type"] ||
              "application/vnd.docker.raw-stream",
          });
          source.pipe(response);
          source.on("error", () => response.destroy());
        },
      );
      response.on("close", () => stream.destroy());
      stream.on("error", () => {
        if (!response.headersSent)
          reply(response, 503, { error: "unavailable" });
        else response.destroy();
      });
    } catch {
      if (!response.headersSent) reply(response, 503, { error: "unavailable" });
      else response.destroy();
    }
  })
  .listen(2375, "0.0.0.0");
