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

	it("says where a coding value goes, as this member's save makes it, instead of saying the agent never sees it", () => {
		const coding = (payload: Record<string, unknown>, savesForCompany = true) =>
			renderInteractionCard(
				item({
					surface: "secret",
					title: "Token for private packages",
					payload: {
						name: "npm_token",
						label: "NPM_TOKEN",
						purpose: "Installs the private packages.",
						connectorId: "environment",
						...payload,
					},
				}),
				context({ provideSecret: vi.fn(async () => {}), savesForCompany }),
			).textContent;
		// An owner or admin: the company's value, for the card's repository.
		expect(coding({ repository: "acme/web" })).toContain(
			"Coding sessions in acme/web get it as NPM_TOKEN; it never shows in the chat.",
		);
		// A contributor on the same card saves their own, which every repository's sessions of theirs get: it says so.
		const own =
			"Saved as your own in the company vault: your coding sessions in every repository get it as NPM_TOKEN.";
		expect(coding({ repository: "acme/web" }, false)).toContain(own);
		expect(coding({ repository: "acme/web" }, false)).not.toContain("Coding sessions in acme/web");
		expect(coding({}, false)).toContain(own);
		expect(coding({})).not.toContain("The agent never sees the value");
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

	it("says a member stopped the work behind an open card, which stays answerable", () => {
		const card = renderInteractionCard({ ...item(question), chainStopped: true }, context());
		expect(card.dataset.state).toBe("waiting");
		expect(card.textContent).toContain(
			"A member stopped the work that raised this card. Answering it starts new work.",
		);
		expect(card.querySelectorAll(".interaction-options .btn")).toHaveLength(2);
		// Whoever cannot answer reads only that the work was stopped.
		const other = renderInteractionCard({ ...item(question), chainStopped: true }, context({ canAnswer: false }));
		expect(other.textContent).toContain("A member stopped the work that raised this card.");
		expect(other.textContent).not.toContain("Answering it");
		// An answered card shows its answer, not the note.
		const answered = renderInteractionCard(
			{
				...item(question, { outcome: "answered", answer: { values: ["general"] }, answeredBy: MEMBER }),
				chainStopped: true,
			},
			context(),
		);
		expect(answered.textContent).not.toContain("stopped");
	});
});

