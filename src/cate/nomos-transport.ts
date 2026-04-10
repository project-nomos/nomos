/**
 * Nomos CATE transport — hooks into the daemon's existing
 * gRPC/WebSocket infrastructure for envelope delivery.
 *
 * Outbound: sends CATE envelopes via HTTP to peer endpoints.
 * Inbound: registers a route on the daemon's HTTP server
 * to receive CATE envelopes.
 */

import { CATEEnvelopeSchema, type CATEEnvelope } from "@project-nomos/cate-sdk/types";
import {
  Transport,
  type TransportOptions,
  type TransportEvents,
} from "@project-nomos/cate-sdk/transport";

export class NomosTransport extends Transport {
  private server?: { close: () => void };
  private port: number;
  private path: string;
  private _events?: TransportEvents;

  constructor(options?: { port?: number; path?: string }) {
    super();
    this.port = options?.port ?? 8801;
    this.path = options?.path ?? "/cate";
  }

  on(events: TransportEvents): void {
    this._events = events;
    super.on(events);
  }

  async listen(_options?: TransportOptions): Promise<void> {
    const { createServer } = await import("node:http");

    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== this.path) {
        res.writeHead(404);
        res.end();
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString("utf-8");
        const envelope = CATEEnvelopeSchema.parse(JSON.parse(body));

        await this._events?.onMessage(envelope);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted" }));
      } catch (err) {
        this._events?.onError(err instanceof Error ? err : new Error(String(err)));
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid envelope" }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.port, () => {
        console.log(`[cate] Transport listening on port ${this.port}`);
        resolve();
      });
    });

    this.server = server;
  }

  async send(envelope: CATEEnvelope, peerEndpoint: string): Promise<void> {
    const response = await fetch(peerEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      throw new Error(`CATE transport send failed: HTTP ${response.status} to ${peerEndpoint}`);
    }
  }

  async close(): Promise<void> {
    this.server?.close();
  }
}
