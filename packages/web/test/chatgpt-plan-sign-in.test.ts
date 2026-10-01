// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	type ChatGptPlanSignIn,
	keepChatGptPlanSignIn,
	takeChatGptPlanReturn,
} from "../src/cloud/chatgpt-plan-sign-in.ts";
import { id, profileA } from "./fixtures.ts";

const capability = "a".repeat(43);
const confirmation = "b".repeat(43);
const signIn = (startedAt = Date.now()): ChatGptPlanSignIn => ({
	companyId: profileA.profileId,
	loginId: id(1),
	clientConnectionId: id(2),
	capability,
	expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
	startedAt,
});
const stored = () => sessionStorage.getItem("qorpera.chatgpt-plan-sign-in.v1");
afterEach(() => {
	sessionStorage.clear();
	history.replaceState(null, "", "/#/");
});

describe("Continue with ChatGPT: the return trip", () => {
	it("leaves a page without a plan outcome alone", () => {
		history.replaceState(null, "", "/#/c/x?connector=gmail&connection=confirm");
		expect(takeChatGptPlanReturn()).toBeUndefined();
		expect(location.hash).toBe("#/c/x?connector=gmail&connection=confirm");
	});
	it("takes a confirmation for this tab's sign-in and goes to its company", () => {
		keepChatGptPlanSignIn(signIn());
		history.replaceState(null, "", `/#?chatgpt_plan=confirm&confirmation=${confirmation}`);
		expect(takeChatGptPlanReturn()).toMatchObject({
			outcome: "confirm",
			confirmation,
			signIn: { companyId: profileA.profileId, loginId: id(1), clientConnectionId: id(2), capability },
		});
		expect(location.hash).toBe(`#/c/${profileA.profileId}`);
		// The capability stays until the confirm call, which drops it.
		expect(stored()).not.toBeNull();
	});
	it("keeps a company route the return page already had", () => {
		keepChatGptPlanSignIn(signIn());
		history.replaceState(
			null,
			"",
			`/#/c/${profileA.profileId}/chat?chatgpt_plan=confirm&confirmation=${confirmation}`,
		);
		expect(takeChatGptPlanReturn()?.outcome).toBe("confirm");
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat`);
	});
	it("takes a failure with its reason, and forgets the sign-in", () => {
		keepChatGptPlanSignIn(signIn());
		history.replaceState(null, "", "/#?chatgpt_plan=failed&reason=declined");
		expect(takeChatGptPlanReturn()).toMatchObject({ outcome: "failed", reason: "declined" });
		expect(stored()).toBeNull();
	});
	it("ignores a crafted link, a stale sign-in and a malformed confirmation, and strips them", () => {
		for (const [kept, hash] of [
			[undefined, `/#?chatgpt_plan=confirm&confirmation=${confirmation}`],
			[signIn(Date.now() - 16 * 60_000), `/#?chatgpt_plan=confirm&confirmation=${confirmation}`],
			[signIn(), "/#?chatgpt_plan=confirm&confirmation=short"],
		] as const) {
			if (kept) keepChatGptPlanSignIn(kept);
			history.replaceState(null, "", hash);
			expect(takeChatGptPlanReturn()).toBeUndefined();
			expect(location.hash).not.toContain("chatgpt_plan");
			expect(stored()).toBeNull();
		}
	});
});
