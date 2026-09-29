import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	base64,
	handleEventIntake,
	type IntakeStore,
	IntakeStoreError,
	KEPT_HEADERS,
	keptHeaders,
	MAX_BODY_BYTES,
} from "./event-intake.ts";

const ADDRESS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456";
const URL_BASE = "https://project.example.test/functions/v1/event-intake";

type Json = Record<string, unknown>;
interface Call {
	address: string;
	contentType: string | null;
	headers: Record<string, string>;
	bodyBase64: string;
}

function store(answer: Json | Error = { outcome: "accepted", deliveryId: "d1" }): { store: IntakeStore; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		store: {
			async receive(address, contentType, headers, bodyBase64) {
				calls.push({ address, contentType, headers, bodyBase64 });
				if (answer instanceof Error) throw answer;
				return answer;
			},
		},
	};
}

function post(body: BodyInit | null, headers: Record<string, string> = {}, path = `/${ADDRESS}`): Request {
	return new Request(`${URL_BASE}${path}`, { method: "POST", body, headers });
}

describe("event intake", () => {
	it("keeps exactly the headers the database keeps", () => {
		// The newest migration that defines the database's list.
		const migrations = new URL("../../migrations/", import.meta.url);
		const definition = /function public\.qorpera_event_kept_headers\(\)[\s\S]*?select array\[([\s\S]*?)\]/;
		const latest = readdirSync(migrations)
			.filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
			.sort()
			.map((name) => readFileSync(new URL(name, migrations), "utf-8"))
			.filter((text) => definition.test(text))
			.at(-1);
		assert.ok(latest, "no migration defines the header list");
		const list = definition.exec(latest);
		assert.ok(list, "the migration's header list was not found");
		const sqlHeaders = [...list[1].matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
		assert.deepEqual([...KEPT_HEADERS].sort(), sqlHeaders.sort());
	});

	it("hands an accepted delivery to the database with only the kept headers", async () => {
		const fixture = store();
		const response = await handleEventIntake(
			post('{"name":"Ada"}', {
				"content-type": "application/json",
				"X-Qorpera-Delivery": "form-1",
				authorization: "Bearer secret",
				cookie: "session=1",
				"x-forwarded-for": "203.0.113.1",
			}),
			fixture.store,
		);
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { received: true });
		assert.equal(fixture.calls.length, 1);
		assert.deepEqual(fixture.calls[0], {
			address: ADDRESS,
			contentType: "application/json",
			headers: { "content-type": "application/json", "x-qorpera-delivery": "form-1" },
			bodyBase64: Buffer.from('{"name":"Ada"}').toString("base64"),
		});
	});

	it("answers each outcome with its status", async () => {
		const expected: [string, number][] = [
			["duplicate", 200],
			["unknown", 404],
			["paused", 409],
			["not_ready", 409],
			["too_large", 413],
			["limited", 429],
			["unavailable", 503],
		];
		for (const [outcome, status] of expected) {
			const response = await handleEventIntake(post("x"), store({ outcome }).store);
			assert.equal(response.status, status, outcome);
			if (outcome === "unavailable") assert.equal(response.headers.get("retry-after"), "300");
			if (outcome === "duplicate") assert.deepEqual(await response.json(), { received: true, duplicate: true });
		}
		// The database says how long a limited sender should wait.
		const limited = await handleEventIntake(post("x"), store({ outcome: "limited", retryAfterSeconds: 600 }).store);
		assert.equal(limited.headers.get("retry-after"), "600");
	});

	it("refuses other paths and methods without touching the database", async () => {
		const fixture = store();
		const short = await handleEventIntake(post("x", {}, "/short"), fixture.store);
		assert.equal(short.status, 404);
		assert.deepEqual(await short.json(), { error: "This is not a hook address" });
		assert.equal((await handleEventIntake(post("x", {}, `/${ADDRESS}/more`), fixture.store)).status, 404);
		const get = await handleEventIntake(new Request(`${URL_BASE}/${ADDRESS}`), fixture.store);
		assert.equal(get.status, 405);
		assert.equal(get.headers.get("allow"), "POST");
		assert.equal(fixture.calls.length, 0);
		// The platform may route without the /functions/v1 prefix; a trailing slash is fine.
		const bare = await handleEventIntake(new Request(`https://edge.example.test/event-intake/${ADDRESS}/`, { method: "POST", body: "x" }), fixture.store);
		assert.equal(bare.status, 202);
	});

	it("refuses a body over 256 KiB before and while reading it", async () => {
		const fixture = store();
		const declared = await handleEventIntake(
			post("small", { "content-length": String(MAX_BODY_BYTES + 1) }),
			fixture.store,
		);
		assert.equal(declared.status, 413);
		const streamed = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
				controller.enqueue(new Uint8Array(1));
				controller.close();
			},
		});
		const read = await handleEventIntake(
			new Request(`${URL_BASE}/${ADDRESS}`, { method: "POST", body: streamed, duplex: "half" } as RequestInit),
			fixture.store,
		);
		assert.equal(read.status, 413);
		assert.equal(fixture.calls.length, 0);
		const exact = await handleEventIntake(post(new Uint8Array(MAX_BODY_BYTES)), fixture.store);
		assert.equal(exact.status, 202);
		assert.equal(Buffer.from(fixture.calls[0]?.bodyBase64 ?? "", "base64").length, MAX_BODY_BYTES);
	});

	it("passes binary and empty bodies through unchanged", async () => {
		const fixture = store();
		const bytes = new Uint8Array(70_000).map((_, index) => index % 256);
		assert.ok(bytes.length < MAX_BODY_BYTES);
		await handleEventIntake(post(bytes), fixture.store);
		await handleEventIntake(post(null), fixture.store);
		assert.deepEqual(Buffer.from(fixture.calls[0]?.bodyBase64 ?? "", "base64"), Buffer.from(bytes));
		assert.equal(fixture.calls[1]?.bodyBase64, "");
		assert.equal(base64(new Uint8Array([0xff, 0x00, 0x10])), "/wAQ");
	});

	it("refuses kept headers over 8000 bytes", async () => {
		const fixture = store();
		const big = "é".repeat(1000);
		const response = await handleEventIntake(
			post("x", { "stripe-signature": big, "svix-signature": big, "webhook-signature": big, "x-hub-signature-256": big }),
			fixture.store,
		);
		assert.equal(response.status, 431);
		assert.equal(fixture.calls.length, 0);
	});

	it("drops header values over 2048 characters and long content types", async () => {
		const headers = new Headers({ "stripe-signature": "x".repeat(2049), "x-github-event": "push" });
		assert.deepEqual(keptHeaders(headers), { "x-github-event": "push" });
		const fixture = store();
		await handleEventIntake(post("x", { "content-type": `text/plain;${"a".repeat(300)}` }), fixture.store);
		assert.equal(fixture.calls[0]?.contentType, null);
	});

	it("answers 400 for input the database calls malformed and 503 for anything else", async () => {
		assert.equal((await handleEventIntake(post("x"), store(new IntakeStoreError("22023", "bad")).store)).status, 400);
		assert.equal((await handleEventIntake(post("x"), store(new IntakeStoreError("08006", "down")).store)).status, 503);
		assert.equal((await handleEventIntake(post("x"), store(new Error("network")).store)).status, 503);
		assert.equal((await handleEventIntake(post("x"), store({ outcome: "surprise" }).store)).status, 503);
	});
});
