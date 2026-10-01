import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHATGPT_PLAN_CONFIRM_TIMEOUT_MS, forwardNativeProviderLogin } from "./native-provider-login.ts";

const capability = "a".repeat(43);

function streamedRequest(
	body: ReadableStream<Uint8Array>,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
): Request {
	const init: RequestInit & { duplex: "half" } = {
		method: "POST",
		duplex: "half",
		body,
		signal,
		headers: { authorization: `Bearer ${capability}`, origin: "https://app.qorpera.com", ...headers },
	};
	return new Request("https://example.test/login", init);
}

function byteStream(total: number, chunkBytes = 8192, pendingCancel = false) {
	let produced = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (produced === total) return controller.close();
				const bytes = new Uint8Array(Math.min(chunkBytes, total - produced)).fill(65);
				produced += bytes.length;
				controller.enqueue(bytes);
			},
			cancel() {
				cancelled = true;
				if (pendingCancel) return new Promise<void>(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, produced: () => produced, cancelled: () => cancelled };
}

describe("native login bounded streaming", () => {
	for (const [label, headers] of Object.entries({
		undeclared: {},
		chunked: { "transfer-encoding": "chunked" },
		understated: { "content-length": "1" },
		declared: { "content-length": "1048576" },
	})) {
		for (const side of ["request", "response"] as const) {
			it(`cancels ${label} oversized ${side} before draining it`, async () => {
				const stream = byteStream(1024 * 1024, 8192, true);
				let calls = 0;
				const response = await forwardNativeProviderLogin(
					side === "request" ? streamedRequest(stream.body, headers) : streamedRequest(byteStream(2).body),
					{
						upstreamUrl: "https://private.example/",
						fetchImplementation: async () => {
							calls++;
							return new Response(stream.body, { headers });
						},
					},
				);
				assert.equal(response.status, side === "request" ? 413 : 502);
				assert.equal(stream.cancelled(), true);
				assert.ok(stream.produced() <= 65536 + 8192);
				if (label === "declared") assert.equal(stream.produced(), 0);
				assert.equal(calls, side === "request" ? 0 : 1);
				assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
				assert.equal(response.headers.get("cache-control"), "no-store");
				assert.ok((await response.text()).length < 100);
			});
		}
	}
	it("forwards both exact byte limits without truncation or cancellation", async () => {
		const request = byteStream(65536, 3);
		const upstream = byteStream(65536, 7);
		const result = await forwardNativeProviderLogin(streamedRequest(request.body), {
			upstreamUrl: "https://private.example/",
			fetchImplementation: async (_input, init) => {
				assert.deepEqual(new Uint8Array(init?.body as ArrayBuffer), new Uint8Array(65536).fill(65));
				return new Response(upstream.body, { status: 409 });
			},
		});
		assert.equal(result.status, 409);
		assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array(65536).fill(65));
		assert.equal(request.cancelled(), false);
		assert.equal(upstream.cancelled(), false);
	});
	for (const side of ["request", "response"] as const) {
		it(`cancels an interrupted pending ${side} without waiting for cancellation`, async () => {
			const abort = new AbortController();
			let cancelled = false;
			let calls = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					pull() {
						queueMicrotask(() => abort.abort(new Error("private diagnostic")));
						return new Promise<void>(() => {});
					},
					cancel() {
						cancelled = true;
						return new Promise<void>(() => {});
					},
				},
				{ highWaterMark: 0 },
			);
			const response = await forwardNativeProviderLogin(
				streamedRequest(side === "request" ? body : byteStream(2).body, {}, abort.signal),
				{
					upstreamUrl: "https://private.example/",
					fetchImplementation: async () => {
						calls++;
						return new Response(body);
					},
				},
			);
			assert.equal(response.status, side === "request" ? 400 : 503);
			assert.equal(cancelled, true);
			assert.equal(calls, side === "request" ? 0 : 1);
			assert.doesNotMatch(await response.text(), /private diagnostic/);
		});
	}
	it("applies the upstream deadline to a response body that stalls after headers", async () => {
		let cancelled = false;
		const keepAlive = setTimeout(() => {}, 1000);
		try {
			const response = await forwardNativeProviderLogin(streamedRequest(byteStream(2).body), {
				upstreamUrl: "https://private.example/",
				timeoutMs: 10,
				fetchImplementation: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull() {
								return new Promise<void>(() => {});
							},
							cancel() {
								cancelled = true;
							},
						}),
					),
			});
			assert.equal(response.status, 503);
			assert.equal(cancelled, true);
		} finally {
			clearTimeout(keepAlive);
		}
	});
});

