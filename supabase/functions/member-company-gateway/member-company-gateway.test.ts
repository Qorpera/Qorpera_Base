import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardMemberCompanyGateway, type MemberCompanyGatewayOptions } from "./member-company-gateway.ts";

const id = "11111111-1111-4111-8111-111111111111";
const object = `/v1/member-folder-objects/${id}/${"a".repeat(64)}`;
const commit = `/v1/member-folder-commits/${id}`;
const upstreamUrl = "https://node.tailnet.ts.net:10000";
const base = "https://project.supabase.co/functions/v1/member-company-gateway";
/** A request as the bridge receives it: a body of known size carries its length, as a browser sends it. */
function request(path = object, init: RequestInit = {}) {
	const length =
		typeof init.body === "string"
			? new TextEncoder().encode(init.body).byteLength
			: init.body instanceof Uint8Array
				? init.body.byteLength
				: undefined;
	return new Request(base + path, {
		...init,
		headers: {
			origin: "https://app.qorpera.com",
			authorization: "Bearer member.jwt.token",
			...(length === undefined ? {} : { "content-length": String(length) }),
			...Object.fromEntries(new Headers(init.headers)),
		},
	});
}
/** The bridge as deployed: the auth service knows the fixture member's token. */
function forward(req: Request, options: MemberCompanyGatewayOptions) {
	return forwardMemberCompanyGateway(req, {
		memberSignedIn: async (authorization) => authorization === "Bearer member.jwt.token",
		...options,
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
					forward(req, {
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
		const response = await forward(
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
		const response = await forward(
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
		const response = await forward(request(), {
			upstreamUrl,
			fetchImplementation: async () => Response.json({ error: "denied" }, { status: 403 }),
		});
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "denied" });
	});
	it("forwards presence reads through the same public boundary", async () => {
		const path = `/v1/member-company-presence/${id}/${id}`;
		const response = await forward(request(path, { method: "POST", body: "{}" }), {
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
		const response = await forward(request(path, { method: "POST", body }), {
			upstreamUrl,
			fetchImplementation: async (_url, init) => {
				assert.equal(new TextDecoder().decode(init?.body as Uint8Array), body);
				return Response.json({ state: "available" });
			},
		});
		assert.equal(response.status, 200);
		const oversized = await forward(
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
		const response = await forward(request(), {
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
		const response = await forward(
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
			const denied = await forward(
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
		["an erase request read", request(`/v1/member-message-erases/${id}/${id}/${id}`), 405],
		["an erase status write", request(`/v1/member-message-erases/${id}/${id}`, { method: "POST" }), 405],
		["an erase with a tail", request(`/v1/member-message-erases/${id}/${id}/${id}/${id}`, { method: "POST" }), 404],
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
			const response = await forward(req, {
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
			assert.equal((await forward(request(), { upstreamUrl })).status, 503);
	});
	it("refuses a streamed request body of unknown length unread", async () => {
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
		const response = await forward(request(commit, init), {
			upstreamUrl,
			fetchImplementation: async () => {
				assert.fail("body of unknown length forwarded");
			},
		});
		assert.equal(response.status, 411);
		assert.equal(cancelled, true);
	});
	it("bounds response streaming and cancels a stalled body at the deadline", async () => {
		let cancelled = false;
		const pending = forward(request(), {
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
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			body,
			signal: abort.signal,
			duplex: "half",
			headers: { "content-length": "10" },
		};
		const pending = forward(request(commit, init), {
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
		const pending = forward(request(object, { signal: abort.signal }), {
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
		const response = await forward(request(), {
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
		const response = await forward(
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
	it("forwards a member's message erase and its status with the member's token alone", async () => {
		const seen: string[] = [];
		const fetchImplementation: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			assert.deepEqual([...headers.keys()].filter((name) => name !== "content-length"), ["authorization"]);
			seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
			return Response.json({ schema: "qorpera.memory-message-erase/v1" });
		};
		for (const [path, method] of [
			[`/v1/member-message-erases/${id}/${id}/${id}`, "POST"],
			[`/v1/member-message-erases/${id}/${id}`, "GET"],
		] as const)
			assert.equal(
				(await forward(request(path, { method }), { upstreamUrl, fetchImplementation })).status,
				200,
			);
		assert.deepEqual(seen, [
			`POST /v1/member-message-erases/${id}/${id}/${id}`,
			`GET /v1/member-message-erases/${id}/${id}`,
		]);
		const preflight = await forward(
			request(`/v1/member-message-erases/${id}/${id}/${id}`, {
				method: "OPTIONS",
				headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(preflight.status, 403);
	});
	it("forwards a chat image upload up to 8 MiB and its read with the member's headers alone", async () => {
		const sha = "c".repeat(64);
		const upload = `/v1/member-session-attachments/upload/${id}/${id}/${sha}`;
		const input = `/v1/member-session-attachments/input/${id}/${id}/${sha}`;
		const image = new Uint8Array(8 * 1024 * 1024).fill(7);
		const seen: string[] = [];
		const fetchImplementation: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			seen.push(`${init?.method} ${new URL(String(url)).pathname} ${headers.get("content-type")}`);
			assert.equal(headers.get("authorization"), "Bearer member.jwt.token");
			if (init?.method === "PUT") {
				assert.equal((init.body as Uint8Array).byteLength, image.byteLength);
				return Response.json({ sha256: sha, bytes: image.byteLength, mediaType: "image/png" });
			}
			return new Response(image);
		};
		const put = await forward(
			request(upload, { method: "PUT", body: image, headers: { "content-type": "image/png" } }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(put.status, 200);
		const get = await forward(request(input), { upstreamUrl, fetchImplementation });
		assert.equal(get.status, 200);
		assert.equal((await get.arrayBuffer()).byteLength, image.byteLength);
		assert.deepEqual(seen, [`PUT ${upload} image/png`, `GET ${input} null`]);
		const oversized = await forward(
			request(upload, { method: "PUT", body: new Uint8Array(8 * 1024 * 1024 + 1) }),
			{ upstreamUrl, fetchImplementation: async () => assert.fail("oversized image forwarded") },
		);
		assert.equal(oversized.status, 413);
		const preflight = await forward(
			request(upload, {
				method: "OPTIONS",
				headers: {
					"access-control-request-method": "PUT",
					"access-control-request-headers": "authorization, content-type",
				},
			}),
			{ upstreamUrl, fetchImplementation: async () => assert.fail("preflight forwarded") },
		);
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-methods"), "PUT");
		// The read is the folder object read's shape: the member's token alone.
		const readPreflight = await forward(
			request(input, {
				method: "OPTIONS",
				headers: {
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization, content-type",
				},
			}),
			{ upstreamUrl, fetchImplementation: async () => assert.fail("preflight forwarded") },
		);
		assert.equal(readPreflight.status, 403);
		const wrongMethod = await forward(request(input, { method: "PUT", body: "x" }), {
			upstreamUrl,
			fetchImplementation: async () => assert.fail("wrong method forwarded"),
		});
		assert.equal(wrongMethod.status, 405);
	});
	it("reads an upload only for a signed-in member, into one buffer of its stated size", async () => {
		const upload = `/v1/member-session-attachments/upload/${id}/${id}/${"c".repeat(64)}`;
		const size = 8 * 1024 * 1024;
		const unread = () => {
			const state = { pulled: false, cancelled: false };
			const body = new ReadableStream<Uint8Array>(
				{
					pull() {
						state.pulled = true;
					},
					cancel() {
						state.cancelled = true;
					},
				},
				// Pulled only when someone reads it.
				{ highWaterMark: 0 },
			);
			const init: RequestInit & { duplex: "half" } = {
				method: "PUT",
				body,
				duplex: "half",
				headers: { "content-type": "image/png", "content-length": String(size) },
			};
			return { state, req: request(upload, init) };
		};
		const fetchImplementation = async () => assert.fail("unchecked upload forwarded");
		for (const [memberSignedIn, status] of [
			[async () => false, 401],
			[
				async () => {
					throw new Error("auth down");
				},
				503,
			],
			[undefined, 503],
		] as const) {
			const { state, req } = unread();
			const response = await forwardMemberCompanyGateway(req, { upstreamUrl, fetchImplementation, memberSignedIn });
			assert.equal(response.status, status);
			assert.deepEqual(state, { pulled: false, cancelled: true });
		}
		const original = globalThis.Uint8Array;
		const image = new original(size).fill(9);
		const req = request(upload, { method: "PUT", body: image, headers: { "content-type": "image/png" } });
		const allocations: number[] = [];
		globalThis.Uint8Array = new Proxy(original, {
			construct(target, args, newTarget) {
				if (typeof args[0] === "number") allocations.push(args[0]);
				return Reflect.construct(target, args, newTarget);
			},
		});
		try {
			const response = await forward(req, {
				upstreamUrl,
				fetchImplementation: async (_url, init) => {
					assert.equal((init?.body as Uint8Array).byteLength, size);
					return Response.json({ sha256: "c".repeat(64), bytes: size, mediaType: "image/png" });
				},
			});
			assert.equal(response.status, 200);
		} finally {
			globalThis.Uint8Array = original;
		}
		assert.deepEqual(
			allocations.filter((bytes) => bytes >= 1024 * 1024),
			[size],
		);
	});
	it("refuses a write whose body is not its stated length", async () => {
		const upload = `/v1/member-session-attachments/upload/${id}/${id}/${"c".repeat(64)}`;
		const fetchImplementation = async () => assert.fail("mismatched body forwarded");
		for (const length of ["2", "4", "-1", "1e3", "01"]) {
			const response = await forward(
				request(upload, {
					method: "PUT",
					body: new Uint8Array(3),
					headers: { "content-type": "image/png", "content-length": length },
				}),
				{ upstreamUrl, fetchImplementation },
			);
			assert.equal(response.status, 400, length);
		}
		const chunked = await forward(
			request(upload, {
				method: "PUT",
				body: new Uint8Array(3),
				headers: { "content-type": "image/png", "transfer-encoding": "chunked" },
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(chunked.status, 411);
	});
	it("answers a chat image with the allow-listed headers and its own failure text", async () => {
		const input = `/v1/member-session-attachments/input/${id}/${id}/${"c".repeat(64)}`;
		const response = await forward(request(input), {
			upstreamUrl,
			fetchImplementation: async () =>
				new Response(new Uint8Array([1, 2, 3]), {
					headers: {
						"content-type": "image/png",
						"x-qorpera-access-mode": "live-path-authority",
						etag: '"c"',
						"set-cookie": "node=1",
						"x-powered-by": "node",
						"access-control-allow-origin": "*",
						"content-disposition": "inline",
					},
				}),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(Object.fromEntries(response.headers), {
			"access-control-allow-origin": "https://app.qorpera.com",
			"access-control-expose-headers": "x-qorpera-access-mode, etag",
			"cache-control": "no-store",
			"content-type": "image/png",
			etag: '"c"',
			vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
			"x-content-type-options": "nosniff",
			"x-qorpera-access-mode": "live-path-authority",
		});
		const refused = await forward(request(input, { headers: { origin: "https://evil.test" } }), { upstreamUrl });
		assert.equal(refused.headers.get("x-content-type-options"), "nosniff");
		const down = await forward(request(input), {
			upstreamUrl,
			fetchImplementation: async () => {
				throw new TypeError("node unreachable");
			},
		});
		assert.equal(down.status, 503);
		assert.match(await down.text(), /Chat images are unavailable/);
	});
	it("supports the governed folder object read route", async () => {
		const path = `/v1/member-folder-objects/${id}/${"b".repeat(64)}`;
		assert.equal(
			(
				await forward(request(path), {
					upstreamUrl,
					fetchImplementation: async () => new Response("ok"),
				})
			).status,
			200,
		);
	});
});
