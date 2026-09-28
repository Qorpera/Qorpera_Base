// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { catalogResponse, usageResponse } from "./computer-billing-fixtures.ts";
import { deferred, fixture, profileA, session, settle, userB } from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function draw() {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}
async function setup() {
	const env = fixture(),
		root = document.createElement("div");
	document.body.append(root);
	vi.mocked(env.cloud.rpc).mockImplementation(async (name) => {
		if (name === "qorpera_list_review_rules")
			return { schema: "qorpera.review-rules/v1", canManageCompanyRules: true, rules: [] } as never;
		return (name === "qorpera_computer_plan_catalog" ? catalogResponse() : usageResponse()) as never;
	});
	dispose = mountApplication(root, env.cloud, env.api);
	await draw();
	root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
	root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
	await draw();
	// General may read company rules; Plan must still perform only its two authoritative reads.
	expect(vi.mocked(env.cloud.rpc).mock.calls.every(([name]) => name === "qorpera_list_review_rules")).toBe(true);
	vi.mocked(env.cloud.rpc).mockClear();
	root.querySelector<HTMLButtonElement>("#settings-tab-plan")!.click();
	await draw();
	return { ...env, root };
}
describe("settings computer billing", () => {
	it("loads member allowance and refreshes authoritative status without a payment mutation", async () => {
		const env = await setup();
		expect(env.root.querySelector(".settings-hours strong")?.textContent).toBe("71 standard hours available");
		expect(vi.mocked(env.cloud.rpc).mock.calls.map(([name]) => name)).toEqual([
			"qorpera_computer_plan_catalog",
			"qorpera_my_computer_usage",
		]);
		const usage = usageResponse();
		usage.balance.availableUs = "3600000000";
		vi.mocked(env.cloud.rpc).mockImplementation(
			async (name) => (name === "qorpera_computer_plan_catalog" ? catalogResponse() : usage) as never,
		);
		[...env.root.querySelectorAll("button")].find((button) => button.textContent === "Refresh plan status")!.click();
		await draw();
		expect(env.root.querySelector(".settings-hours strong")?.textContent).toBe("1 standard hours available");
		expect(vi.mocked(env.cloud.rpc).mock.calls.map(([name]) => name)).toEqual([
			"qorpera_computer_plan_catalog",
			"qorpera_my_computer_usage",
			"qorpera_computer_plan_catalog",
			"qorpera_my_computer_usage",
		]);
	}, 15000);
	it("removes paid balances on account switch before an old refresh completes", async () => {
		const env = await setup();
		expect(env.root.textContent).toContain("71 standard hours available");
		const reply = deferred<never>();
		vi.mocked(env.cloud.rpc).mockReturnValueOnce(reply.promise);
		[...env.root.querySelectorAll("button")].find((button) => button.textContent === "Refresh plan status")!.click();
		env.auth(userB);
		// Store notifications are coalesced into the next microtask, before paint.
		await settle();
		expect(env.root.querySelector(".settings-overlay")).toBeNull();
		expect(env.root.textContent).not.toContain("71 standard hours available");
		reply.resolve(catalogResponse() as never);
		await draw();
		expect(env.root.querySelector(".settings-overlay")).toBeNull();
	}, 15000);
});