describe("native provider login proxy", () => {
	it("routes refresh capabilities to the separate maintenance route and chooser", async () => {
		let purpose: string | undefined;
		const result = await forwardNativeProviderLogin(new Request("https://edge.example/native-provider-login/account-refresh", {
			method: "POST", headers: { authorization: `Bearer ${capability}` }, body: '{"schema":"qorpera.native-account-refresh/v1"}',
		}), {
			upstreamResolver: async (_hash, kind) => { purpose = kind; return "https://node.example/"; },
			fetchImplementation: async (input, init) => {
				assert.equal(String(input), "https://node.example/account-refresh");
				assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${capability}`);
				return Response.json({ status: "completed" });
			},
		});
		assert.equal(result.status, 200);
		assert.equal(purpose, "account_refresh");
	});
	it("routes a ChatGPT plan confirmation to the sign-in's own gateway, the company's vault", async () => {
		let purpose: string | undefined = "unset";
		const vault = "https://vault.example/v1/model-logins/3d2c6a1e-7b4f-4c55-9a1e-2f6b8c9d0e1f/";
		const result = await forwardNativeProviderLogin(new Request("https://edge.example/native-provider-login/chatgpt-plan-confirm", {
			method: "POST", headers: { authorization: `Bearer ${capability}` }, body: '{"schema":"qorpera.chatgpt-plan-confirm/v1"}',
		}), {
			upstreamResolver: async (_hash, kind) => { purpose = kind; return vault; },
			fetchImplementation: async (input, init) => {
				assert.equal(String(input), `${vault}chatgpt-plan/confirm`);
				assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${capability}`);
				return Response.json({ status: "completed" });
			},
		});
		assert.equal(result.status, 200);
		assert.equal(purpose, undefined);
		// The vault's confirm route answers within 30 s, after a gateway lookup of at most 5 s; this hop waits
		// longer, and the web client (45 s) longer still.
		assert.ok(CHATGPT_PLAN_CONFIRM_TIMEOUT_MS >= 30_000 + 5_000 && CHATGPT_PLAN_CONFIRM_TIMEOUT_MS < 45_000);
	});
	it("forwards only the opaque login envelope and its one-time capability", async () => {
		let forwardedBody = "";
		const response = await forwardNativeProviderLogin(
			new Request("https://project.example/functions/v1/native-provider-login/login", {
				method: "POST",
				headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
				body: '{"schema":"qorpera.native-provider-login/v1","login_id":"opaque"}',
			}),
			{
				upstreamUrl: "https://native-compute.example/",
				fetchImplementation: async (input, init) => {
					assert.equal(String(input), "https://native-compute.example/login");
					assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${capability}`);
					forwardedBody = new TextDecoder().decode(init?.body as ArrayBuffer);
					return Response.json({
						schema: "qorpera.native-provider-login-result/v1",
						status: "awaiting_member",
					});
				},
			},
		);
		assert.equal(response.status, 200);
		assert.match(forwardedBody, /native-provider-login\/v1/);
		assert.doesNotMatch(forwardedBody, /access[_-]?token|refresh[_-]?token|oauth[_-]?token/i);
		assert.equal(response.headers.get("cache-control"), "no-store");
	});

	it("fails closed without a valid capability or a reachable configured upstream", async () => {
		const missing = await forwardNativeProviderLogin(
			new Request("https://project.example/functions/v1/native-provider-login/login", {
				method: "POST",
				body: "{}",
			}),
			{ upstreamUrl: "https://native-compute.example/" },
		);
		assert.equal(missing.status, 400);

		const unavailable = await forwardNativeProviderLogin(
			new Request("https://project.example/functions/v1/native-provider-login/login", {
				method: "POST",
				headers: { authorization: `Bearer ${capability}` },
				body: "{}",
			}),
			{
				upstreamUrl: "http://untrusted.example/",
				fetchImplementation: async () => {
					throw new Error("must not be called");
				},
			},
		);
		assert.equal(unavailable.status, 503);
	});

	it("rejects a non-HTTP loopback URL without contacting it", async () => {
		let called = false;
		const response = await forwardNativeProviderLogin(
			new Request("https://project.example/functions/v1/native-provider-login/login", {
				method: "POST",
				headers: { authorization: `Bearer ${capability}` },
				body: "{}",
			}),
			{
				upstreamUrl: "file://localhost/private",
				fetchImplementation: async () => {
					called = true;
					throw new Error("must not be called");
				},
			},
		);
		assert.equal(response.status, 503);
		assert.equal(called, false);
	});
});

describe("native provider browser origin policy", () => {
	it("accepts exact app preflight without credentials or an upstream", async () => {
		const response = await forwardNativeProviderLogin(
			new Request("https://example.test/login", {
				method: "OPTIONS",
				headers: {
					origin: "https://app.qorpera.com",
					"access-control-request-method": "POST",
					"access-control-request-headers": "authorization, content-type",
				},
			}),
			{},
		);
		assert.equal(response.status, 204);
		assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
		assert.equal(response.headers.get("access-control-allow-credentials"), null);
		assert.match(response.headers.get("vary") ?? "", /Origin/);
	});
	it("refuses hostile, null and suffix origins before upstream dispatch", async () => {
		for (const origin of [
			"https://evil.example",
			"null",
			"https://app.qorpera.com.evil.example",
			"http://app.qorpera.com",
		]) {
			const response = await forwardNativeProviderLogin(
				new Request("https://example.test/login", {
					method: "POST",
					headers: { origin, authorization: `Bearer ${capability}` },
					body: "{}",
				}),
				{
					upstreamUrl: "https://private.example/",
					fetchImplementation: async () => {
						throw new Error("must not dispatch");
					},
				},
			);
			assert.equal(response.status, 403);
			assert.equal(response.headers.get("access-control-allow-origin"), null);
		}
	});
	it("refuses other methods and request headers in preflight", async () => {
		for (const [method, headers] of [
			["DELETE", "authorization"],
			["POST", "authorization,x-service-secret"],
		]) {
			const response = await forwardNativeProviderLogin(
				new Request("https://example.test/login", {
					method: "OPTIONS",
					headers: {
						origin: "https://app.qorpera.com",
						"access-control-request-method": method,
						"access-control-request-headers": headers,
					},
				}),
				{},
			);
			assert.equal(response.status, 403);
		}
	});
	it("keeps success, capability refusal and unavailable responses browser readable", async () => {
		for (const status of [200, 400, 503]) {
			const response = await forwardNativeProviderLogin(
				new Request("https://example.test/login", {
					method: "POST",
					headers: {
						origin: "https://app.qorpera.com",
						...(status === 400 ? {} : { authorization: `Bearer ${capability}` }),
					},
					body: "{}",
				}),
				{
					upstreamUrl: status === 503 ? undefined : "https://private.example/",
					fetchImplementation: async () => Response.json({ status: "awaiting_member" }),
				},
			);
			assert.equal(response.status, status);
			assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
	});
});

describe("login gateway resolver", () => {
	it("uses the chosen gateway and falls back to the configured upstream", async () => {
	const targets: string[] = [];
	const fetchImplementation = async (input: string | URL | Request) => {
		targets.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return Response.json({ status: "awaiting_member" });
	};
	const request = () =>
		new Request("https://edge.example/native-provider-login", {
			method: "POST",
			headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" },
			body: "{}",
		});
	const digests: string[] = [];
	await forwardNativeProviderLogin(request(), {
		upstreamUrl: "https://node-a.example:10000/",
		upstreamResolver: async (capabilitySha256) => {
			digests.push(capabilitySha256);
			return "https://node-b.example:10000/";
		},
		fetchImplementation,
	});
	// The resolver receives only the digest of the login capability (never the capability), so the backend can prefer the identity's home node.
	assert.deepEqual(digests, [
		Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("a".repeat(43)))), (b) => b.toString(16).padStart(2, "0")).join(""),
	]);
	await forwardNativeProviderLogin(request(), {
		upstreamUrl: "https://node-a.example:10000/",
		upstreamResolver: async () => undefined,
		fetchImplementation,
	});
	await forwardNativeProviderLogin(request(), {
		upstreamUrl: "https://node-a.example:10000/",
		upstreamResolver: async () => {
			throw new Error("backend unavailable");
		},
		fetchImplementation,
	});
	await forwardNativeProviderLogin(request(), {
		upstreamUrl: "https://node-a.example:10000/",
		upstreamResolver: async () => "http://untrusted.example/",
		fetchImplementation,
	});
	assert.deepEqual(targets, [
		"https://node-b.example:10000/login",
		"https://node-a.example:10000/login",
		"https://node-a.example:10000/login",
		"https://node-a.example:10000/login",
	]);
	});
});
