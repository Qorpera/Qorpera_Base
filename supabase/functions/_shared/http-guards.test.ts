import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withTimeoutScope } from "./abort-timeout.ts";
import {
	BodyTooLargeError,
	configuredSecretKeys,
	constantTimeEqual,
	constantTimeIncludes,
	createTimedFetch,
	preferredServiceKey,
	readBoundedBytes,
	readBoundedJson,
	readBoundedText,
	withAbortSignal,
} from "./http-guards.ts";

function stalledStream() {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise<void>(() => {});
		},
		cancel() {
			cancelled = true;
			return new Promise<void>(() => {});
		},
	});
	return { stream, cancelled: () => cancelled };
}

describe("withTimeoutScope", () => {
	it("aborts synchronously for non-positive or NaN timeouts", async () => {
		for (const timeoutMs of [0, -10, Number.NaN]) {
			let abortedOnEntry = false;
			let reasonName = "";
			await withTimeoutScope(timeoutMs, async (signal) => {
				abortedOnEntry = signal.aborted;
				reasonName = signal.reason instanceof Error ? signal.reason.name : "";
			});
			assert.equal(abortedOnEntry, true);
			assert.equal(reasonName, "TimeoutError");
		}
	});

	it("aborts synchronously when parent signal is already aborted", async () => {
		const parent = new AbortController();
		parent.abort(new Error("parent gone"));
		let observed: unknown;
		await withTimeoutScope(
			10_000,
			async (signal) => {
				assert.equal(signal.aborted, true);
				observed = signal.reason;
			},
			parent.signal,
		);
		assert.equal(observed instanceof Error ? observed.message : "", "parent gone");
	});
});

describe("preferredServiceKey and withAbortSignal", () => {
	it("prefers SUPABASE_SERVICE_ROLE_KEY over SUPABASE_SECRET_KEYS and falls back cleanly", () => {
		const secretMap = JSON.stringify({ primary: "sb_secret_123456789012345678901234" });
		assert.equal(
			preferredServiceKey((name) =>
				name === "SUPABASE_SERVICE_ROLE_KEY" ? "legacy-jwt-key" : name === "SUPABASE_SECRET_KEYS" ? secretMap : undefined,
			),
			"legacy-jwt-key",
		);
		assert.equal(
			preferredServiceKey((name) => (name === "SUPABASE_SECRET_KEYS" ? secretMap : undefined)),
			"sb_secret_123456789012345678901234",
		);
		assert.equal(
			preferredServiceKey((name) => (name === "SUPABASE_SECRET_KEYS" ? "{not-json" : undefined)),
			undefined,
		);
	});

	it("attaches AbortSignal when query builder supports abortSignal and passes plain promises through", async () => {
		const ac = new AbortController();
		let attached: AbortSignal | undefined;
		const builder = {
			abortSignal(signal: AbortSignal) {
				attached = signal;
				return this;
			},
			then(resolve: (value: { data: string }) => unknown) {
				return Promise.resolve({ data: attached === ac.signal ? "wired" : "missed" }).then(resolve);
			},
		};
		const wired = await withAbortSignal(builder, ac.signal);
		assert.equal(attached, ac.signal);
		assert.deepEqual(wired, { data: "wired" });

		const plain = Promise.resolve({ data: "plain" });
		assert.equal(withAbortSignal(plain, ac.signal), plain);
		assert.deepEqual(await withAbortSignal(plain, ac.signal), { data: "plain" });
	});
});

