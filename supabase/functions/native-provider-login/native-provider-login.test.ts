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
  const response = await forwardNativeProviderLogin(new Request("https://example.test/login", { method: "OPTIONS", headers: {
   origin: "https://app.qorpera.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type",
  } }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.match(response.headers.get("vary") ?? "", /Origin/);
 });
 it("refuses hostile, null and suffix origins before upstream dispatch", async () => {
  for (const origin of ["https://evil.example", "null", "https://app.qorpera.com.evil.example", "http://app.qorpera.com"]) {
   const response = await forwardNativeProviderLogin(new Request("https://example.test/login", { method: "POST", headers: { origin, authorization: `Bearer ${capability}` }, body: "{}" }), {
    upstreamUrl: "https://private.example/", fetchImplementation: async () => { throw new Error("must not dispatch"); },
   });
   assert.equal(response.status, 403);
   assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
 });
 it("refuses other methods and request headers in preflight", async () => {
  for (const [method, headers] of [["DELETE", "authorization"], ["POST", "authorization,x-service-secret"]]) {
   const response = await forwardNativeProviderLogin(new Request("https://example.test/login", { method: "OPTIONS", headers: {
    origin: "https://app.qorpera.com", "access-control-request-method": method, "access-control-request-headers": headers,
   } }), {});
   assert.equal(response.status, 403);
  }
 });
 it("keeps success, capability refusal and unavailable responses browser readable", async () => {
  for (const status of [200, 400, 503]) {
   const response = await forwardNativeProviderLogin(new Request("https://example.test/login", { method: "POST", headers: {
    origin: "https://app.qorpera.com", ...(status === 400 ? {} : { authorization: `Bearer ${capability}` }),
   }, body: "{}" }), { upstreamUrl: status === 503 ? undefined : "https://private.example/", fetchImplementation: async () => Response.json({ status: "awaiting_member" }) });
   assert.equal(response.status, status);
   assert.equal(response.headers.get("access-control-allow-origin"), "https://app.qorpera.com");
   assert.equal(response.headers.get("cache-control"), "no-store");
  }
 });
});
