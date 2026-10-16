import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardMemberCompanyGateway } from "./member-company-gateway.ts";

const id = "11111111-1111-4111-8111-111111111111";
const object = `/v1/member-folder-objects/${id}/${"a".repeat(64)}`;
const commit = `/v1/member-folder-commits/${id}`;
const upstreamUrl = "https://node.tailnet.ts.net:10000";
const base = "https://project.supabase.co/functions/v1/member-company-gateway";
function request(path = object, init: RequestInit = {}) {
	return new Request(base + path, {
		...init,
		headers: {
			origin: "https://app.qorpera.com",
			authorization: "Bearer member.jwt.token",
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
	it("passes an unchanged folder commit once and never replays an uncertain write", async () => {
		let calls = 0;
		const body = JSON.stringify({
			schema: "qorpera.member-folder-commit/v1",
			operationKey: "web:1",
			units: [{ op: "write", path: "notes.txt", text: "new appearance" }],
		});
		const response = await forwardMemberCompanyGateway(
			request(commit, { method: "POST", body, headers: { "content-type": "application/json" } }),
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
	it("admits the SDK's bounded presence candidate payload up to the 1 MiB write bound", async () => {
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
					"access-control-request-headers": "authorization",
				},
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(response.status, 204);
		assert.equal(response.headers.get("access-control-allow-methods"), "GET");
		assert.equal(response.headers.get("access-control-allow-headers"), "authorization");
		for (const header of ["x-admin-key", "x-qorpera-company-path"]) {
			const denied = await forwardMemberCompanyGateway(
				request(object, {
					method: "OPTIONS",
					headers: {
						"access-control-request-method": "GET",
						"access-control-request-headers": `authorization,${header}`,
					},
				}),
				{ upstreamUrl, fetchImplementation },
			);
			assert.equal(denied.status, 403);
		}
	});
	for (const [name, req, status] of [
		["foreign origin", request(object, { headers: { origin: "https://evil.test" } }), 403],
		["no bearer", request(object, { headers: { authorization: "" } }), 401],
		["runtime route", request(`/v1/runtime-objects/${id}`), 404],
		["upstream query", request(`${object}?upstream=https://evil.test`), 404],
		["wrong method", request(object, { method: "POST" }), 405],
		["a folder object without its hash", request(`/v1/member-folder-objects/${id}`), 404],
		["a folder object with a version", request(`/v1/member-folder-objects/${id}/${id}/${"b".repeat(64)}`), 404],
		["a folder object write", request(`/v1/member-folder-objects/${id}/${"b".repeat(64)}`, { method: "PUT" }), 405],
		["a folder commit read", request(`/v1/member-folder-commits/${id}`), 405],
		["a folder commit with a tail", request(`/v1/member-folder-commits/${id}/${id}`, { method: "POST" }), 404],
		["a snapshot-v1 path object", request(`/v1/member-company-objects/${id}/${id}/${"b".repeat(64)}`), 404],
		[
			"a snapshot-v1 snapshot object",
			request(`/v1/member-company-snapshot-objects/${id}/${id}/${"b".repeat(64)}`),
			404,
		],
		["a snapshot-v1 edit", request(`/v1/member-company-file/${id}/edits`, { method: "POST", body: "{}" }), 404],
		["a snapshot-v1 edit read", request(`/v1/member-company-file/${id}/edits/${id}/content`), 404],
		[
			"a snapshot-v1 proposal review",
			request(`/v1/member-company-file/${id}/proposals/${id}/review`, { method: "POST", body: "{}" }),
			404,
		],
		["a snapshot-v1 upload", request(`/v1/member-company-file/${id}/uploads`, { method: "PUT", body: "x" }), 404],
		["a member file export", request(`/v1/member-file-exports/${id}/${id}/${"b".repeat(64)}`), 404],
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
		const response = await forwardMemberCompanyGateway(request(commit, init), {
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
		const pending = forwardMemberCompanyGateway(request(commit, init), {
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
	it("forwards a member's folder commit exactly", async () => {
		const body = JSON.stringify({
			schema: "qorpera.member-folder-commit/v1",
			operationKey: "web:1",
			// Past 256 KiB: a change set may carry up to 512 KiB of text.
			units: [{ op: "write", path: "notes.txt", text: "x".repeat(300 * 1024) }],
		});
		const response = await forwardMemberCompanyGateway(
			request(`/v1/member-folder-commits/${id}`, {
				method: "POST",
				body,
				headers: { "content-type": "application/json" },
			}),
			{
				upstreamUrl,
				fetchImplementation: async (url, init) => {
					assert.equal(new URL(String(url)).pathname, `/v1/member-folder-commits/${id}`);
					assert.equal(init?.method, "POST");
					assert.equal(new TextDecoder().decode(init?.body as Uint8Array), body);
					return Response.json({ schema: "qorpera.folder-commit/v1", units: [] });
				},
			},
		);
		assert.equal(response.status, 200);
	});
	it("supports the governed folder object read route", async () => {
		const path = `/v1/member-folder-objects/${id}/${"b".repeat(64)}`;
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
