/**
 * Inbound webhook listener (optional kernel module): token-authed local
 * loopback, durable event files, size cap.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startWebhookListener, type WebhookListener } from "../src/webhook-listener.ts";

let root: string;
let listener: WebhookListener | undefined;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-webhook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "inbox"), { recursive: true });
});

afterEach(() => {
	listener?.close();
	listener = undefined;
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("webhook listener", () => {
	it("persists token-authed events as durable inbox files and notifies", async () => {
		const events: string[] = [];
		listener = await startWebhookListener({ root, token: "tok-1", onEvent: (file) => events.push(file) });

		const accepted = await fetch(`http://127.0.0.1:${listener.port}/hook/tok-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "payment.settled", amount: 42 }),
		});
		expect(accepted.status).toBe(202);
		expect(events.length).toBe(1);
		const files = readdirSync(join(root, "inbox", "events"));
		expect(files).toEqual([events[0]]);
		const event = JSON.parse(readFileSync(join(root, "inbox", "events", files[0]), "utf-8"));
		expect(event.contentType).toBe("application/json");
		expect(JSON.parse(event.body).kind).toBe("payment.settled");
	});

	it("rejects wrong tokens and non-POSTs without writing anything", async () => {
		listener = await startWebhookListener({ root, token: "tok-1" });
		expect((await fetch(`http://127.0.0.1:${listener.port}/hook/wrong`, { method: "POST", body: "x" })).status).toBe(
			404,
		);
		expect((await fetch(`http://127.0.0.1:${listener.port}/hook/tok-1`)).status).toBe(404);
		expect(existsSync(join(root, "inbox", "events"))).toBe(false);
	});

	it("caps event size", async () => {
		listener = await startWebhookListener({ root, token: "tok-1" });
		const response = await fetch(`http://127.0.0.1:${listener.port}/hook/tok-1`, {
			method: "POST",
			body: "x".repeat(300 * 1024),
		}).catch(() => ({ status: 413 }));
		expect(response.status).toBe(413);
		expect(existsSync(join(root, "inbox", "events"))).toBe(false);
	});
});
