import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestMediaServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; range?: string }>;
}

export async function startTestMediaServer(
  body: Buffer = Buffer.from("test-media"),
  options: { contentType?: string; status?: number } = {},
): Promise<TestMediaServer> {
  const requests: TestMediaServer["requests"] = [];
  const server: Server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      ...(request.headers.range ? { range: request.headers.range } : {}),
    });
    const status = options.status ?? 200;
    if (status !== 200) {
      response.writeHead(status, { "Content-Type": "text/plain" });
      response.end("error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": options.contentType ?? "video/mp4",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/video.mp4`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