describe("a visual choice", () => {
	const visual: InteractionRequest = {
		surface: "question",
		title: "Which bundle first?",
		payload: {
			options: [
				{ label: "Colour Duo", value: "duo", description: "Charcoal and blue", preview: "sketches/duo.svg" },
				{ label: "Matching Pair", value: "pair", preview: "sketches/pair.svg" },
				{ label: "The demo", value: "demo", preview: "app:bundle-demo" },
			],
		},
	};

	it("shows options with pictures as big boxes; a click picks one", async () => {
		const image = vi.fn(async (path: string) => new Blob([path], { type: "image/svg+xml" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:shown");
		const ctx = context({ image });
		const card = renderInteractionCard(item(visual), ctx);
		const boxes = [...card.querySelectorAll<HTMLButtonElement>(".choice-box")];
		expect(boxes.map((box) => box.querySelector(".choice-label")?.textContent)).toEqual([
			"Colour Duo",
			"Matching Pair",
			"The demo",
		]);
		expect(boxes[0]?.querySelector(".choice-description")?.textContent).toBe("Charcoal and blue");
		// No pill row beside the boxes.
		expect(card.querySelector(".interaction-options")).toBeNull();
		await vi.waitFor(() => expect(card.querySelectorAll(".choice-picture img")).toHaveLength(2));
		expect(image.mock.calls.map(([path]) => path)).toEqual(["sketches/duo.svg", "sketches/pair.svg"]);
		// An app's option shows its name, and its link opens the app's own page.
		expect(boxes[2]?.querySelector(".choice-app-name")?.textContent).toBe("bundle-demo");
		expect(card.querySelector(".choice-apps .app-card")).not.toBeNull();
		boxes[1]?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["pair"] });
		created.mockRestore();
	});

	it("lays three boxes out in three columns, set through the style object, and toggles them for a multi-select", () => {
		const ctx = context({ image: async () => null });
		const card = renderInteractionCard(item({ ...visual, payload: { ...visual.payload, multiSelect: true } }), ctx);
		expect((card.querySelector(".interaction-choices") as HTMLElement).style.getPropertyValue("--choices")).toBe("3");
		const boxes = [...card.querySelectorAll<HTMLButtonElement>(".choice-box")];
		expect(boxes.map((box) => box.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
		boxes[0]?.click();
		boxes[2]?.click();
		expect(boxes.map((box) => box.getAttribute("aria-pressed"))).toEqual(["true", "false", "true"]);
		[...card.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Send")?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["duo", "demo"] });
	});

	it("keeps the boxes, inert, with the chosen one marked once answered", () => {
		const card = renderInteractionCard(
			item(visual, { outcome: "answered", answer: { values: ["duo"] }, answeredBy: userA.id }),
			context({ image: async () => null }),
		);
		const boxes = [...card.querySelectorAll<HTMLButtonElement>(".choice-box")];
		expect(boxes.every((box) => box.disabled)).toBe(true);
		expect(boxes.map((box) => box.classList.contains("is-chosen"))).toEqual([true, false, false]);
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

	it("draws a card's body as Markdown, with its lines, list and folder link", () => {
		const card = renderInteractionCard(
			item({
				...question,
				title: "Approve the draft vision?",
				body: "We sell sports wristbands to Danish clubs.\n- Price: 89 kr\n- First test: 200 bands\n[Read the draft](folder:QorperaOS/vision/vision.md)",
			}),
			context(),
		);
		const body = card.querySelector(".interaction-body") as HTMLElement;
		expect(body.querySelectorAll("li")).toHaveLength(2);
		// The link under the bullets is a line of its own, not part of the last bullet.
		expect(body.querySelector("li:last-child button.folder-link")).toBeNull();
		expect(body.querySelector("button.folder-link")?.getAttribute("data-folder-path")).toBe(
			"QorperaOS/vision/vision.md",
		);
		expect(body.classList.contains("is-folded")).toBe(false);
		expect(card.querySelector(".card-more")).toBeNull();
	});

	it("folds a body past about four lines behind Show more, and opens it", () => {
		const long =
			"Ambition: the go-to wristband for Danish sports clubs. Product: printed silicone bands in club colours. Promise: delivered in a week. Limits: no custom shapes in the first year. Price: 89 kr a band, 69 kr from 100. Not yet checked: supplier prices and the delivery time. Approval agrees the draft direction only. It does not authorize spending or lift any recorded restriction.";
		const card = renderInteractionCard(item({ ...question, body: long }), context());
		const body = card.querySelector(".interaction-body") as HTMLElement;
		const more = card.querySelector(".card-more") as HTMLButtonElement;
		expect(body.classList.contains("is-folded")).toBe(true);
		expect(more.textContent).toBe("Show more");
		expect(more.getAttribute("aria-expanded")).toBe("false");
		more.click();
		expect(body.classList.contains("is-folded")).toBe(false);
		expect(more.textContent).toBe("Show less");
		expect(more.getAttribute("aria-expanded")).toBe("true");
		more.click();
		expect(body.classList.contains("is-folded")).toBe(true);
		expect(more.getAttribute("aria-controls")).toBe(body.id);
		// Opened, it stays open when the card is drawn again (an answer on its way, a change of language).
		more.click();
		const again = renderInteractionCard(item({ ...question, body: long }), context());
		expect(again.querySelector(".interaction-body")?.classList.contains("is-folded")).toBe(false);
		expect(again.querySelector(".card-more")?.textContent).toBe("Show less");
	});

	it("shows whole the five short lines and link a card may have, and keeps a fenced code block as written", () => {
		const five =
			"Wristbands in club colours for Danish sports clubs, ordered in five minutes, delivered in a week.\nOur promise: a fair price and no minimum order.\n- 89 kr a band, 69 kr from 100\n- First goal: 200 bands sold by December\n[Read the whole draft](folder:strategy/vision-draft-for-the-founders.md)";
		const card = renderInteractionCard(item({ ...question, body: five }), context());
		expect(card.querySelector(".interaction-body")?.classList.contains("is-folded")).toBe(false);
		expect(card.querySelector(".card-more")).toBeNull();
		const code = renderInteractionCard(item({ ...question, body: "```\n- a\nb\n```" }), context());
		expect(code.querySelector("pre")?.textContent).toBe("- a\nb");
	});
});
