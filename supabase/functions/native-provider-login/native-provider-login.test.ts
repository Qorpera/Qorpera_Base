import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardNativeProviderLogin } from "./native-provider-login.ts";

const capability = "a".repeat(43);

describe("native provider login proxy", () => {
	it("permits only Qorpera browser preflights and preserves capability checks", async () => {
		const options = { upstreamUrl: "https://native-compute.example/", fetchImplementation: async () => { throw new Error("must not forward"); } };
		for (const origin of ["https://app.qorpera.com", "https://41fe840d.qorpera-web.pages.dev", "https://evil.pages.dev"]) {
			const allowed = origin !== "https://evil.pages.dev";
			const response = await forwardNativeProviderLogin(new Request("https://project.example/login", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } }), options);
			assert.equal(response.status, allowed ? 204 : 403);
			assert.equal(response.headers.get("access-control-allow-origin"), allowed ? origin : null);
		}
		const actual = await forwardNativeProviderLogin(new Request("https://project.example/login", { method: "POST", headers: { origin: "https://app.qorpera.com" }, body: "{}" }), options);
		assert.equal(actual.status, 400);
		assert.equal(actual.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
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
