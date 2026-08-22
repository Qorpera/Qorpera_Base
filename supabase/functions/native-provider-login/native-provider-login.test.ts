import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardNativeProviderLogin } from "./native-provider-login.ts";

const capability = "a".repeat(43);

describe("native provider login proxy", () => {
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
});
