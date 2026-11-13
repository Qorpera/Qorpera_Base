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
		["a machine screen write", request(`/v1/member-machine-screens/${id}/${id}`, { method: "POST", body: "{}" }), 405],
		["a machine screen of one id", request(`/v1/member-machine-screens/${id}`), 404],
		["a machine screen with another tail", request(`/v1/member-machine-screens/${id}/${id}/keep`), 404],
		["a machine screen with a query", request(`/v1/member-machine-screens/${id}/${id}?keep=1`), 404],
		["a machine action read", request(`/v1/member-machine-screens/${id}/${id}/act`), 405],
		[
			"a machine action past 16 KiB",
			request(`/v1/member-machine-screens/${id}/${id}/act`, { method: "POST", body: "x".repeat(16 * 1024 + 1) }),
			413,
		],
		["a machine action of one id", request(`/v1/member-machine-screens/${id}/act`, { method: "POST", body: "{}" }), 404],
		["a machine start read", request(`/v1/member-machine-screens/${id}/${id}/start`), 405],
		[
			"a machine start past 1 KiB",
			request(`/v1/member-machine-screens/${id}/${id}/start`, { method: "POST", body: "x".repeat(1025) }),
			413,
		],
		["a machine start of one id", request(`/v1/member-machine-screens/${id}/start`, { method: "POST", body: "{}" }), 404],
		...(["query", "watch", "apply", "describe"] as const).flatMap((verb) => {
			const path = `/v1/company-data/${id}/${verb}`;
			return [
				[`a company data ${verb} read`, request(path), 405],
				[`a company data ${verb} put`, request(path, { method: "PUT", body: "{}" }), 405],
				[`a company data ${verb} with a query`, request(`${path}?wait=1`, { method: "POST", body: "{}" }), 404],
				[
					`a company data ${verb} with a tail`,
					request(`${path}/${id}`, { method: "POST", body: "{}" }),
					404,
				],
				[
					`a company data ${verb} without a bearer`,
					request(path, { method: "POST", body: "{}", headers: { authorization: "" } }),
					401,
				],
				[
					`a company data ${verb} with a basic login`,
					request(path, { method: "POST", body: "{}", headers: { authorization: "Basic bWU6cGFzcw==" } }),
					401,
				],
				[
					`a company data ${verb} with a bearer of two words`,
					request(path, { method: "POST", body: "{}", headers: { authorization: "Bearer member jwt" } }),
					401,
				],
				[
					`a company data ${verb} from a foreign origin`,
					request(path, { method: "POST", body: "{}", headers: { origin: "https://evil.test" } }),
					403,
				],
			] as const;
		}),
		["a company data drop", request(`/v1/company-data/${id}/drop`, { method: "POST", body: "{}" }), 404],
		["a company data call without a verb", request(`/v1/company-data/${id}`, { method: "POST", body: "{}" }), 404],
		["a company data call of no environment", request("/v1/company-data/query", { method: "POST", body: "{}" }), 404],
		[
			"a company data call of an upper case environment",
			request(`/v1/company-data/${id.replace(/1/g, "A")}/query`, { method: "POST", body: "{}" }),
			404,
		],
		[
			"a company data call of a name for an environment",
			request("/v1/company-data/shop/query", { method: "POST", body: "{}" }),
			404,
		],
		[
			"a company data call of a path for an environment",
			request(`/v1/company-data/..%2F${id}/query`, { method: "POST", body: "{}" }),
			404,
		],
		[
			"a company data query past 64 KiB",
			request(`/v1/company-data/${id}/query`, { method: "POST", body: "x".repeat(64 * 1024 + 1) }),
			413,
		],
		[
			"a company data watch past 64 KiB",
			request(`/v1/company-data/${id}/watch`, { method: "POST", body: "x".repeat(64 * 1024 + 1) }),
			413,
		],
		[
			"a company data describe past 64 KiB",
			request(`/v1/company-data/${id}/describe`, { method: "POST", body: "x".repeat(64 * 1024 + 1) }),
			413,
		],
		[
			"a company data apply past 1 MiB",
			request(`/v1/company-data/${id}/apply`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) }),
			413,
		],
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
	it("forwards a member's look at a desktop with the member's token and etag alone, and its picture, 304 or refusal", async () => {
		const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const etag = `"${"e".repeat(64)}"`;
		const seen: string[] = [];
		let answer: () => Response = () =>
			new Response(picture, { status: 200, headers: { "content-type": "image/png", etag, "x-node": "node-01" } });
		const fetchImplementation: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			const sent = [...headers.entries()].map(([name, value]) => `${name}=${value}`).join(" ");
			seen.push(`${init?.method} ${new URL(String(url)).pathname} ${sent}`);
			assert.equal(init?.body, undefined);
			return answer();
		};
		const path = `/v1/member-machine-screens/${id}/${id}`;
		const shown = await forward(request(path, { headers: { "if-none-match": etag, cookie: "a=b" } }), {
			upstreamUrl,
			fetchImplementation,
		});
		assert.equal(shown.status, 200);
		assert.equal(shown.headers.get("content-type"), "image/png");
		assert.equal(shown.headers.get("etag"), etag);
		assert.equal(shown.headers.get("x-node"), null);
		assert.match(shown.headers.get("access-control-expose-headers") ?? "", /\betag\b/);
		assert.deepEqual(new Uint8Array(await shown.arrayBuffer()), picture);
		answer = () => new Response(null, { status: 304, headers: { etag } });
		const same = await forward(request(`${path}/watching`), { upstreamUrl, fetchImplementation });
		assert.equal(same.status, 304);
		assert.equal(same.headers.get("etag"), etag);
		answer = () => Response.json({ code: "SCREEN_HIDDEN" }, { status: 409 });
		const hidden = await forward(request(path), { upstreamUrl, fetchImplementation });
		assert.equal(hidden.status, 409);
		assert.deepEqual(await hidden.json(), { code: "SCREEN_HIDDEN" });
		assert.deepEqual(seen, [
			`GET ${path} authorization=Bearer member.jwt.token if-none-match=${etag}`,
			`GET ${path}/watching authorization=Bearer member.jwt.token`,
			`GET ${path} authorization=Bearer member.jwt.token`,
		]);
		// The browser may ask for the etag header, and nothing else beside the token.
		const preflight = (headers: string) =>
			forward(
				request(path, {
					method: "OPTIONS",
					headers: { "access-control-request-method": "GET", "access-control-request-headers": headers },
				}),
				{ upstreamUrl, fetchImplementation },
			);
		const allowed = await preflight("authorization,if-none-match");
		assert.equal(allowed.status, 204);
		assert.equal(allowed.headers.get("access-control-allow-headers"), "authorization, if-none-match");
		assert.equal((await preflight("authorization,content-type")).status, 403);
		assert.equal(seen.length, 3);
	});
	it("forwards a member's action on a desktop they hold with the member's token and its JSON alone (20260930713000)", async () => {
		const seen: string[] = [];
		const bodies: string[] = [];
		let answer: () => Response = () => Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: 0 });
		const fetchImplementation: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			const sent = [...headers.entries()].map(([name, value]) => `${name}=${value}`).join(" ");
			seen.push(`${init?.method} ${new URL(String(url)).pathname} ${sent}`);
			bodies.push(new TextDecoder().decode(init?.body as Uint8Array));
			return answer();
		};
		const path = `/v1/member-machine-screens/${id}/${id}/act`;
		// The epoch and the seat of the hold the input was captured under (F24, F26) pass as they came, as the rest of the
		// body.
		const body = JSON.stringify({ action: { type: "type", text: "hunter2 Åse" }, epoch: 7, seat: 12 });
		const done = await forward(
			request(path, { method: "POST", body, headers: { "content-type": "application/json", cookie: "a=b" } }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(done.status, 200);
		assert.deepEqual(await done.json(), { schema: "qorpera.member-machine-act/v1", exitCode: 0 });
		answer = () => Response.json({ code: "DESKTOP_CONTROL_ENDED" }, { status: 409 });
		const ended = await forward(
			request(path, { method: "POST", body, headers: { "content-type": "application/json" } }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(ended.status, 409);
		assert.deepEqual(await ended.json(), { code: "DESKTOP_CONTROL_ENDED" });
		const length = new TextEncoder().encode(body).byteLength;
		assert.deepEqual(seen, [
			`POST ${path} authorization=Bearer member.jwt.token content-length=${length} content-type=application/json`,
			`POST ${path} authorization=Bearer member.jwt.token content-length=${length} content-type=application/json`,
		]);
		assert.deepEqual(bodies, [body, body]);
		// Exactly 16 KiB passes; someone signed out is not read.
		const full = JSON.stringify({ action: { type: "click", x: 1, y: 2 }, epoch: 7, seat: 12, pad: "" });
		const padded = full.replace('"pad":""', `"pad":"${"p".repeat(16 * 1024 - full.length)}"`);
		assert.equal(new TextEncoder().encode(padded).byteLength, 16 * 1024);
		answer = () => Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: 0 });
		assert.equal(
			(await forward(request(path, { method: "POST", body: padded }), { upstreamUrl, fetchImplementation })).status,
			200,
		);
		const stranger = await forward(
			request(path, { method: "POST", body, headers: { authorization: "Bearer someone.else.token" } }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(stranger.status, 401);
		assert.equal(seen.length, 3);
		// The browser may send the token and the content type, and nothing else.
		const preflight = (headers: string) =>
			forward(
				request(path, {
					method: "OPTIONS",
					headers: { "access-control-request-method": "POST", "access-control-request-headers": headers },
				}),
				{ upstreamUrl, fetchImplementation },
			);
		const allowed = await preflight("authorization,content-type");
		assert.equal(allowed.status, 204);
		assert.equal(allowed.headers.get("access-control-allow-methods"), "POST");
		assert.equal((await preflight("authorization,if-none-match")).status, 403);
	});
	it("forwards a member's start of the desktop as it came, with the member's token, up to 1 KiB (20260930714000)", async () => {
		const seen: string[] = [];
		const fetchImplementation: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			const sent = [...headers.entries()].map(([name, value]) => `${name}=${value}`).join(" ");
			seen.push(`${init?.method} ${new URL(String(url)).pathname} ${sent} ${new TextDecoder().decode(init?.body as Uint8Array)}`);
			return Response.json({ schema: "qorpera.member-machine-start/v1", outcome: "started" });
		};
		const path = `/v1/member-machine-screens/${id}/${id}/start`;
		const done = await forward(
			request(path, { method: "POST", body: "{}", headers: { "content-type": "application/json", cookie: "a=b" } }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(done.status, 200);
		assert.deepEqual(await done.json(), { schema: "qorpera.member-machine-start/v1", outcome: "started" });
		assert.deepEqual(seen, [
			`POST ${path} authorization=Bearer member.jwt.token content-length=2 content-type=application/json {}`,
		]);
		const stranger = await forward(
			request(path, { method: "POST", body: "{}", headers: { authorization: "Bearer someone.else.token" } }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(stranger.status, 401);
		assert.equal(seen.length, 1);
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
	it("forwards a member's calls to the company's databases with the member's token and its JSON alone", async () => {
		const seen: string[] = [];
		const bodies: string[] = [];
		let answer: () => Response = () =>
			Response.json({ columns: ["total"], rows: [[12]], more: false }, { headers: { "cache-control": "no-store" } });
		const fetchImplementation: typeof fetch = async (url, init) => {
			assert.equal(init?.redirect, "error");
			assert.equal(init?.credentials, "omit");
			const headers = new Headers(init?.headers);
			const sent = [...headers.entries()].map(([name, value]) => `${name}=${value}`).join(" ");
			seen.push(`${init?.method} ${String(url)} ${sent}`);
			bodies.push(new TextDecoder().decode(init?.body as Uint8Array));
			return answer();
		};
		const body = JSON.stringify({ name: "shop/sales-this-month", params: { since: "2026-11-01" } });
		const length = new TextEncoder().encode(body).byteLength;
		for (const verb of ["query", "watch", "apply", "describe"]) {
			const path = `/v1/company-data/${id}/${verb}`;
			const done = await forward(
				request(path, {
					method: "POST",
					body,
					headers: { "content-type": "application/json", cookie: "a=b", apikey: "ignore", "x-qorpera-company": id },
				}),
				{ upstreamUrl, fetchImplementation },
			);
			assert.equal(done.status, 200, verb);
			assert.equal(done.headers.get("content-type"), "application/json");
			assert.equal(done.headers.get("cache-control"), "no-store");
			assert.equal(done.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
			assert.deepEqual(await done.json(), { columns: ["total"], rows: [[12]], more: false });
		}
		assert.deepEqual(
			seen,
			["query", "watch", "apply", "describe"].map(
				(verb) =>
					`POST ${upstreamUrl}/v1/company-data/${id}/${verb} authorization=Bearer member.jwt.token content-length=${length} content-type=application/json`,
			),
		);
		assert.deepEqual(bodies, [body, body, body, body]);
		// A refusal passes back as the data gateway gave it, a held step with what it would destroy.
		answer = () =>
			Response.json(
				{ error: "The step would destroy data", destroys: [{ table: "orders", rows: 3 }] },
				{ status: 409, headers: { "x-node": "node-01", "set-cookie": "node=1" } },
			);
		const held = await forward(
			request(`/v1/company-data/${id}/apply`, {
				method: "POST",
				body: "{}",
				headers: { "content-type": "application/json" },
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(held.status, 409);
		assert.equal(held.headers.get("content-type"), "application/json");
		assert.equal(held.headers.get("x-node"), null);
		assert.equal(held.headers.get("set-cookie"), null);
		assert.deepEqual(await held.json(), {
			error: "The step would destroy data",
			destroys: [{ table: "orders", rows: 3 }],
		});
		answer = () => {
			throw new TypeError("node unreachable");
		};
		const down = await forward(
			request(`/v1/company-data/${id}/apply`, { method: "POST", body: "{}" }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(down.status, 503);
		assert.match(await down.text(), /Steps sent may still apply/);
		const watchDown = await forward(
			request(`/v1/company-data/${id}/watch`, { method: "POST", body: "{}" }),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(watchDown.status, 503);
		assert.match(await watchDown.text(), /Company data is unavailable just now/);
		assert.equal(seen.length, 7);
	});
	it("bounds a company data call's body: 64 KiB for a question, a watch or a look, 1 MiB for steps", async () => {
		const sizes: number[] = [];
		const fetchImplementation: typeof fetch = async (_url, init) => {
			sizes.push((init?.body as Uint8Array).byteLength);
			return Response.json({ ok: true });
		};
		for (const [verb, limit] of [
			["query", 64 * 1024],
			["watch", 64 * 1024],
			["describe", 64 * 1024],
			["apply", 1024 * 1024],
		] as const) {
			const path = `/v1/company-data/${id}/${verb}`;
			const full = await forward(request(path, { method: "POST", body: "x".repeat(limit) }), {
				upstreamUrl,
				fetchImplementation,
			});
			assert.equal(full.status, 200, verb);
			const over = await forward(request(path, { method: "POST", body: "x".repeat(limit + 1) }), {
				upstreamUrl,
				fetchImplementation,
			});
			assert.equal(over.status, 413, verb);
		}
		assert.deepEqual(sizes, [64 * 1024, 64 * 1024, 64 * 1024, 1024 * 1024]);
	});
	it("reads a company data call's body only for a signed-in member, a watch too", async () => {
		const fetchImplementation = async () => assert.fail("unchecked company data call forwarded");
		for (const verb of ["query", "watch", "apply", "describe"])
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
					{ highWaterMark: 0 },
				);
				const init: RequestInit & { duplex: "half" } = {
					method: "POST",
					body,
					duplex: "half",
					headers: { "content-type": "application/json", "content-length": "1024" },
				};
				const response = await forwardMemberCompanyGateway(request(`/v1/company-data/${id}/${verb}`, init), {
					upstreamUrl,
					fetchImplementation,
					memberSignedIn,
				});
				assert.equal(response.status, status, verb);
				assert.deepEqual(state, { pulled: false, cancelled: true }, verb);
			}
	});
	it("answers a company data call's preflight for POST with the token and the content type alone", async () => {
		const fetchImplementation = async () => assert.fail("preflight forwarded");
		for (const verb of ["query", "watch", "apply", "describe"]) {
			const preflight = (method: string, headers: string, origin = "https://app.qorpera.com") =>
				forward(
					request(`/v1/company-data/${id}/${verb}`, {
						method: "OPTIONS",
						headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
					}),
					{ upstreamUrl, fetchImplementation },
				);
			const allowed = await preflight("POST", "authorization, content-type");
			assert.equal(allowed.status, 204, verb);
			assert.equal(allowed.headers.get("access-control-allow-methods"), "POST");
			assert.equal(allowed.headers.get("access-control-allow-headers"), "authorization, content-type");
			assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
			assert.equal((await preflight("GET", "authorization")).status, 403, verb);
			assert.equal((await preflight("POST", "authorization,if-none-match")).status, 403, verb);
			assert.equal((await preflight("POST", "authorization,x-qorpera-company-path")).status, 403, verb);
			assert.equal((await preflight("POST", "authorization", "https://evil.test")).status, 403, verb);
		}
		const drop = await forward(
			request(`/v1/company-data/${id}/drop`, {
				method: "OPTIONS",
				headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization" },
			}),
			{ upstreamUrl, fetchImplementation },
		);
		assert.equal(drop.status, 404);
	});
	it("gives a held watch 25 s, past the data gateway's 20 s hold", async () => {
		const original = AbortSignal.timeout;
		const deadlines: number[] = [];
		AbortSignal.timeout = (ms: number) => {
			deadlines.push(ms);
			return original.call(AbortSignal, ms);
		};
		try {
			for (const verb of ["watch", "query", "apply", "describe"]) {
				const response = await forward(
					request(`/v1/company-data/${id}/${verb}`, { method: "POST", body: "{}" }),
					{ upstreamUrl, fetchImplementation: async () => Response.json({ same: true }) },
				);
				assert.equal(response.status, 200, verb);
			}
		} finally {
			AbortSignal.timeout = original;
		}
		assert.deepEqual(deadlines, [25_000, 25_000, 25_000, 25_000]);
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
