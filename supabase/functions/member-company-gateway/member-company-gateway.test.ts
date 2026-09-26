import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardMemberCompanyGateway } from "./member-company-gateway.ts";

const id = "11111111-1111-4111-8111-111111111111";
const object = `/v1/member-company-objects/${id}/${id}/${"a".repeat(64)}`;
const edits = `/v1/member-company-file/${id}/edits`;
const upstreamUrl = "https://node.tailnet.ts.net:10000";
const base = "https://project.supabase.co/functions/v1/member-company-gateway";
function request(path = object, init: RequestInit = {}) {
	return new Request(base + path, {
		...init,
		headers: {
			origin: "https://app.qorpera.com",
			authorization: "Bearer member.jwt.token",
			"x-qorpera-company-path": "bm90ZXMudHh0",
			...Object.fromEntries(new Headers(init.headers)),
		},
	});
}

describe("public member Company File gateway", () => {
	it("keeps concurrent tiny replies small while assembling their streamed bytes", async () => {
		const original = globalThis.Uint8Array;
		const allocations: number[] = [];
		const requests = Array.from({ length: 8 }, () => request());
		globalThis.Uint8Array = new Proxy(original, {
			construct(target, args, newTarget) {
				if (typeof args[0] === "number") allocations.push(args[0]);
				return Reflect.construct(target, args, newTarget);
			},
		});
		try {
			const replies = await Promise.all(
				requests.map((req) =>
					forwardMemberCompanyGateway(req, {
						upstreamUrl,
						fetchImplementation: async () => {
							let next = 0;
							return new Response(
								new ReadableStream<Uint8Array>({
									pull(controller) {
										if (next === 17) controller.close();
										else controller.enqueue(new Uint8Array([next++]));
									},
								}),
							);
						},
					}),
				),
			);
			for (const reply of replies)
				assert.deepEqual(
					new Uint8Array(await reply.arrayBuffer()),
					Uint8Array.from({ length: 17 }, (_, index) => index),
				);
			assert.ok(allocations.length > 0);
			assert.ok(
				allocations.every((size) => size < 1024 * 1024),
				`Tiny responses reserved large buffers: ${allocations}`,
			);
		} finally {
			globalThis.Uint8Array = original;
		}
	});
	it("serves authorized verified object bytes without exposing the private origin to the browser", async () => {
		let calls = 0;
		const response = await forwardMemberCompanyGateway(
			request(object, { headers: { cookie: "secret", apikey: "ignore", "x-forged-authority": "owner" } }),
			{
				upstreamUrl,
				fetchImplementation: async (url, init) => {
					calls++;
					assert.equal(String(url), upstreamUrl + object);
					assert.equal(init?.redirect, "error");
					assert.equal(init?.credentials, "omit");
					assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
						authorization: "Bearer member.jwt.token",
						"x-qorpera-company-path": "bm90ZXMudHh0",
					});
					return new Response(new Uint8Array([0, 1, 255]), {
						headers: {
							"content-type": "application/octet-stream",
							"x-qorpera-access-mode": "live-path-authority",
							"set-cookie": "drop",
							location: "https://private",
						},
					});
				},
			},
		);
		assert.equal(calls, 1);
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 1, 255]));
		assert.equal(response.headers.get("x-qorpera-access-mode"), "live-path-authority");
		assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("set-cookie"), null);
		assert.equal(response.headers.get("location"), null);
	});
	it("passes unchanged member edits once and never replays an uncertain write", async () => {
		let calls = 0;
		const body = JSON.stringify({ operationKey: id, text: "new appearance" });
		const response = await forwardMemberCompanyGateway(
			request(edits, { method: "POST", body, headers: { "content-type": "application/json" } }),
			{
				upstreamUrl,
				fetchImplementation: async (_url, init) => {
					calls++;
					assert.equal(new TextDecoder().decode(init?.body as Uint8Array), body);
					throw new TypeError("response lost");
				},
			},
		);
		assert.equal(calls, 1);
		assert.equal(response.status, 503);
		assert.match(await response.text(), /submitted change may still apply/);
	});
	it("preserves authorization denials instead of using a privileged fallback", async () => {
		const response = await forwardMemberCompanyGateway(request(), {
			upstreamUrl,
			fetchImplementation: async () => Response.json({ error: "denied" }, { status: 403 }),
		});
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "denied" });
	});
	it("admits a full-size text edit after JSON escaping", async () => {
		const body = JSON.stringify({ text: "\u0001".repeat(32 * 1024) });
		assert.ok(body.length > 64 * 1024);
		const response = await forwardMemberCompanyGateway(request(edits, { method: "POST", body }), {
			upstreamUrl,
			fetchImplementation: async (_url, init) => {
				assert.equal(new TextDecoder().decode(init?.body as Uint8Array), body);
				assert.equal(
					new Headers(init?.headers).get("content-length"),
					String(new TextEncoder().encode(body).length),
				);
				return Response.json({ state: "applied" });
			},
		});
		assert.equal(response.status, 200);
	});
	it("forwards selected upload bytes and metadata without JSON conversion", async () => {
		const path = `/v1/member-company-file/${id}/uploads`;
		const content = new Uint8Array([0, 128, 255]);
		const response = await forwardMemberCompanyGateway(
			request(path, {
				method: "PUT",
				body: content,
				headers: { "content-type": "application/octet-stream", "x-qorpera-company-upload": "metadata" },
			}),
			{
				upstreamUrl,
				fetchImplementation: async (_url, init) => {
					assert.deepEqual(init?.body, content);
					assert.equal(new Headers(init?.headers).get("x-qorpera-company-upload"), "metadata");
					return Response.json({ state: "applied" });
				},
			},
		);
		assert.equal(response.status, 200);
	});
	it("forwards presence reads through the same public boundary", async () => {
		const path = `/v1/member-company-presence/${id}/${id}`;
		const response = await forwardMemberCompanyGateway(request(path, { method: "POST", body: "{}" }), {
			upstreamUrl,
			fetchImplementation: async (url, init) => {
				assert.equal(String(url), upstreamUrl + path);
				assert.equal(init?.method, "POST");
				return Response.json({ state: "unavailable" });
			},
		});
		assert.equal(response.status, 200);
	});
	it("admits the SDK's bounded presence candidate payload without applying the smaller edit limit", async () => {
		const path = `/v1/member-company-presence/${id}/${id}`;
		const routes = Array.from({ length: 136 }, () => ({
			token: "a".repeat(64),
			relation: "self",
			extent: "object",
			activity: "reading",
		}));
		const candidates = Array.from({ length: 32 }, () => ({
			schema: "qorpera.company-path-presence/v1",
			companyId: id,
			environmentId: id,
			clientId: id,
			sequence: 1,
			issuedAt: 1,
			expiresAt: 30001,
			signature: `${"a".repeat(86)}==`,
			routes,
		}));
		const body = JSON.stringify({ paths: ["notes.txt"], candidates, truncated: false });
		assert.ok(body.length > 256 * 1024 && body.length <= 1024 * 1024);
		const response = await forwardMemberCompanyGateway(request(path, { method: "POST", body }), {
			upstreamUrl,
			fetchImplementation: async (_url, init) => {
				assert.equal(new TextDecoder().decode(init?.body as Uint8Array), body);
				return Response.json({ state: "available" });
			},
		});
		assert.equal(response.status, 200);
		const oversized = await forwardMemberCompanyGateway(
			request(path, { method: "POST", body: "x".repeat(1024 * 1024 + 1) }),
			{
				upstreamUrl,
				fetchImplementation: async () => assert.fail("oversized presence forwarded"),
			},
		);
		assert.equal(oversized.status, 413);
	});
	it("rejects an oversized response before consuming its stream", async () => {
		let cancelled = false;
		const response = await forwardMemberCompanyGateway(request(), {
			upstreamUrl,
			fetchImplementation: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-length": String(8 * 1024 * 1024 + 1) } },
				),
		});
		assert.equal(response.status, 502);
		assert.equal(cancelled, true);
	});
	it("accepts only route-specific browser preflight headers without contacting upstream", async () => {
		const fetchImplementation: typeof fetch = async () => {
			throw new Error("must not forward");
		};
		const response = await forwardMemberCompanyGateway(
			request(object, {
				method: "OPTIONS",
				headers: {
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization,x-qorpera-company-path",
				},
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(response.status, 204);
		assert.equal(response.headers.get("access-control-allow-methods"), "GET");
		const denied = await forwardMemberCompanyGateway(
			request(object, {
				method: "OPTIONS",
				headers: {
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization,x-admin-key",
				},
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(denied.status, 403);
	});
	for (const [name, req, status] of [
		["foreign origin", request(object, { headers: { origin: "https://evil.test" } }), 403],
		["no bearer", request(object, { headers: { authorization: "" } }), 401],
		["runtime route", request(`/v1/runtime-objects/${id}`), 404],
		["upstream query", request(`${object}?upstream=https://evil.test`), 404],
		["wrong method", request(object, { method: "POST" }), 405],
	] as const)
		it(`rejects ${name} before forwarding`, async () => {
			const response = await forwardMemberCompanyGateway(req, {
				upstreamUrl,
				fetchImplementation: async () => {
					assert.fail("must not forward");
				},
			});
			assert.equal(response.status, status);
		});
	it("fails closed for unconfigured or credential-bearing upstreams", async () => {
		for (const upstreamUrl of [
			undefined,
			"https://user:secret@node.test",
			"https://node.test/other",
			"http://node.test",
		])
			assert.equal((await forwardMemberCompanyGateway(request(), { upstreamUrl })).status, 503);
	});
	it("bounds streamed request bodies before forwarding", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(32768));
			},
			cancel() {
				cancelled = true;
			},
		});
		const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
		const response = await forwardMemberCompanyGateway(request(edits, init), {
			upstreamUrl,
			fetchImplementation: async () => {
				assert.fail("oversized body forwarded");
			},
		});
		assert.equal(response.status, 413);
		assert.equal(cancelled, true);
	});
	it("bounds response streaming and cancels a stalled body at the deadline", async () => {
		let cancelled = false;
		const pending = forwardMemberCompanyGateway(request(), {
			upstreamUrl,
			timeoutMs: 10,
			fetchImplementation: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		// Keep the Node test alive while AbortSignal.timeout's unref'ed timer expires.
		const keepAlive = setTimeout(() => {}, 1000);
		try {
			assert.equal((await pending).status, 503);
			assert.equal(cancelled, true);
		} finally {
			clearTimeout(keepAlive);
		}
	});
	it("cancels a request body on caller abort without submitting it", async () => {
		const abort = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const init: RequestInit & { duplex: "half" } = { method: "POST", body, signal: abort.signal, duplex: "half" };
		const pending = forwardMemberCompanyGateway(request(edits, init), {
			upstreamUrl,
			fetchImplementation: async () => assert.fail("cancelled request forwarded"),
		});
		abort.abort();
		assert.equal((await pending).status, 408);
		assert.equal(cancelled, true);
	});
	it("cancels upstream response streaming when the caller leaves", async () => {
		const abort = new AbortController();
		let cancelled = false;
		const pending = forwardMemberCompanyGateway(request(object, { signal: abort.signal }), {
			upstreamUrl,
			fetchImplementation: async (_url, init) => {
				queueMicrotask(() => abort.abort());
				assert.ok(init?.signal);
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				);
			},
		});
		assert.equal((await pending).status, 503);
		assert.equal(cancelled, true);
	});
	it("bounds response bytes even without a content length", async () => {
		let cancelled = false;
		const response = await forwardMemberCompanyGateway(request(), {
			upstreamUrl,
			fetchImplementation: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							controller.enqueue(new Uint8Array(1024 * 1024));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		});
		assert.equal(response.status, 502);
		assert.equal(cancelled, true);
	});
	for (const kind of ["edits", "proposals"])
		it(`forwards exact ${kind} review requests`, async () => {
			const body = JSON.stringify({ planSha256: "a".repeat(64), decision: "approve" });
			const response = await forwardMemberCompanyGateway(
				request(`/v1/member-company-file/${id}/${kind}/${id}/review`, {
					method: "POST",
					body,
					headers: { "content-type": "application/json" },
				}),
				{
					upstreamUrl,
					fetchImplementation: async (_url, init) => {
						assert.equal(init?.method, "POST");
						assert.equal(new TextDecoder().decode(init?.body as Uint8Array), body);
						return Response.json({ state: "applied" });
					},
				},
			);
			assert.equal(response.status, 200);
		});
	for (const path of [
		`/v1/member-company-snapshot-objects/${id}/${id}/${"b".repeat(64)}`,
		`/v1/member-file-exports/${id}/${id}/${"b".repeat(64)}`,
		`/v1/member-company-file/${id}/edits/${id}`,
		`/v1/member-company-file/${id}/edits/${id}/content`,
		`/v1/member-company-file/${id}/edits/${id}/file`,
		`/v1/member-company-file/${id}/proposals/${id}/content`,
		`/v1/member-company-file/${id}/proposals/${id}/file`,
	])
		it(`supports governed read route ${path.split("/")[2]}`, async () => {
			assert.equal(
				(
					await forwardMemberCompanyGateway(request(path), {
						upstreamUrl,
						fetchImplementation: async () => new Response("ok"),
					})
				).status,
				200,
			);
		});
});
