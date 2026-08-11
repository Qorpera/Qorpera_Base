/**
 * Inbound webhook listener — the first optional kernel module.
 *
 * Local loopback only: providers reach it through whatever tunnel or
 * reverse proxy the founder chooses; Base never exposes the machine
 * itself. Authentication is the random path token minted at enable time.
 * Received events are durably persisted as kernel-authored files under
 * `<company>/inbox/events/` (agent-readable, agent-write-protected like
 * the rest of the inbox), and the caller decides whether a wake fires —
 * events that arrive mid-turn simply wait as files for the next look.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const MAX_EVENT_BYTES = 256 * 1024;

export interface WebhookListener {
	port: number;
	close: () => void;
}

export function startWebhookListener(options: {
	root: string;
	token: string;
	port?: number;
	onEvent?: (file: string) => void;
}): Promise<WebhookListener> {
	const eventsDir = join(options.root, "inbox", "events");
	return new Promise((resolveListener, rejectListener) => {
		const server: Server = createServer((request, response) => {
			if (request.method !== "POST" || request.url !== `/hook/${options.token}`) {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			let received = 0;
			request.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > MAX_EVENT_BYTES) {
					response.writeHead(413).end();
					request.destroy();
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => {
				if (received > MAX_EVENT_BYTES) return;
				try {
					mkdirSync(eventsDir, { recursive: true });
					const file = `evt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
					writeFileSync(
						join(eventsDir, file),
						`${JSON.stringify(
							{
								receivedAt: new Date().toISOString(),
								contentType: request.headers["content-type"] ?? "",
								body: Buffer.concat(chunks).toString("utf-8"),
							},
							null,
							"\t",
						)}\n`,
						"utf-8",
					);
					response.writeHead(202, { "content-type": "application/json" }).end('{"accepted":true}');
					options.onEvent?.(file);
				} catch {
					response.writeHead(500).end();
				}
			});
		});
		server.once("error", rejectListener);
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			resolveListener({
				port: (server.address() as AddressInfo).port,
				close: () => server.close(),
			});
		});
	});
}
