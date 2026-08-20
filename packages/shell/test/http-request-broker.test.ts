/**
 * Kernel HTTP lane (Build 3): destination gating, kernel-side secret
 * dereferencing, budgets, replay protection, and trail observation.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { JsonValue, KernelExecutionIdentity } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const fileRoots: string[] = [];

afterEach(() => {
	for (const dir of fileRoots.splice(0)) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

function fileRoot(): string {
	const dir = join(tmpdir(), `qorpera-http-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	fileRoots.push(dir);
	return dir;
}

function harness(options?: {
	maxRequestsPerIntent?: number;
	fetchImpl?: typeof fetch;
	failResolve?: boolean;
	root?: string;
	maxSaveBytes?: number;
	execution?: KernelExecutionIdentity;
	requireDurableExecution?: boolean;
	beginReceipt?: Parameters<typeof createHttpRequestBroker>[0]["beginReceipt"];
	completeReceipt?: Parameters<typeof createHttpRequestBroker>[0]["completeReceipt"];
	syncOutput?: Parameters<typeof createHttpRequestBroker>[0]["syncOutput"];
}) {
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
	const root = options?.root ?? fileRoot();
	const resolveCompanyPath = (relativePath: string, mode: "read" | "write"): string => {
		const target = resolve(root, relativePath);
		const rootRelative = relative(root, target);
		if (!rootRelative || rootRelative.startsWith("..")) throw new Error(`${mode} path escapes the company folder`);
		if (mode === "write" && rootRelative.split(/[\\/]/)[0] === "trail") {
			throw new Error("saveTo cannot write into kernel-protected territory");
		}
		return target;
	};
	const broker = createHttpRequestBroker({
		sessionId: SESSION_ID,
		allowedDestination: (url) => url.protocol === "https:" && url.host === "api.test.example",
		resolveSecret: async (name) => {
			if (options?.failResolve || name !== "token") throw new Error(`Unknown secret reference: secret://${name}`);
			return "raw-secret-value";
		},
		companyFile: {
			resolveForWrite: (relativePath) => resolveCompanyPath(relativePath, "write"),
			resolveForRead: (relativePath) => resolveCompanyPath(relativePath, "read"),
		},
		observe: (event) => observed.push(event),
		fetchImpl,
		maxRequestsPerIntent: options?.maxRequestsPerIntent,
		maxSaveBytes: options?.maxSaveBytes,
		requireDurableExecution: options?.requireDurableExecution,
		execution: () => options?.execution,
		beginReceipt: options?.beginReceipt,
		completeReceipt: options?.completeReceipt,
		syncOutput: options?.syncOutput,
	});
	const intent = makeIntent(options?.execution ? { execution: options.execution } : undefined);
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
	return { broker, send, sent, seen, observed, request, settle, intent, root };
}

describe("http request broker", () => {
	it("fails closed when a cloud execution has no durable lease", async () => {
		const h = harness({ requireDurableExecution: true });
		h.broker.handleFrame(h.request({}), h.send);
		await h.settle();
		expect(String(h.sent[0].error)).toContain("no durable lease");
		expect(h.seen).toHaveLength(0);
	});

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

	it("replays a completed durable receipt without repeating the HTTP effect", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "turn",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		const fetchImpl = vi.fn<typeof fetch>();
		const h = harness({
			execution,
			fetchImpl,
			beginReceipt: async () => ({
				started: false,
				status: "completed",
				result: { status: 202, headers: {}, body: "already sent", bodyBytes: 12 },
			}),
			completeReceipt: async (_live, _operationId, result) => result,
		});
		h.broker.handleFrame(h.request({}), h.send);
		await h.settle();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(h.sent[0]).toMatchObject({ status: 202, body: "already sent" });
	});

	it("bounds response headers before persisting a durable operation result", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "wake",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		let completed: unknown;
		const h = harness({
			execution,
			fetchImpl: async () => new Response("ok", { headers: { "x-large": "a".repeat(40 * 1024) } }),
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt: async (_live, _operationId, result) => {
				completed = result;
				return result;
			},
		});
		h.broker.handleFrame(h.request({}), h.send);
		await vi.waitFor(() => expect(h.sent).toHaveLength(1));
		expect(completed).toMatchObject({ headers: { "x-qorpera-headers-truncated": "true" } });
		expect(Buffer.byteLength(JSON.stringify(completed), "utf-8")).toBeLessThan(512 * 1024);
	});

	it("supplies the durable operation id as the downstream idempotency key", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "turn",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		const h = harness({
			execution,
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt: async (_live, _operationId, result) => result,
		});
		h.broker.handleFrame(h.request({}), h.send);
		await vi.waitFor(() => expect(h.sent).toHaveLength(1));
		expect(h.seen[0].headers?.["Idempotency-Key"]).toBe(h.sent[0].requestId);
	});

	it("retries durable acknowledgement without repeating the HTTP request", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "wake",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		const fetchImpl = vi.fn(async () => new Response("ok"));
		const completeReceipt = vi
			.fn(async (_live: KernelExecutionIdentity, _operationId: string, result: JsonValue) => result)
			.mockRejectedValueOnce(new Error("network response lost"))
			.mockRejectedValueOnce(new Error("network unavailable"));
		const h = harness({
			execution,
			fetchImpl,
			beginReceipt: async () => ({ started: true, status: "executing" }),
			completeReceipt,
		});
		h.broker.handleFrame(h.request({}), h.send);
		await vi.waitFor(() => expect(h.sent).toHaveLength(1));
		expect(h.sent[0].status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(completeReceipt).toHaveBeenCalledTimes(3);
	});

	it("ignores frames that are not http requests", () => {
		const h = harness();
		expect(h.broker.handleFrame({ type: "qorpera_model_request" }, h.send)).toBe(false);
		expect(h.broker.handleFrame("noise", h.send)).toBe(false);
	});
});

describe("file mode (fetch-to-file / upload-from-file)", () => {
	const BINARY = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a, 0x42, 0x69, 0x6e, 0x00]);

	it("streams a 2xx response to a company file, returning only metadata", async () => {
		const binaryFetch: typeof fetch = async () =>
			new Response(new Uint8Array(BINARY), { status: 200, headers: { "content-type": "application/pdf" } });
		const h = harness({ fetchImpl: binaryFetch });
		h.broker.handleFrame(h.request({ method: "GET", body: undefined, saveTo: "imports/statement.pdf" }), h.send);
		const savedPath = join(h.root, "imports", "statement.pdf");
		await vi.waitFor(() => expect(existsSync(savedPath)).toBe(true));

		const saved = readFileSync(savedPath);
		expect(Buffer.compare(saved, BINARY)).toBe(0);
		expect(h.sent[0].status).toBe(200);
		expect(h.sent[0].body).toBe("");
		expect(h.sent[0].bodyBytes).toBe(BINARY.length);
		expect(h.sent[0].savedTo).toBe("imports/statement.pdf");
		expect(h.sent[0].sha256).toBe(createHash("sha256").update(BINARY).digest("hex"));
		expect(h.observed.at(-1)).toMatchObject({ status: "completed", savedTo: "imports/statement.pdf" });
	});

	it("stages the exact durable file output before completing its operation receipt", async () => {
		const execution: KernelExecutionIdentity = {
			kind: "turn",
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			claimantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		};
		const order: string[] = [];
		const h = harness({
			execution,
			fetchImpl: async () => new Response(new Uint8Array(BINARY), { status: 200 }),
			beginReceipt: async () => ({ started: true, status: "executing" }),
			syncOutput: async (output) => {
				order.push(`staged:${output.relativePath}:${output.bytes}`);
				return {
					cloudManifestSha256: "a".repeat(64),
					cloudObjects: [{ sha256: "b".repeat(64), bytes: output.bytes }],
				};
			},
			completeReceipt: async (_live, _operationId, result) => {
				order.push("receipt-completed");
				return result;
			},
		});
		h.broker.handleFrame(
			h.request({ method: "GET", body: undefined, saveTo: "imports/durable-statement.pdf" }),
			h.send,
		);
		await vi.waitFor(() => expect(h.sent).toHaveLength(1));
		expect(order).toEqual([`staged:imports/durable-statement.pdf:${BINARY.length}`, "receipt-completed"]);
	});

	it("denies protected and escaping save paths before any network contact", async () => {
		const h = harness();
		h.broker.handleFrame(h.request({ method: "GET", body: undefined, saveTo: "trail/evil.jsonl" }), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("protected");
		h.broker.handleFrame(h.request({ method: "GET", body: undefined, saveTo: "../outside.bin" }), h.send);
		await h.settle();
		expect(String(h.sent.at(-1)?.error)).toContain("escapes");
		expect(h.seen.length).toBe(0);
	});

	it("aborts saves that exceed the byte limit and leaves no partial file", async () => {
		const bigFetch: typeof fetch = async () => new Response(new Uint8Array(Buffer.alloc(64, 0x41)), { status: 200 });
		const h = harness({ fetchImpl: bigFetch, maxSaveBytes: 16 });
		h.broker.handleFrame(h.request({ method: "GET", body: undefined, saveTo: "imports/too-big.bin" }), h.send);
		await vi.waitFor(() => expect(h.sent[0]).toBeDefined());
		expect(String(h.sent[0].error)).toContain("save limit");
		expect(existsSync(join(h.root, "imports", "too-big.bin"))).toBe(false);
	});

	it("returns non-2xx responses inline instead of saving them", async () => {
		const failFetch: typeof fetch = async () => new Response("not found", { status: 404 });
		const h = harness({ fetchImpl: failFetch });
		h.broker.handleFrame(h.request({ method: "GET", body: undefined, saveTo: "imports/missing.bin" }), h.send);
		await h.settle();
		expect(h.sent[0].status).toBe(404);
		expect(h.sent[0].body).toBe("not found");
		expect(h.sent[0].savedTo).toBeUndefined();
		expect(existsSync(join(h.root, "imports", "missing.bin"))).toBe(false);
	});

	it("rejects sendFile on body-less methods instead of silently dropping the upload", async () => {
		const h = harness();
		mkdirSync(join(h.root, "exports"), { recursive: true });
		writeFileSync(join(h.root, "exports", "report.bin"), BINARY);
		h.broker.handleFrame(h.request({ method: "GET", body: undefined, sendFile: "exports/report.bin" }), h.send);
		await h.settle();
		expect(h.sent[0].error).toBeDefined();
		expect(h.seen.length).toBe(0);
	});

	it("streams a company file out as the request body", async () => {
		const received: Buffer[] = [];
		const uploadFetch: typeof fetch = async (_url, init) => {
			if (init?.body) {
				received.push(Buffer.from(await new Response(init.body as NonNullable<RequestInit["body"]>).arrayBuffer()));
			}
			return new Response(JSON.stringify({ uploaded: true }), { status: 201 });
		};
		const h = harness({ fetchImpl: uploadFetch });
		mkdirSync(join(h.root, "exports"), { recursive: true });
		const source = join(h.root, "exports", "report.bin");
		writeFileSync(source, BINARY);
		h.broker.handleFrame(h.request({ method: "PUT", body: undefined, sendFile: "exports/report.bin" }), h.send);
		await h.settle();
		expect(received.length).toBe(1);
		expect(Buffer.compare(received[0], BINARY)).toBe(0);
		expect(h.sent[0].status).toBe(201);
	});
});
