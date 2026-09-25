// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { EmailDraftClient, parseEmailDraftState } from "../src/cloud/email-drafts.ts";

const session = "11111111-1111-4111-8111-111111111111";
const interaction = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const companyId = "44444444-4444-4444-8444-444444444444";
const content = { to: ["henrik@example.com"], cc: [], subject: "Om Qorpera", body: "Hej Henrik,\n\nHer er Qorpera." };
const receipt = {
	schema: "qorpera.email-draft-state/v1",
	companyId,
	from: "jonas@example.com",
	content,
	status: "ready",
};
function fixture() {
	const rpc = vi.fn(
		async (name: string): Promise<unknown> =>
			name === "qorpera_get_email_draft"
				? receipt
				: {
						...receipt,
						status: "sending",
						actionId,
						brokerOrigin: "https://broker.example.com",
						phase: "pending",
					},
	);
	const cloud = { config: { projectUrl: "https://cloud.example.com" }, rpc } as unknown as Cloud;
	const controller = new AbortController();
	return { rpc, cloud, controller, client: new EmailDraftClient(cloud, "member-one", controller.signal) };
}
beforeEach(() => {
	sessionStorage.clear();
	vi.stubGlobal("crypto", {
		subtle: webcrypto.subtle,
		getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
		randomUUID: () => actionId,
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("email draft member transport", () => {
	it("sends exact edited content and only the action capability to the broker", async () => {
		const f = fixture();
		const fetch = vi.fn(
			async () => new Response(JSON.stringify({ ...receipt, status: "sent", actionId, messageId: "abc" })),
		);
		vi.stubGlobal("fetch", fetch);
		const result = await f.client.act(session, interaction, "send", content);
		expect(result.status).toBe("sent");
		const args = f.rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
		expect(args[0]).toBe("qorpera_prepare_email_draft_action");
		expect(args[1].p_content).toEqual(content);
		expect(args[1].p_capability_sha256).toMatch(/^[a-f0-9]{64}$/);
		const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(request[0]).toBe(`https://broker.example.com/v1/email-drafts/${actionId}?company=${companyId}`);
		expect(Object.keys(JSON.parse(String(request[1].body))).sort()).toEqual(["capability", "schema"]);
		expect(request[1]).toMatchObject({ redirect: "error", credentials: "omit" });
		expect(sessionStorage.length).toBe(0);
	});
	it("replays the same request after losing the response and reloading, never altered content", async () => {
		const f = fixture();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockRejectedValueOnce(new TypeError("network lost"))
				.mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, status: "sent", actionId }))),
		);
		await expect(f.client.act(session, interaction, "send", content)).rejects.toThrow("network lost");
		const before = f.rpc.mock.calls[0];
		const reopened = new EmailDraftClient(f.cloud, "member-one", f.controller.signal);
		expect((await reopened.read(session, interaction)).status).toBe("sent");
		expect(f.rpc.mock.calls[2]).toEqual(before);
	});
	it("coalesces simultaneous clicks and leaves unknown outcomes unresolved", async () => {
		const f = fixture();
		const fetch = vi.fn(async () => new Response(JSON.stringify({ ...receipt, status: "unconfirmed", actionId })));
		vi.stubGlobal("fetch", fetch);
		const results = await Promise.all([
			f.client.act(session, interaction, "send", content),
			f.client.act(session, interaction, "send", content),
		]);
		expect(results.every((result) => result.status === "unconfirmed")).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sessionStorage.length).toBe(1);
	});
	it.each(["save", "discard"] as const)(
		"does not substitute an unresolved %s for a new click or edited letter",
		async (action) => {
			const f = fixture();
			const fetch = vi
				.fn()
				.mockRejectedValueOnce(new TypeError("response lost"))
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({ ...receipt, status: action === "save" ? "saved" : "discarded", actionId }),
					),
				);
			vi.stubGlobal("fetch", fetch);
			await expect(f.client.act(session, interaction, action, content)).rejects.toThrow("response lost");
			const edited = { ...content, to: ["corrected@example.com"], body: "The revised letter" };
			await expect(f.client.act(session, interaction, "send", edited)).rejects.toThrow("Refresh to confirm");
			await expect(f.client.act(session, interaction, action, edited)).rejects.toThrow("Refresh to confirm");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(f.rpc).toHaveBeenCalledTimes(1);
			expect(sessionStorage.length).toBe(1);
			const recovered = await f.client.read(session, interaction);
			expect(recovered.status).toBe(action === "save" ? "saved" : "discarded");
			expect(f.rpc.mock.calls[2]).toEqual(f.rpc.mock.calls[0]);
			expect(sessionStorage.length).toBe(0);
		},
	);
	it("does not reuse another member's recovery capability", async () => {
		const f = fixture();
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
		await expect(f.client.act(session, interaction, "save", content)).rejects.toThrow();
		const other = new EmailDraftClient(f.cloud, "member-two", f.controller.signal);
		expect((await other.read(session, interaction)).status).toBe("ready");
		expect(f.rpc).toHaveBeenCalledTimes(2);
	});
	it("drops only definite rejected admission so corrected requests can proceed", async () => {
		const f = fixture();
		f.rpc.mockRejectedValueOnce(new CloudRpcError("prepare", { code: "22023", message: "Invalid recipient" }));
		await expect(f.client.act(session, interaction, "send", content)).rejects.toThrow("Invalid recipient");
		expect(sessionStorage.length).toBe(0);
	});
	it("drops a stale recovery ticket when another tab has advanced the durable action", async () => {
		const f = fixture();
		const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
		vi.stubGlobal("fetch", fetch);
		await expect(f.client.act(session, interaction, "save", content)).rejects.toThrow();
		f.rpc.mockResolvedValueOnce({ ...receipt, status: "saved", actionId: "55555555-5555-4555-8555-555555555555" });
		expect((await f.client.read(session, interaction)).status).toBe("saved");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sessionStorage.length).toBe(0);
	});
	it("refuses a ticket for a different click before contacting the broker", async () => {
		const f = fixture();
		f.rpc.mockResolvedValueOnce({
			...receipt,
			actionId: "55555555-5555-4555-8555-555555555555",
			brokerOrigin: "https://broker.example.com",
		});
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(f.client.act(session, interaction, "send", content)).rejects.toThrow("response is invalid");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("rejects an unsafe broker origin and never treats arbitrary JSON as a sent receipt", () => {
		for (const brokerOrigin of [
			"http://broker.example.com",
			"https://user:pass@broker.example.com",
			"https://broker.example.com/path",
		])
			expect(() => parseEmailDraftState({ ...receipt, brokerOrigin })).toThrow();
		expect(() => parseEmailDraftState({ status: "sent" })).toThrow();
	});
});