describe("readBoundedBytes / readBoundedText / readBoundedJson", () => {
	it("cancels request body immediately when content-length exceeds limit", async () => {
		const stalled = stalledStream();
		const req = new Request("https://example.test/upload", {
			method: "POST",
			headers: { "content-length": "999" },
			body: stalled.stream,
			duplex: "half",
		} as RequestInit);
		await assert.rejects(readBoundedBytes(req, 64, { sizeErrorMessage: "too big" }), (error: unknown) => {
			assert.ok(error instanceof BodyTooLargeError);
			assert.equal(error.message, "too big");
			return true;
		});
		assert.equal(stalled.cancelled(), true);
	});

	it("times out stalled request streams and cancels reader instead of returning EOF", async () => {
		const stalled = stalledStream();
		const req = new Request("https://example.test/slow", {
			method: "POST",
			body: stalled.stream,
			duplex: "half",
		} as RequestInit);
		await assert.rejects(readBoundedText(req, 1024, { timeoutMs: 15 }), (error: unknown) => {
			assert.equal(error instanceof Error ? error.name : "", "TimeoutError");
			return true;
		});
		assert.equal(stalled.cancelled(), true);
	});

	it("aborts stalled stream when caller signal fires instead of returning EOF", async () => {
		const stalled = stalledStream();
		const ac = new AbortController();
		const req = new Request("https://example.test/aborted", {
			method: "POST",
			body: stalled.stream,
			duplex: "half",
		} as RequestInit);
		setTimeout(() => ac.abort(new Error("client disconnected")), 10);
		await assert.rejects(readBoundedJson(req, 1024, { signal: ac.signal }), /client disconnected/);
		assert.equal(stalled.cancelled(), true);
	});
});

describe("createTimedFetch", () => {
	it("enforces redirect: error, response byte cap, timeout, and 204 no-body handling", async () => {
		let seenRedirect: RequestRedirect | undefined;
		const timed = createTimedFetch({
			timeoutMs: 25,
			maxResponseBytes: 32,
			fetchImplementation: async (input, init) => {
				seenRedirect = init?.redirect;
				const url = String(input);
				if (url.endsWith("/empty")) return new Response(null, { status: 204 });
				if (url.endsWith("/huge")) {
					return new Response("x".repeat(128), { status: 200 });
				}
				if (url.endsWith("/stall-body")) {
					return new Response(stalledStream().stream, { status: 200 });
				}
				return Response.json({ ok: true });
			},
		});

		const ok = await timed("https://example.test/ok");
		assert.equal(seenRedirect, "error");
		assert.deepEqual(await ok.json(), { ok: true });

		const empty = await timed("https://example.test/empty");
		assert.equal(empty.status, 204);
		assert.equal(empty.body, null);

		await assert.rejects(timed("https://example.test/huge"), BodyTooLargeError);
		await assert.rejects(timed("https://example.test/stall-body"), (error: unknown) => {
			assert.equal(error instanceof Error ? error.name : "", "TimeoutError");
			return true;
		});
	});
});

describe("constantTimeEqual, constantTimeIncludes, and configuredSecretKeys", () => {
	it("compares equal, different, and different-length secrets accurately", () => {
		assert.equal(constantTimeEqual("secret-token-123", "secret-token-123"), true);
		assert.equal(constantTimeEqual("secret-token-123", "secret-token-124"), false);
		assert.equal(constantTimeEqual("secret-token-123", "short"), false);
		assert.equal(constantTimeEqual("", ""), true);
		assert.equal(constantTimeIncludes(["alpha", "beta", "gamma"], "beta"), true);
		assert.equal(constantTimeIncludes(["alpha", "beta", "gamma"], "delta"), false);
		assert.equal(constantTimeIncludes([], "alpha"), false);
	});

	it("orders legacy service role key before KMS secret keys and deduplicates", () => {
		const secretMap = JSON.stringify({
			a: "sb_secret_123456789012345678901234",
			b: "short",
			c: "legacy-jwt-key-1234567890123456",
		});
		assert.deepEqual(
			configuredSecretKeys((name) =>
				name === "SUPABASE_SERVICE_ROLE_KEY"
					? "legacy-jwt-key-1234567890123456"
					: name === "SUPABASE_SECRET_KEYS"
						? secretMap
						: undefined,
			),
			["legacy-jwt-key-1234567890123456", "sb_secret_123456789012345678901234"],
		);
	});
});
