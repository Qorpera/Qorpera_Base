import { describe, expect, it } from "vitest";
import { loadMemberWebConfig, webOAuthDestination } from "../src/auth.ts";
import { memberWebCsp, parseMemberWebConfig } from "../src/config.ts";

const config = {
	schema: "qorpera.member-web-config/v1",
	supabaseUrl: "https://control.test",
	publishableKey: "sb_publishable_fixture1",
	officeViewerOrigin: "wss://views.test",
};
const jwt = (role: string, sub?: string) =>
	`e30.${btoa(JSON.stringify({ role, ...(sub ? { sub } : {}) })).replaceAll("=", "")}.fixture`;
describe("public web configuration", () => {
	it.each(["sb_secret_fixture", jwt("service_role"), jwt("authenticated", "member"), jwt("anon", "member"), "bad"])(
		"rejects a non-public key %s",
		(publishableKey) => {
			expect(() => parseMemberWebConfig({ ...config, publishableKey })).toThrow();
		},
	);
	it("accepts only public publishable or anonymous project keys", () => {
		for (const publishableKey of [config.publishableKey, jwt("anon")])
			expect(parseMemberWebConfig({ ...config, publishableKey }).publishableKey).toBe(publishableKey);
	});
	it.each([
		"http://control.test",
		"https://member:password@control.test",
		"https://control.test/other",
		"https://control.test?token=x",
		"https://control.test#x",
		"https://control.test/",
	])("rejects noncanonical service origin %s", (supabaseUrl) => {
		expect(() => parseMemberWebConfig({ ...config, supabaseUrl })).toThrow();
	});
	it("rejects extra credentials, a file gateway and plaintext remote viewing", () => {
		expect(() => parseMemberWebConfig({ ...config, serviceToken: "secret" })).toThrow();
		expect(() => parseMemberWebConfig({ ...config, objectGatewayUrl: "https://objects.test" })).toThrow();
		expect(() => parseMemberWebConfig({ ...config, officeViewerOrigin: "ws://127.0.0.1" })).toThrow();
	});
	it("restricts CSP to configured origins with no inline code or framing", () => {
		const csp = memberWebCsp(parseMemberWebConfig(config));
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("connect-src 'self' https://control.test wss://views.test;");
		expect(csp).not.toMatch(/unsafe|\*/);
	});
	it("loads bounded configuration only from the app origin without following redirects", async () => {
		const result = await loadMemberWebConfig("https://app.test/?code=private", async (url, init) => {
			expect(String(url)).toBe("https://app.test/config.json");
			expect(init?.redirect).toBe("error");
			return Response.json(config);
		});
		expect(result).toEqual(config);
		await expect(
			loadMemberWebConfig("https://app.test", async () => new Response(" ".repeat(16385))),
		).rejects.toThrow();
	});
	it("only permits the configured Auth service as an OAuth launch destination", () => {
		const parsed = parseMemberWebConfig(config);
		expect(webOAuthDestination("https://control.test/auth/v1/authorize?provider=google", parsed)).toContain(
			"provider=google",
		);
		for (const url of ["https://evil.test/auth/v1/authorize", "https://control.test/redirect", "javascript:alert(1)"])
			expect(() => webOAuthDestination(url, parsed)).toThrow();
	});
});
