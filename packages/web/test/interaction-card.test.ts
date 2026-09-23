// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { InteractionRequest } from "../src/cloud/interactions.ts";
import { renderInteractionCard } from "../src/ui/interaction-card.ts";

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

	it("never offers a field for a secret and only lets the member decline", () => {
		const ctx = context();
		const card = renderInteractionCard(
			item({
				surface: "secret",
				title: "Connect Slack",
				body: "To post daily digests to your Slack workspace, provide a bot token.",
				payload: { name: "slack-bot-token", label: "Slack bot token", purpose: "Posting the digest." },
			}),
			ctx,
		);
		expect(card.querySelector("input")).toBeNull();
		expect(card.textContent).toContain("company vault");
		const pills = [...card.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(pills.map((pill) => pill.textContent)).toEqual(["Decline"]);
		pills[0]?.click();
		expect(ctx.answer).toHaveBeenCalledWith("declined", {});
	});

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
});
