import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatGptPlanReturnLocation, chatGptPlanReturnUrl, handleChatGptPlanCallback } from "./chatgpt-plan-callback.ts";

const COMPANY = "3d2c6a1e-7b4f-4c55-9a1e-2f6b8c9d0e1f";
const STATE = `${COMPANY}.${"A".repeat(43)}`;
const VAULT = `https://vault.qorpera.test/v1/model-logins/${COMPANY}/chatgpt-plan/callback`;
const RETURN = "https://app.qorpera.com/#/settings/connections";
const CONFIRMATION = "C".repeat(43);

function callback(query: Record<string, string>, method = "GET"): Request {
	const url = new URL("https://project.supabase.co/functions/v1/chatgpt-plan-callback");
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return new Request(url, { method });
}

function vault(answer: { status: number; body?: unknown }) {
	const calls: Array<{ url: string; body: unknown; init: RequestInit }> = [];
	const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body)), init: init ?? {} });
		return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
	}) as typeof fetch;
	return { calls, fetchImplementation };
}

function fragment(response: Response): Record<string, string> {
	const location = response.headers.get("location") ?? "";
	return Object.fromEntries(new URLSearchParams(location.slice(location.indexOf("?", location.indexOf("#")) + 1)));
}

describe("the ChatGPT plan callback", () => {
	it("forwards the state and code to the company's vault and returns the browser with a confirmation id only", async () => {
		const targets: string[] = [];
		const stub = vault({
			status: 200,
			body: { schema: "qorpera.chatgpt-plan-callback-result/v1", status: "confirm", confirmation: CONFIRMATION, reason: null },
		});
		const response = await handleChatGptPlanCallback(callback({ state: STATE, code: "code_secret", scope: "openid" }), {
			returnUrl: RETURN,
			resolveTarget: async (state) => {
				targets.push(state);
				return VAULT;
			},
			fetchImplementation: stub.fetchImplementation,
		});
		assert.equal(response.status, 303);
		assert.deepEqual(targets, [STATE]);
		assert.equal(stub.calls[0]?.url, VAULT);
		assert.deepEqual(stub.calls[0]?.body, {
			schema: "qorpera.chatgpt-plan-callback/v1",
			state: STATE,
			code: "code_secret",
			error: null,
			clientId: null,
		});
		assert.equal(stub.calls[0]?.init.redirect, "error");
		const location = response.headers.get("location") ?? "";
		assert.ok(location.startsWith("https://app.qorpera.com/#/settings/connections?"));
		assert.deepEqual(fragment(response), { chatgpt_plan: "confirm", confirmation: CONFIRMATION });
		assert.ok(!location.includes("code_secret"));
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	});

	it("returns a refusal without asking anyone for a malformed state, and for a state no vault expects", async () => {
		const stub = vault({ status: 200, body: {} });
		let asked = 0;
		const options = {
			returnUrl: RETURN,
			resolveTarget: async () => {
				asked += 1;
				return undefined;
			},
			fetchImplementation: stub.fetchImplementation,
		};
		const malformed = await handleChatGptPlanCallback(callback({ state: `${COMPANY.toUpperCase()}.${"A".repeat(43)}`, code: "c" }), options);
		assert.deepEqual(fragment(malformed), { chatgpt_plan: "failed", reason: "state_unknown" });
		assert.equal(asked, 0);
		const unknown = await handleChatGptPlanCallback(callback({ state: STATE, code: "c" }), options);
		assert.deepEqual(fragment(unknown), { chatgpt_plan: "failed", reason: "state_unknown" });
		assert.equal(asked, 1);
		assert.equal(stub.calls.length, 0);
		const nothing = await handleChatGptPlanCallback(callback({ state: STATE }), options);
		assert.deepEqual(fragment(nothing), { chatgpt_plan: "failed", reason: "provider_error" });
	});

	it("passes a declined consent through, and keeps the vault's failures to its known reasons", async () => {
		const declined = vault({
			status: 200,
			body: { schema: "qorpera.chatgpt-plan-callback-result/v1", status: "failed", confirmation: null, reason: "declined" },
		});
		const response = await handleChatGptPlanCallback(callback({ state: STATE, error: "access_denied" }), {
			returnUrl: RETURN,
			resolveTarget: async () => VAULT,
			fetchImplementation: declined.fetchImplementation,
		});
		assert.deepEqual(declined.calls[0]?.body, {
			schema: "qorpera.chatgpt-plan-callback/v1",
			state: STATE,
			code: null,
			error: "access_denied",
			clientId: null,
		});
		assert.deepEqual(fragment(response), { chatgpt_plan: "failed", reason: "declined" });
		for (const answer of [
			{ status: 500, body: { error: "private detail" } },
			{ status: 200, body: { schema: "qorpera.chatgpt-plan-callback-result/v1", status: "failed", reason: "<script>" } },
			{ status: 200, body: { schema: "qorpera.chatgpt-plan-callback-result/v1", status: "confirm", confirmation: "short" } },
		]) {
			const stub = vault(answer);
			const failed = await handleChatGptPlanCallback(callback({ state: STATE, code: "c" }), {
				returnUrl: RETURN,
				resolveTarget: async () => VAULT,
				fetchImplementation: stub.fetchImplementation,
			});
			assert.deepEqual(fragment(failed), { chatgpt_plan: "failed", reason: "provider_error" });
		}
	});

	it("refuses a vault address that is not plain HTTPS, and any method but GET", async () => {
		const stub = vault({ status: 200, body: {} });
		for (const target of ["http://vault.qorpera.test/callback", `${VAULT}?x=1`, "https://user:pass@vault.qorpera.test/callback"]) {
			const response = await handleChatGptPlanCallback(callback({ state: STATE, code: "c" }), {
				returnUrl: RETURN,
				resolveTarget: async () => target,
				fetchImplementation: stub.fetchImplementation,
			});
			assert.deepEqual(fragment(response), { chatgpt_plan: "failed", reason: "provider_error" });
		}
		assert.equal(stub.calls.length, 0);
		const posted = await handleChatGptPlanCallback(callback({ state: STATE, code: "c" }, "POST"), {
			returnUrl: RETURN,
			resolveTarget: async () => VAULT,
		});
		assert.equal(posted.status, 405);
	});

	it("returns members only to an HTTPS page of an allowed web origin", () => {
		assert.equal(chatGptPlanReturnUrl(undefined, []), "https://app.qorpera.com/");
		assert.equal(chatGptPlanReturnUrl(undefined, ["https://staging.qorpera.com"]), "https://staging.qorpera.com/");
		assert.equal(chatGptPlanReturnUrl(RETURN, ["https://app.qorpera.com"]), RETURN);
		for (const bad of ["https://evil.example/", "http://app.qorpera.com/", "https://app.qorpera.com/?next=x"])
			assert.throws(() => chatGptPlanReturnUrl(bad, ["https://app.qorpera.com"]));
		assert.equal(
			chatGptPlanReturnLocation("https://app.qorpera.com/", { reason: "expired" }),
			"https://app.qorpera.com/#?chatgpt_plan=failed&reason=expired",
		);
	});
});
