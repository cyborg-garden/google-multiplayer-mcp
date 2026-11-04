import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { google } from "googleapis";
import { configureGoogleClients } from "../src/broker.js";

let server: Server;
let requests = 0;
let rootUrl = "";
beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++;
    res.writeHead(503);
    res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  rootUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise((done) => server.close(done)));

describe("configureGoogleClients", () => {
  it("stops a client built earlier from retrying", async () => {
    const drive = google.drive({ version: "v3", rootUrl });
    configureGoogleClients();
    await expect(drive.files.get({ fileId: "x" })).rejects.toThrow();
    expect(requests).toBe(1);
  });
});
