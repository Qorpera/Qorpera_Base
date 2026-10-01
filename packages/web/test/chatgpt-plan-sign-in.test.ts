// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChatGptPlanSignIn,
	keepChatGptPlanSignIn,
	takeChatGptPlanReturn,
} from "../src/cloud/chatgpt-plan-sign-in.ts";
import { id, profileA, session, userA } from "./fixtures.ts";

const capability = "a".repeat(43);
const confirmation = "b".repeat(43);
const chat = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
const signIn = (startedAt = Date.now()): Omit<ChatGptPlanSignIn, "returnRoute"> => ({
	companyId: profileA.profileId,
	memberId: userA.id,
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
	vi.restoreAllMocks();
});

describe("Continue with ChatGPT: the return trip", () => {
	it("leaves a page without a plan outcome alone", () => {
		keepChatGptPlanSignIn(signIn(), chat);
		history.replaceState(null, "", "/#/c/x?connector=gmail&connection=confirm");
		expect(takeChatGptPlanReturn()).toBeUndefined();
		expect(location.hash).toBe("#/c/x?connector=gmail&connection=confirm");
		expect(stored()).not.toBeNull();
	});
	it("takes a confirmation for this tab's sign-in and goes back to the page it began on", () => {
		expect(keepChatGptPlanSignIn(signIn(), chat)).toBe(true);
		history.replaceState(null, "", `/#?chatgpt_plan=confirm&confirmation=${confirmation}`);
		expect(takeChatGptPlanReturn()).toMatchObject({
			outcome: "confirm",
			confirmation,
			signIn: { companyId: profileA.profileId, memberId: userA.id, loginId: id(1), capability, returnRoute: chat },
		});
		expect(location.hash).toBe(chat);
		// The capability stays until the confirm, which drops it first.
		expect(stored()).not.toBeNull();
	});
	it("goes to the company's home when the sign-in began elsewhere", () => {
		for (const route of ["#/", `#/c/${id(9)}/chat/${session.sessionId}`, `${chat}?chatgpt_plan=confirm`, "#/c/x"]) {
			keepChatGptPlanSignIn(signIn(), route);
			history.replaceState(null, "", `/#?chatgpt_plan=confirm&confirmation=${confirmation}`);
			expect(takeChatGptPlanReturn()?.signIn.returnRoute).toBe(`#/c/${profileA.profileId}`);
			expect(location.hash).toBe(`#/c/${profileA.profileId}`);
		}
	});
	it("keeps a route of the sign-in's company that the return page already had", () => {
		keepChatGptPlanSignIn(signIn(), chat);
		history.replaceState(
			null,
			"",
			`/#/c/${profileA.profileId}/file?chatgpt_plan=confirm&confirmation=${confirmation}`,
		);
		expect(takeChatGptPlanReturn()?.outcome).toBe("confirm");
		expect(location.hash).toBe(`#/c/${profileA.profileId}/file`);
	});
	it("takes a failure with its reason, and forgets the sign-in", () => {
		keepChatGptPlanSignIn(signIn(), chat);
		history.replaceState(null, "", "/#?chatgpt_plan=failed&reason=declined");
		expect(takeChatGptPlanReturn()).toMatchObject({ outcome: "failed", reason: "declined" });
		expect(location.hash).toBe(chat);
		expect(stored()).toBeNull();
	});
	it("reads a return after 15 minutes as too slow, on the page the sign-in began on", () => {
		keepChatGptPlanSignIn(signIn(Date.now() - 16 * 60_000), chat);
		history.replaceState(null, "", `/#?chatgpt_plan=confirm&confirmation=${confirmation}`);
		expect(takeChatGptPlanReturn()).toMatchObject({ outcome: "failed", reason: "expired" });
		expect(location.hash).toBe(chat);
		expect(stored()).toBeNull();
	});
	it("drops a sign-in kept too long, on any page", () => {
		keepChatGptPlanSignIn(signIn(Date.now() - 16 * 60_000), chat);
		history.replaceState(null, "", chat);
		expect(takeChatGptPlanReturn()).toBeUndefined();
		expect(stored()).toBeNull();
	});
	it("ignores a crafted link, a malformed confirmation and a kept sign-in of another shape, and strips them", () => {
		for (const [kept, hash] of [
			[undefined, `/#?chatgpt_plan=confirm&confirmation=${confirmation}`],
			[signIn(), "/#?chatgpt_plan=confirm&confirmation=short"],
			[{ ...signIn(), memberId: "someone" }, `/#?chatgpt_plan=confirm&confirmation=${confirmation}`],
		] as const) {
			if (kept) keepChatGptPlanSignIn(kept, chat);
			history.replaceState(null, "", hash);
			expect(takeChatGptPlanReturn()).toBeUndefined();
			expect(location.hash).not.toContain("chatgpt_plan");
			expect(stored()).toBeNull();
		}
	});
	it("ignores a kept sign-in whose page is not its company's", () => {
		for (const returnRoute of [`#/c/${id(9)}`, `${chat}?chatgpt_plan=confirm`, "https://example.com/"]) {
			sessionStorage.setItem("qorpera.chatgpt-plan-sign-in.v1", JSON.stringify({ ...signIn(), returnRoute }));
			history.replaceState(null, "", `/#?chatgpt_plan=confirm&confirmation=${confirmation}`);
			expect(takeChatGptPlanReturn()).toBeUndefined();
			expect(stored()).toBeNull();
		}
	});
	it("says when this tab cannot keep the sign-in", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		expect(keepChatGptPlanSignIn(signIn(), chat)).toBe(false);
	});
});
