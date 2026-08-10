/**
 * Kernel HTTP lane (Build 3): destination gating, kernel-side secret
 * dereferencing, budgets, replay protection, and trail observation.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHttpRequestBroker, type HttpRequestObservation } from "../src/http-request-broker.ts";

interface SeenRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

const SESSION_ID = "session-1";

function makeIntent(overrides?: Record<string, unknown>) {
	return {
		nonce: randomUUID(),
		sessionId: SESSION_ID,
		requestHash: "a".repeat(64),
		attended: true,
		issuedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		budget: { maxCalls: 64, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000, maxCostUsd: 100 },
		signature: "kernel-signed",
		...overrides,
	};
}

function harness(options?: { maxRequestsPerIntent?: number; fetchImpl?: typeof fetch; failResolve?: boolean }) {
	const seen: SeenRequest[] = [];
	const sent: Array<Record<string, unknown>> = [];
	const observed: HttpRequestObservation[] = [];
	const fetchImpl: typeof fetch =
		options?.fetchImpl ??
		(async (url, init) => {
			seen.push({
				url: String(url),
				method: init?.method,
				headers: init?.headers as Record<string, string>,
				body: init?.body === undefined ? undefined : String(init.body),
			});
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
	const broker = createHttpRequestBroker({
		sessionId: SESSION_ID,
		allowedDestination: (url) => url.protocol === "https:" && url.host === "api.test.example",
		resolveSecret: async (name) => {
			if (options?.failResolve || name !== "token") throw new Error(`Unknown secret reference: secret://${name}`);
			return "raw-secret-value";
		},
		observe: (event) => observed.push(event),
		fetchImpl,
		maxRequestsPerIntent: options?.maxRequestsPerIntent,
	});
	const intent = makeIntent();
	expect(broker.authorizeIntent(intent as never)).toBe(true);
	const send = (frame: object): void => {
		sent.push(frame as Record<string, unknown>);
	};
	const request = (overrides: Record<string, unknown>): Record<string, unknown> => ({
		type: "qorpera_http_request",
		requestId: randomUUID(),
		method: "POST",
		url: "https://api.test.example/v1/send?key=secret://token",
		headers: { authorization: "Bearer secret://token" },
		body: '{"note":"secret://token"}',
		intent,
		...overrides,
	});
	const settle = async (): Promise<void> => {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	};
	return { broker, send, sent, seen, observed, request, settle, intent };
}

describe("http request broker", () => {
	it("substitutes secret references kernel-side and records only the unresolved identity", async () => {
		const h = harness();
		expect(h.broker.handleFrame(h.request({}), h.send)).toBe(true);
		await h.settle();

		// The provider saw raw values...
		expect(h.seen.length).toBe(1);
		expect(h.seen[0].url).toBe("https://api.test.example/v1/send?key=raw-secret-value");
		expect(h.seen[0].headers?.authorization).toBe("Bearer raw-secret-value");
		expect(h.seen[0].body).toContain("raw-secret-value");
		// ...the child got the response...
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].status).toBe(200);
		expect(String(h.sent[0].body)).toContain("ok");
		// ...and neither the response frame nor the observation carries the value.
		expect(JSON.stringify(h.sent)).not.toContain("raw-secret-value");
		expect(JSON.stringify(h.observed)).not.toContain("raw-secret-value");
		expect(h.observed.map((event) => event.status)).toEqual(["started", "completed"]);
		expect(h.observed[0].url).toContain("secret://token");
		expect(h.observed[1].httpStatus).toBe(200);
	});

	it("denies unbound destinations with the founder lane named", async () => {
		const h = harness();
		h.broker.handleFrame(h.request({ url: "https://evil.example.net/x" }), h.send);
		await h.settle();
		expect(String(h.sent[0].error)).toContain("not a bound network destination");
		expect(h.observed[0].status).toBe("denied");
		expect(h.seen.length).toBe(0);
	});

	it("denies unresolvable secret references without contacting the destination", async () => {
		const h = harness();
		h.broker.handleFrame(h.request({ headers: { authorization: "Bearer secret://nope" } }), h.send);
		await h.settle();
		expect(String(h.sent[0].error)).toContain("secret://nope");
		expect(h.seen.length).toBe(0);
	});

	it("rejects invalid frames, replayed ids, and exhausted intent budgets", async () => {
		const h = harness({ maxRequestsPerIntent: 1 });
		h.broker.handleFrame(h.request({ method: "TRACE" }), h.send);
		await h.settle();
		expect(String(h.sent[0].error)).toContain("invalid frame");

		const requestId = randomUUID();
		h.broker.handleFrame(h.request({ requestId }), h.send);
		await h.settle();
		h.broker.handleFrame(h.request({ requestId }), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("replayed");

		h.broker.handleFrame(h.request({}), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("budget");
		// Turn end revokes the intent; a fresh kernel-authorized intent is
		// required before the lane opens again.
		h.broker.endTurn();
		h.broker.handleFrame(h.request({}), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("no verified causal intent");
		const fresh = makeIntent();
		expect(h.broker.authorizeIntent(fresh as never)).toBe(true);
		h.broker.handleFrame(h.request({ intent: fresh }), h.send);
		await h.settle();
		expect(h.sent.at(-1)?.status).toBe(200);
	});

	it("requires a kernel-registered intent: unregistered, tampered, or foreign-session intents are denied", async () => {
		const h = harness();
		h.broker.handleFrame(h.request({ intent: makeIntent() }), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("no verified causal intent");

		// A registered intent echoed back with ANY field changed is no intent.
		h.broker.handleFrame(h.request({ intent: { ...h.intent, attended: false } }), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("no verified causal intent");

		expect(h.broker.authorizeIntent(makeIntent({ sessionId: "other-session" }) as never)).toBe(false);
		expect(h.seen.length).toBe(0);
	});

	it("times out hung requests", async () => {
		const hangingFetch: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		const h = harness({ fetchImpl: hangingFetch });
		h.broker.handleFrame(h.request({ timeoutMs: 50 }), h.send);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
		expect(String(h.sent[0].error)).toContain("timed out");
		expect(h.observed.map((event) => event.status)).toEqual(["started", "failed"]);
	});

	it("ignores frames that are not http requests", () => {
		const h = harness();
		expect(h.broker.handleFrame({ type: "qorpera_model_request" }, h.send)).toBe(false);
		expect(h.broker.handleFrame("noise", h.send)).toBe(false);
	});
});
