// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { answersInteraction } from "../src/app/company.ts";
import type { InteractionRequest } from "../src/cloud/interactions.ts";
import type { HostedSession } from "../src/cloud/types.ts";
import { renderInteractionCard } from "../src/ui/interaction-card.ts";
import { session, userA, userB } from "./fixtures.ts";

const ID = "44444444-4444-4444-8444-000000000593";
const MEMBER = "22222222-2222-4222-8222-222222222222";

function context(overrides: Partial<Parameters<typeof renderInteractionCard>[1]> = {}) {
	return {
		agentName: "Yang Tang",
		memberName: () => "Jonas",
		canAnswer: true,
		answer: vi.fn(async () => {}),
		...overrides,
	};
}

const question: InteractionRequest = {
	surface: "question",
	title: "Which channel should the digest go to?",
	payload: {
		options: [
			{ label: "#general", value: "general" },
			{ label: "#finance", value: "finance", style: "primary" },
		],
	},
};

function item(request: InteractionRequest, answer?: Parameters<typeof renderInteractionCard>[0]["answer"]) {
	return { id: ID, actorUserId: MEMBER, request, createdAt: "2026-09-22T20:00:00Z", ...(answer ? { answer } : {}) };
}

describe("interaction cards", () => {
	it("renders a question's options as pills and answers with the chosen value", async () => {
		const ctx = context();
		const card = renderInteractionCard(item(question), ctx);
		expect(card.dataset.state).toBe("waiting");
		expect(card.textContent).toContain("Waiting for you");
		const pills = [...card.querySelectorAll<HTMLButtonElement>(".interaction-options .btn")];
		expect(pills.map((pill) => pill.textContent)).toEqual(["#general", "#finance"]);
		expect(pills[1]?.classList.contains("interaction-primary")).toBe(true);
		pills[1]?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["finance"] });
		// While the answer is on its way every control is held.
		expect(pills[0]?.getAttribute("aria-disabled")).toBe("true");
		await Promise.resolve();
	});

	it("skips a question as declined and never sends free text unless the card allows it", () => {
		const ctx = context();
		const card = renderInteractionCard(item(question), ctx);
		expect(card.querySelector(".interaction-field")).toBeNull();
		card.querySelector<HTMLButtonElement>(".interaction-quiet")?.click();
		expect(ctx.answer).toHaveBeenCalledWith("declined", {});
	});

	it("collects several choices for a multi-select question and sends them together", () => {
		const ctx = context();
		const card = renderInteractionCard(
			item({ ...question, payload: { ...question.payload, multiSelect: true, allowCustom: true } }),
			ctx,
		);
		const pills = [...card.querySelectorAll<HTMLButtonElement>(".interaction-options .btn")];
		pills[0]?.click();
		pills[1]?.click();
		pills[0]?.click();
		expect(ctx.answer).not.toHaveBeenCalled();
		expect(pills[0]?.getAttribute("aria-pressed")).toBe("false");
		expect(pills[1]?.getAttribute("aria-pressed")).toBe("true");
		expect(card.querySelector(".interaction-field")).not.toBeNull();
		[...card.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")]
			.find((pill) => pill.textContent === "Send")
			?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["finance"] });
	});

	it("shows an answered card inert with the chosen label, who answered, and a queued mark", () => {
		const ctx = context();
		const card = renderInteractionCard(
			item(question, {
				outcome: "answered",
				answer: { values: ["finance"] },
				answeredBy: MEMBER,
				answeredAt: "2026-09-22T20:05:00Z",
				pending: true,
			}),
			ctx,
		);
		expect(card.dataset.state).toBe("answered");
		expect(card.querySelector(".interaction-chosen")?.textContent).toBe("#finance");
		expect(card.querySelector(".interaction-attribution")?.textContent).toContain("Jonas");
		expect(card.querySelector(".interaction-attribution")?.textContent).toContain("Sending");
		expect(card.querySelector("button")).toBeNull();
	});

	it("shows a takeover with Take over, I'm done and Skip, and hands back or dismisses", () => {
		const takeOver = vi.fn();
		const ctx = context({ takeOver });
		const card = renderInteractionCard(
			item({
				surface: "takeover",
				title: "Computer",
				payload: { instruction: "Finish the sign-in.", reason: "sign_in" },
			}),
			ctx,
		);
		const labels = [...card.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(labels.map((pill) => pill.textContent)).toEqual(["Take over", "I'm done", "Skip"]);
		labels[0]?.click();
		expect(takeOver).toHaveBeenCalledTimes(1);
		expect(ctx.answer).not.toHaveBeenCalled();
		labels[1]?.click();
		expect(ctx.answer).toHaveBeenCalledWith("handed_back", {});
	});

	it("saves a secret through the vault path, never through the answer, and only declines without it", async () => {
		const secret = item({
			surface: "secret",
			title: "Connect Slack",
			body: "To post daily digests to your Slack workspace, provide a bot token.",
			payload: { name: "slack-bot-token", label: "Slack bot token", purpose: "Posting the digest." },
		});
		const provideSecret = vi.fn(async () => {});
		const ctx = context({ provideSecret });
		const card = renderInteractionCard(secret, ctx);
		const field = card.querySelector<HTMLInputElement>("input.interaction-secret");
		expect(field?.type).toBe("password");
		expect(field?.autocomplete).toBe("off");
		expect(card.textContent).toContain("company vault");
		const save = [...card.querySelectorAll<HTMLButtonElement>(".btn")].find(
			(pill) => pill.textContent === "Save securely",
		);
		save?.click();
		expect(provideSecret).not.toHaveBeenCalled();
		field!.value = "xoxb-secret";
		save?.click();
		expect(provideSecret).toHaveBeenCalledWith("xoxb-secret");
		expect(ctx.answer).not.toHaveBeenCalled();
		await Promise.resolve();
		// Without a vault path the card can only be declined.
		const readOnly = renderInteractionCard(secret, context());
		expect(readOnly.querySelector("input")).toBeNull();
		expect(readOnly.textContent).toContain("Saving a secret to the company vault is unavailable here.");
		expect(readOnly.textContent).not.toContain("newer version");
		const pills = [...readOnly.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(pills.map((pill) => pill.textContent)).toEqual(["Decline"]);
	});

	it("starts a connect card's sign-in for who may connect, and lets anyone who answers say it is connected", async () => {
		const connectCard = item({
			surface: "connect",
			title: "Connect Gmail",
			payload: { connectorId: "gmail", purpose: "Reading the invoices in the inbox." },
		});
		const connect = vi.fn(async () => {});
		const ctx = context({ connect });
		const card = renderInteractionCard(connectCard, ctx);
		expect(card.dataset.state).toBe("waiting");
		expect(card.getAttribute("aria-label")).toBe("Connection from Yang Tang: Connect Gmail");
		expect(card.textContent).toContain("Reading the invoices in the inbox.");
		expect(card.textContent).toContain("The sign-in ends in Company connections.");
		const pills = [...card.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(pills.map((pill) => pill.textContent)).toEqual(["Connect Gmail", "It's connected", "Skip"]);
		expect(pills[0]?.classList.contains("interaction-primary")).toBe(true);
		pills[0]?.click();
		expect(connect).toHaveBeenCalledTimes(1);
		// The sign-in is not an answer; while it starts every control is held.
		expect(ctx.answer).not.toHaveBeenCalled();
		expect(pills[1]?.getAttribute("aria-disabled")).toBe("true");
		pills[1]?.click();
		expect(ctx.answer).not.toHaveBeenCalled();

		// A sign-in that could not start opens the card again.
		const failing = context({
			connect: vi.fn(async () => {
				throw new Error("no ticket");
			}),
		});
		const again = renderInteractionCard(connectCard, failing);
		again.querySelector<HTMLButtonElement>(".interaction-primary")?.click();
		await Promise.resolve();
		await Promise.resolve();
		const controls = [...again.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(controls.some((control) => control.hasAttribute("aria-disabled"))).toBe(false);
		controls[1]?.click();
		expect(failing.answer).toHaveBeenCalledWith("connected", {});

		// A member who cannot connect is told who can, and may still say it is connected, or skip.
		const member = context();
		const plain = renderInteractionCard(connectCard, member);
		expect(plain.textContent).toContain("Only founders and admins can connect Gmail.");
		const offered = [...plain.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(offered.map((pill) => pill.textContent)).toEqual(["It's connected", "Skip"]);
		expect(offered[0]?.classList.contains("interaction-primary")).toBe(true);
		offered[1]?.click();
		expect(member.answer).toHaveBeenCalledWith("declined", {});
		await Promise.resolve();
	});

	it("shows an answered or skipped connect card inert", () => {
		const request: InteractionRequest = {
			surface: "connect",
			title: "Connect Google Drive",
			payload: { connectorId: "google_drive", purpose: "Filing the invoices." },
		};
		const connected = renderInteractionCard(
			item(request, { outcome: "connected", answer: {}, answeredBy: MEMBER, answeredAt: "2026-09-22T20:05:00Z" }),
			context({ connect: vi.fn(async () => {}) }),
		);
		expect(connected.dataset.state).toBe("answered");
		expect(connected.querySelector(".interaction-chosen")?.textContent).toBe("Connected");
		expect(connected.querySelector("button")).toBeNull();
		const skipped = renderInteractionCard(item(request, { outcome: "declined", answer: {} }), context());
		expect(skipped.dataset.state).toBe("declined");
		expect(skipped.querySelector(".interaction-result")?.textContent).toBe("Declined");
		expect(skipped.querySelector("button")).toBeNull();
		// A member who does not answer it sees the card, with no controls.
		const readOnly = renderInteractionCard(item(request), context({ canAnswer: false }));
		expect(readOnly.querySelector("button")).toBeNull();
	});

	it("keeps historical form cards skippable without suggesting that fields can be filled", () => {
		const request: InteractionRequest = {
			surface: "form",
			title: "Delivery address",
			payload: { domain: "shop.example", fields: [{ name: "address", label: "Address", type: "text" }] },
		};
		const ctx = context();
		const card = renderInteractionCard(item(request), ctx);
		expect(card.textContent).toContain("Website: shop.example");
		expect(card.textContent).toContain("Filling a webpage through this card is unavailable.");
		expect(card.textContent).not.toContain("Filled on the computer");
		expect(card.textContent).not.toContain("newer version");
		expect(card.querySelector("input, select, textarea")).toBeNull();
		const actions = [...card.querySelectorAll<HTMLButtonElement>("button")];
		expect(actions.map((action) => action.textContent)).toEqual(["Skip"]);
		actions[0]?.click();
		expect(ctx.answer).toHaveBeenCalledWith("declined", {});

		const readOnly = renderInteractionCard(item(request), context({ canAnswer: false }));
		expect(readOnly.textContent).toContain("Filling a webpage through this card is unavailable.");
		expect(readOnly.querySelector("button, input")).toBeNull();
		const declined = renderInteractionCard(item(request, { outcome: "declined", answer: {} }), context());
		expect(declined.dataset.state).toBe("declined");
		expect(declined.querySelector(".interaction-result")?.textContent).toBe("Declined");
		expect(declined.querySelector("button, input")).toBeNull();
	});

	it.each(["accounts.example", undefined])(
		"renders historical credential cards without claiming a sign-in occurred (domain: %s)",
		(domain) => {
			const ctx = context();
			const card = renderInteractionCard(
				item({ surface: "credential", title: "Company account", payload: domain ? { domain } : {} }),
				ctx,
			);
			expect(card.textContent).toContain(
				domain
					? "Signing in to accounts.example through this card is unavailable."
					: "Signing in through this card is unavailable.",
			);
			expect(card.textContent).not.toContain("Nothing to do here");
			expect(card.querySelector("button, input")).toBeNull();
			expect(ctx.answer).not.toHaveBeenCalled();
		},
	);

	it("shows an expired card without controls and a read-only card for another member", () => {
		const expired = renderInteractionCard(
			item({ ...question, expiresAt: "2026-09-21T00:00:00Z" }),
			context({ now: Date.parse("2026-09-22T00:00:00Z") }),
		);
		expect(expired.dataset.state).toBe("expired");
		expect(expired.querySelector("button")).toBeNull();
		const readOnly = renderInteractionCard(item(question), context({ canAnswer: false }));
		expect(readOnly.dataset.state).toBe("waiting");
		expect(readOnly.querySelector("button")).toBeNull();
	});

	it("says an answer did not reach the agent and asks again, with its controls live", () => {
		const card = renderInteractionCard({ ...item(question), answerFailed: true }, context());
		expect(card.dataset.state).toBe("waiting");
		expect(card.textContent).toContain("Your answer did not reach the agent. Answer again.");
		expect(card.querySelectorAll(".interaction-options .btn")).toHaveLength(2);
		const plain = renderInteractionCard(item(question), context());
		expect(plain.textContent).not.toContain("did not reach");
		// Only the member who answers is asked to answer again.
		const other = renderInteractionCard({ ...item(question), answerFailed: true }, context({ canAnswer: false }));
		expect(other.textContent).not.toContain("did not reach");
	});
});

describe("who answers a card", () => {
	const thread: HostedSession = {
		...session,
		staffAgentId: "33333333-3333-4333-8333-333333333333",
		executionScope: { roomId: "55555555-5555-4555-8555-555555555555", agentThread: true },
	};
	it("in an agent's shared thread, is the member the card was raised for, not the thread's creator", () => {
		expect(thread.createdByUserId).toBe(userA.id);
		expect(answersInteraction(thread, userB.id, userB.id)).toBe(true);
		expect(answersInteraction(thread, userB.id, userA.id)).toBe(false);
		expect(answersInteraction({ ...thread, status: "closed" }, userB.id, userB.id)).toBe(false);
	});
	it("elsewhere, is the member the conversation belongs to", () => {
		expect(answersInteraction(session, userB.id, userA.id)).toBe(true);
		expect(answersInteraction(session, userB.id, userB.id)).toBe(false);
		const own: HostedSession = { ...session, audience: { kind: "member_private", userId: userB.id } };
		expect(answersInteraction(own, userA.id, userB.id)).toBe(true);
		expect(answersInteraction(own, userA.id, userA.id)).toBe(false);
	});
	it("in a group chat, is nobody: an answer there reaches no single agent", () => {
		const group: HostedSession = { ...session, executionScope: { roomId: "55555555-5555-4555-8555-555555555556" } };
		expect(answersInteraction(group, userA.id, userA.id)).toBe(false);
	});
});
