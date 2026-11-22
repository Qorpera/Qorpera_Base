// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { answersInteraction } from "../src/app/company.ts";
import { type InteractionRequest, questionInput } from "../src/cloud/interactions.ts";
import type { HostedSession } from "../src/cloud/types.ts";
import { fmtTime } from "../src/ui/dom.ts";
import {
	disposeCardPictures,
	type InteractionCardApp,
	refreshAppPreviews,
	renderInteractionCard,
} from "../src/ui/interaction-card.ts";
import type { MailAddressCalls } from "../src/ui/mail-address.ts";
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

	it("says which round a question asked again is, and whose words led to it, while it waits", () => {
		const me = "11111111-1111-4111-8111-111111111111";
		const round = { number: 2, note: "Warmer, with more motion", by: me };
		const mine = renderInteractionCard(item(question), context({ round, viewerId: me }));
		expect(mine.querySelector(".interaction-round-number")?.textContent).toBe("Round 2");
		expect(mine.querySelector(".interaction-round-note")?.textContent).toBe("You said: “Warmer, with more motion”");
		expect(
			mine.querySelector(".interaction-round")?.nextElementSibling?.classList.contains("interaction-title"),
		).toBe(true);
		const theirs = renderInteractionCard(item(question), context({ round: { ...round, number: 3 } }));
		expect(theirs.querySelector(".interaction-round")?.textContent).toBe(
			"Round 3Jonas said: “Warmer, with more motion”",
		);
		const bare = renderInteractionCard(item(question), context({ round: { number: 2 } }));
		expect(bare.querySelector(".interaction-round")?.textContent).toBe("Round 2");
		expect(renderInteractionCard(item(question), context()).querySelector(".interaction-round")).toBeNull();
		const answered = renderInteractionCard(
			item(question, { outcome: "answered", answer: { values: ["general"] } }),
			context({ round }),
		);
		expect(answered.querySelector(".interaction-round")).toBeNull();
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

	it("shows a takeover with Open computer, I'm done and Skip, no Take over (Jonas, 14 Nov 2026), and opens, hands back or dismisses", () => {
		const openComputer = vi.fn();
		const ctx = context({ openComputer });
		const card = renderInteractionCard(
			item({
				surface: "takeover",
				title: "Computer",
				payload: { instruction: "Finish the sign-in.", reason: "sign_in" },
			}),
			ctx,
		);
		const labels = [...card.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")];
		expect(labels.map((pill) => pill.textContent)).toEqual(["Open computer", "I'm done", "Skip"]);
		labels[0]?.click();
		expect(openComputer).toHaveBeenCalledTimes(1);
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
		// Skip was pressed: the card says so, not "Declined".
		expect(declined.querySelector(".interaction-result")?.textContent).toBe("Skipped");
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

describe("a card with its answer, in a thread", () => {
	const VIEWER = MEMBER;
	const OTHER = "33333333-3333-4333-8333-333333333333";
	const thread = (overrides: Partial<Parameters<typeof renderInteractionCard>[1]> = {}) =>
		context({
			inThread: true,
			viewerId: VIEWER,
			memberName: (userId) => (userId === VIEWER ? "You" : "Sofie"),
			...overrides,
		});
	const answered = {
		outcome: "answered" as const,
		answer: { values: ["finance"] },
		answeredAt: "2026-09-22T20:05:00Z",
	};
	const classes = (element: Element | null | undefined) => [...(element?.classList ?? [])];

	it("is the exchange it was: the agent's bubble, then the member's own answer as their bubble", () => {
		const card = renderInteractionCard(
			item({ ...question, body: "It goes out every Monday." }, { ...answered, answeredBy: VIEWER }),
			thread(),
		);
		expect(classes(card)).toContain("is-exchange");
		expect([...card.children].map((part) => classes(part)[0])).toEqual(["interaction-ask", "interaction-result"]);
		// What the agent asked: one bubble with the title and the body, which tells its time on a hover as a message does.
		const ask = card.querySelector<HTMLElement>(":scope > .interaction-ask");
		expect(classes(ask)).toContain("bubble");
		expect(ask?.dataset.sentAt).toBe("2026-09-22T20:00:00Z");
		expect(ask?.querySelector(".interaction-title")?.textContent).toBe("Which channel should the digest go to?");
		expect(ask?.querySelector(".interaction-body")?.textContent).toBe("It goes out every Monday.");
		// The label row stays for a screen reader only.
		const heading = ask?.querySelector(".interaction-heading");
		expect(classes(heading)).toContain("visually-hidden");
		expect(heading?.textContent).toContain("Answered");
		// The answer: the member's own bubble on their side, with its own time; who and when stay for a screen reader.
		const result = card.querySelector<HTMLElement>(":scope > .interaction-result");
		expect(classes(result)).toEqual(["interaction-result", "is-said", "mine"]);
		expect(result?.dataset.sentAt).toBe("2026-09-22T20:05:00Z");
		const chosen = result?.querySelector(".interaction-chosen");
		expect([chosen?.textContent, classes(chosen).includes("bubble")]).toEqual(["#finance", true]);
		// Nothing shows beside it; a screen reader still hears who answered and when.
		const attribution = result?.querySelector(".interaction-attribution");
		expect(attribution?.querySelector(".interaction-beside")?.textContent).toBe("");
		expect(attribution?.querySelector(".visually-hidden")?.textContent).toBe(
			`You · ${fmtTime("2026-09-22T20:05:00Z")}`,
		);
		expect(result?.querySelector(".review-mark")).toBeNull();
		expect(card.querySelector("button, input")).toBeNull();
	});

	it("says whose pick an answer was and who sent it, when another member sent the asked member's pick", () => {
		const sent = renderInteractionCard(item(question, { ...answered, answeredBy: OTHER }), thread());
		const beside = sent.querySelector(".interaction-result .interaction-attribution > .interaction-beside");
		expect(beside?.textContent).toBe("Your pick, sent by Sofie");
		expect(sent.querySelector(".interaction-result .interaction-attribution > .visually-hidden")?.textContent).toBe(
			`Your pick, sent by Sofie · ${fmtTime("2026-09-22T20:05:00Z")}`,
		);
		const mine = renderInteractionCard(
			{ ...item(question, { ...answered, answeredBy: MEMBER }), actorUserId: OTHER },
			thread(),
		);
		expect(
			mine.querySelector(".interaction-result .interaction-attribution > .interaction-beside")?.textContent,
		).toBe("Sofie's pick, sent by you");
		const ASKED = "44444444-4444-4444-8444-444444444444";
		const third = renderInteractionCard(
			{ ...item(question, { ...answered, answeredBy: OTHER }), actorUserId: ASKED },
			{
				...thread(),
				memberName: (userId) => (userId === VIEWER ? "You" : userId === ASKED ? "Bo" : "Sofie"),
			},
		);
		expect(
			third.querySelector(".interaction-result .interaction-attribution > .interaction-beside")?.textContent,
		).toBe("Bo's pick, sent by Sofie");
	});

	it("says under the answer whose it is when it is another member's, and that it is on its way", () => {
		const others = renderInteractionCard(
			{ ...item(question, { ...answered, answeredBy: OTHER }), actorUserId: OTHER },
			thread(),
		);
		const result = others.querySelector(".interaction-result");
		expect(classes(result)).toEqual(["interaction-result", "is-said"]);
		// The eye gets the name; a screen reader hears the name and the time, once (review r1 F1 on #1727).
		const beside = result?.querySelector(".interaction-attribution > .interaction-beside");
		expect([beside?.textContent, beside?.getAttribute("aria-hidden")]).toEqual(["Sofie", "true"]);
		expect(result?.querySelector(".interaction-attribution > .visually-hidden")?.textContent).toBe(
			`Sofie · ${fmtTime("2026-09-22T20:05:00Z")}`,
		);
		// The member's own answer, not yet with the agent: no member is named on it yet, and it is theirs.
		const { answeredAt: _sent, ...unsent } = answered;
		const sending = renderInteractionCard(item(question, { ...unsent, pending: true }), thread());
		const pending = sending.querySelector<HTMLElement>(".interaction-result");
		expect(classes(pending)).toEqual(["interaction-result", "is-said", "mine"]);
		expect(pending?.dataset.sentAt).toBeUndefined();
		expect(pending?.querySelector(".interaction-beside")?.textContent).toBe("Sending");
		expect(pending?.querySelector(".interaction-attribution > .visually-hidden")?.textContent).toBe("You · Sending");
		// A line, too: another member's save names them beside it, with its time for a screen reader.
		const saved = renderInteractionCard(
			item(
				{ surface: "secret", title: "Stripe key", payload: {} },
				{ outcome: "provided", answer: {}, answeredBy: OTHER, answeredAt: answered.answeredAt },
			),
			thread(),
		);
		expect(saved.querySelector(".is-done .interaction-beside")?.textContent).toBe("Sofie");
		expect(saved.querySelector(".is-done .interaction-attribution > .visually-hidden")?.textContent).toBe(
			`Sofie · ${fmtTime("2026-09-22T20:05:00Z")}`,
		);
	});

	it("says anything else done with the card in one line under the question, marked as a decided approval is", () => {
		const secret: InteractionRequest = {
			surface: "secret",
			title: "Stripe key",
			payload: { purpose: "I need the Stripe key to set up payments.", label: "Stripe secret key" },
		};
		const saved = renderInteractionCard(
			item(secret, { outcome: "provided", answer: {}, answeredBy: VIEWER, answeredAt: answered.answeredAt }),
			thread(),
		);
		// The purpose is in the agent's bubble, with the title.
		expect(saved.querySelector(".interaction-ask.bubble .interaction-text")?.textContent).toBe(
			"I need the Stripe key to set up payments.",
		);
		const done = saved.querySelector(".interaction-result");
		expect(classes(done)).toEqual(["interaction-result", "is-done"]);
		expect(classes(done?.querySelector(".review-mark"))).toEqual(["review-mark", "is-approved"]);
		const line = done?.querySelector(".interaction-chosen");
		expect([line?.textContent, classes(line).includes("bubble")]).toEqual(["Saved to the company vault", false]);
		// A skipped question: a line, never a bubble of the member's.
		const skipped = renderInteractionCard(
			item(question, { outcome: "declined", answer: {}, answeredBy: VIEWER, answeredAt: answered.answeredAt }),
			thread(),
		);
		const passed = skipped.querySelector<HTMLElement>(".interaction-result");
		expect(classes(passed)).toEqual(["interaction-result", "is-done"]);
		expect(classes(passed?.querySelector(".review-mark"))).toEqual(["review-mark", "is-declined"]);
		expect(passed?.textContent).toBe("Skipped");
		expect(passed?.dataset.sentAt).toBe(answered.answeredAt);
		expect(skipped.querySelector(".bubble .interaction-title")).not.toBeNull();
		// Past its time: the line, with no mark.
		const expired = renderInteractionCard(
			item({ ...question, expiresAt: "2026-09-22T20:10:00Z" }),
			thread({ now: Date.parse("2026-09-22T20:11:00Z") }),
		);
		expect(classes(expired)).toContain("is-exchange");
		const late = expired.querySelector(".interaction-result");
		expect(classes(late)).toEqual(["interaction-result", "is-done"]);
		expect(late?.querySelector(".review-mark")).toBeNull();
		expect(late?.textContent).toContain("past its time");
	});

	it("keeps its frame wherever it is not in a thread, answered or waiting", () => {
		// The questions dock draws the same card with no thread around it.
		const docked = renderInteractionCard(item(question, { ...answered, answeredBy: VIEWER }), context());
		expect(classes(docked)).not.toContain("is-exchange");
		expect(
			docked.querySelector(".bubble, .visually-hidden, .interaction-beside, .review-mark, [data-sent-at]"),
		).toBeNull();
		expect(classes(docked.querySelector(".interaction-result"))).toEqual(["interaction-result"]);
		expect(docked.querySelector(".interaction-attribution")?.textContent).toMatch(/^Jonas · /);
		const waiting = renderInteractionCard(
			item({ ...question, payload: { ...question.payload, allowCustom: true } }),
			context(),
		);
		expect(classes(waiting)).toEqual(["interaction-card", "surface-question", "state-waiting"]);
		expect(
			waiting.querySelector(".interaction-call, .interaction-own, .interaction-send, .visually-hidden"),
		).toBeNull();
		expect(waiting.dataset.sentAt).toBeUndefined();
		expect(waiting.querySelector(".interaction-heading")?.textContent).toContain("Waiting for you");
	});
});

describe("a card that waits for the member, in a thread", () => {
	const thread = (overrides: Partial<Parameters<typeof renderInteractionCard>[1]> = {}) =>
		context({ inThread: true, viewerId: MEMBER, ...overrides });
	const classes = (element: Element | null | undefined) => [...(element?.classList ?? [])];
	const own: InteractionRequest = { ...question, payload: { ...question.payload, allowCustom: true } };

	it("says who asks at its head, with the agent's figure, and keeps the label row for a screen reader", () => {
		const figure = document.createElement("span");
		figure.className = "figure";
		const card = renderInteractionCard(item(question), thread({ figure: () => figure }));
		expect(classes(card)).toEqual(["interaction-card", "surface-question", "state-waiting", "is-asking"]);
		// Its time shows on a hover, as a message's does.
		expect(card.dataset.sentAt).toBe("2026-09-22T20:00:00Z");
		const call = card.querySelector(".interaction-ask > .interaction-call");
		expect(call?.querySelector(".interaction-figure")?.firstElementChild).toBe(figure);
		expect(call?.querySelector(".interaction-dot")).toBeNull();
		expect(call?.querySelector("strong")?.textContent).toBe("Yang Tang asks you");
		const heading = card.querySelector(".interaction-heading");
		expect(classes(heading)).toContain("visually-hidden");
		expect(heading?.textContent).toContain("Question");
		expect(heading?.textContent).toContain("Waiting for you");
		// The proposed answers and the way out are the card's own, as anywhere.
		expect([...card.querySelectorAll(".interaction-options .btn")].map((pill) => pill.textContent)).toEqual([
			"#general",
			"#finance",
		]);
		expect(card.querySelector(".interaction-actions .interaction-quiet")?.textContent).toBe("Skip");
		// With no figure to draw, a dot in the accent stands where it would.
		const plain = renderInteractionCard(item(question), thread());
		expect(plain.querySelector(".interaction-call > .interaction-dot")).not.toBeNull();
		expect(plain.querySelector(".interaction-figure")).toBeNull();
	});

	it("shows a typed note as the agent reworking the question until the agent is back", () => {
		const noted = { outcome: "answered" as const, answer: { values: ["Warmer, less blue"] }, answeredBy: "user-1" };
		const figure = document.createElement("span");
		const card = renderInteractionCard(
			item({ ...own, body: "Pick the channel." }, noted),
			thread({ reworking: true, figure: () => figure }),
		);
		expect(classes(card)).toEqual([
			"interaction-card",
			"surface-question",
			"state-answered",
			"is-asking",
			"is-reworking",
		]);
		expect(card.querySelector(".interaction-call strong")?.textContent).toBe("Yang Tang is reworking this");
		expect(card.querySelector(".interaction-call .interaction-figure")?.firstElementChild).toBe(figure);
		expect(card.querySelector(".interaction-title")?.textContent).toBe(own.title);
		expect(card.querySelector(".interaction-noted")?.textContent).toBe("“Warmer, less blue”");
		expect(
			card.querySelector(".interaction-body, .interaction-result, .interaction-actions, button, input"),
		).toBeNull();
		expect(classes(card.querySelector(".interaction-heading"))).toContain("visually-hidden");

		const back = renderInteractionCard(item(own, noted), thread({ reworking: false }));
		expect(classes(back)).toEqual(["interaction-card", "surface-question", "state-answered", "is-exchange"]);
		expect(back.querySelector(".interaction-result.is-said .interaction-chosen")?.textContent).toBe(
			"Warmer, less blue",
		);

		const picked = { outcome: "answered" as const, answer: { values: ["general"] }, answeredBy: "user-1" };
		const chosen = renderInteractionCard(item(own, picked), thread({ reworking: true }));
		expect(classes(chosen)).toEqual(["interaction-card", "surface-question", "state-answered", "is-exchange"]);

		const outside = renderInteractionCard(item(own, noted), { ...thread({ reworking: true }), inThread: false });
		expect(classes(outside)).not.toContain("is-reworking");
	});

	it("says the agent needs the member on a card that is no question", () => {
		const secret: InteractionRequest = { surface: "secret", title: "Stripe key", payload: { label: "Stripe key" } };
		const card = renderInteractionCard(item(secret), thread({ provideSecret: async () => {} }));
		expect(classes(card)).toContain("is-asking");
		expect(card.querySelector(".interaction-call strong")?.textContent).toBe("Yang Tang needs you");
	});

	it("sends an answer of the member's own from a Send in its field, live once something is typed", () => {
		const ctx = thread();
		const card = renderInteractionCard(item(own), ctx);
		const field = card.querySelector<HTMLInputElement>(".interaction-own > .interaction-field")!;
		const send = card.querySelector<HTMLButtonElement>(".interaction-own > .interaction-send")!;
		expect([send.getAttribute("aria-label"), send.disabled]).toEqual(["Send", true]);
		field.value = "   ";
		field.dispatchEvent(new Event("input"));
		expect(send.disabled).toBe(true);
		send.click();
		expect(ctx.answer).not.toHaveBeenCalled();
		field.value = " #ops ";
		field.dispatchEvent(new Event("input"));
		expect(send.disabled).toBe(false);
		send.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["#ops"] });
		// Enter still sends, as it always did.
		const again = thread();
		const typed = renderInteractionCard(item(own), again).querySelector<HTMLInputElement>(".interaction-field")!;
		typed.value = "#ops";
		typed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
		expect(again.answer).toHaveBeenCalledWith("answered", { values: ["#ops"] });
		// A question that takes several answers has its own Send beside the field: no second one in it.
		const several = renderInteractionCard(item({ ...own, payload: { ...own.payload, multiSelect: true } }), thread());
		expect(several.querySelector(".interaction-own, .interaction-send")).toBeNull();
		expect(several.querySelector(".interaction-actions > .interaction-field")).not.toBeNull();
	});

	it("stays the plain card for a member who cannot answer it", () => {
		const card = renderInteractionCard(item(own), thread({ canAnswer: false }));
		expect(classes(card)).toEqual(["interaction-card", "surface-question", "state-waiting"]);
		expect(card.querySelector(".interaction-call, .visually-hidden, button, input")).toBeNull();
		expect(card.dataset.sentAt).toBeUndefined();
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
	/** The company's apps as the card reads them: one with a cover, one with only its emblem. */
	const app = (name: string) =>
		name === "bundle-demo"
			? { title: "The bundle demo", emblem: "star" as const, cover: null }
			: name === "saml-concepts"
				? { title: "Entirely you", emblem: "page" as const, cover: "apps/saml-concepts/cover.png" }
				: undefined;

	it("shows options with pictures as big boxes; a click picks one", async () => {
		const image = vi.fn(async (path: string) => new Blob([path], { type: "image/svg+xml" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:shown");
		const ctx = context({ image, app });
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
		// An app with no cover of its own stands for itself: its title, never its folder name. Its link opens its page.
		expect(boxes[2]?.querySelector(".choice-app-name")?.textContent).toBe("The bundle demo");
		expect(boxes[2]?.querySelector(".choice-picture .interface-emblem")).not.toBeNull();
		expect(card.querySelector(".choice-apps .app-card")).not.toBeNull();
		boxes[1]?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["pair"] });
		created.mockRestore();
	});

	it("shows no pictures under a question the member answered in their own words", () => {
		const own = { ...visual, payload: { ...visual.payload, allowCustom: true } };
		const ctx = { ...context({ app }), inThread: true };
		const noted = renderInteractionCard(
			item(own, { outcome: "answered", answer: { values: ["Something calmer"] }, answeredBy: "user-1" }),
			ctx,
		);
		expect(noted.querySelector(".choice-box, .interaction-choices")).toBeNull();
		expect(noted.querySelector(".interaction-chosen")?.textContent).toBe("Something calmer");
		const picked = renderInteractionCard(
			item(own, { outcome: "answered", answer: { values: ["pair"] }, answeredBy: "user-1" }),
			ctx,
		);
		expect(picked.querySelector(".interaction-choices")).not.toBeNull();
	});

	it("shows an app's own cover for an option that names it", async () => {
		const image = vi.fn(async (path: string) => new Blob([path], { type: "image/png" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:cover");
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Which headline?",
				payload: { options: [{ label: "Entirely you", preview: "app:saml-concepts" }] },
			}),
			context({ image, app }),
		);
		await vi.waitFor(() => expect(card.querySelector(".choice-picture img")).not.toBeNull());
		expect(image.mock.calls.map(([path]) => path)).toEqual(["apps/saml-concepts/cover.png"]);
		expect(card.querySelector(".choice-app-name")).toBeNull();
		created.mockRestore();
	});

	it("draws no preview box for an option that has none, or whose preview cannot be shown", async () => {
		const image = vi.fn(async () => null);
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Viser scenerne den lampe, du forestiller dig?",
				payload: {
					options: [
						{ label: "Ja, sådan", value: "ja", preview: "app:saml-concepts" },
						{ label: "Noget skal ændres", value: "nej" },
						{ label: "Vis en anden", value: "anden", preview: "app:not-in-this-company" },
					],
				},
			}),
			context({ image, app }),
		);
		// The option with no preview is a pill under the boxes, never an empty box beside a picture.
		expect(card.querySelectorAll(".choice-box")).toHaveLength(2);
		expect(
			[...card.querySelectorAll(".interaction-choices > .choice-others > button")].map((pill) => pill.textContent),
		).toEqual(["Noget skal ændres"]);
		// The cover could not be read: the frame goes rather than stand empty.
		await vi.waitFor(() => expect(card.querySelectorAll(".choice-picture")).toHaveLength(0));
	});

	it("picks an option without a picture from its pill, and keeps a lone picture box to a column", () => {
		const ctx = context({ image: async () => null, app });
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Viser scenerne den lampe, du forestiller dig?",
				payload: {
					options: [
						{ label: "Ja, sådan", value: "ja", preview: "app:saml-concepts" },
						{ label: "Noget skal ændres", value: "nej" },
					],
				},
			}),
			ctx,
		);
		expect((card.querySelector(".interaction-choices") as HTMLElement).style.getPropertyValue("--choices")).toBe("2");
		card.querySelector<HTMLButtonElement>(".choice-others > button")?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["nej"] });
	});

	it("shows an app the question's words link once: its cover on that card, the option that previews it a pill", async () => {
		const image = vi.fn(async (path: string) => new Blob([path], { type: "image/png" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:cover");
		const ctx = context({ image, app, inThread: true });
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Viser scenerne den lampe, du forestiller dig?",
				body: "[Prøv de seks scener](app:saml-concepts), især det gradvise morgenlys.",
				payload: {
					allowCustom: true,
					options: [
						{ label: "Ja, sådan", value: "ja", preview: "app:saml-concepts" },
						{ label: "Noget skal ændres", value: "nej" },
					],
				},
			}),
			ctx,
		);
		// One card for the app, the words' own; no boxes, no second link under the options.
		expect([...card.querySelectorAll<HTMLElement>(".app-card")].map((link) => link.dataset.appName)).toEqual([
			"saml-concepts",
		]);
		expect(card.querySelector(".interaction-choices, .choice-box")).toBeNull();
		expect([...card.querySelectorAll(".interaction-options > button")].map((pill) => pill.textContent)).toEqual([
			"Ja, sådan",
			"Noget skal ændres",
		]);
		const linkCard = card.querySelector<HTMLElement>(".interaction-body .app-card");
		await vi.waitFor(() => expect(linkCard?.querySelector(":scope > .choice-picture img")).not.toBeNull());
		expect(image.mock.calls.map(([path]) => path)).toEqual(["apps/saml-concepts/cover.png"]);
		card.querySelector<HTMLButtonElement>(".interaction-options > button")?.click();
		expect(ctx.answer).toHaveBeenCalledWith("answered", { values: ["ja"] });
		created.mockRestore();
	});

	it("puts an app's cover on the words' card once the apps are read, and none for an app without one", async () => {
		let known: Record<string, InteractionCardApp> = {};
		const apps = (name: string) => known[name];
		const image = vi.fn(async (path: string) => new Blob([path], { type: "image/png" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:cover");
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Viser scenerne den lampe?",
				body: "[Prøv de seks scener](app:saml-concepts) og [demoen](app:bundle-demo).",
				payload: {
					options: [
						{ label: "Ja", value: "ja", preview: "app:saml-concepts" },
						{ label: "Demoen", value: "demo", preview: "app:bundle-demo" },
					],
				},
			}),
			context({ image, app: apps, inThread: true }),
		);
		expect(card.querySelector(".choice-picture")).toBeNull();
		known = {
			"saml-concepts": { title: "Entirely you", emblem: "page", cover: "apps/saml-concepts/cover.png" },
			"bundle-demo": { title: "The bundle demo", emblem: "star", cover: null },
		};
		refreshAppPreviews(card, apps, image);
		const [first, second] = card.querySelectorAll<HTMLElement>(".interaction-body .app-card");
		await vi.waitFor(() => expect(first?.querySelector(":scope > .choice-picture img")).not.toBeNull());
		// The demo has no cover: its card stays as it is, never an emblem drawn twice.
		expect(second?.querySelector(".choice-picture")).toBeNull();
		created.mockRestore();
	});

	it("brings an app's preview in once the company's apps are read, keeping the answer being given", async () => {
		// The card is drawn before the company's apps are read (review r1 of #1763, F1).
		let known: Record<string, InteractionCardApp> = {};
		const apps = (name: string) => known[name];
		const image = vi.fn(async (path: string) => new Blob([path], { type: "image/png" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:cover");
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Viser scenerne den lampe, du forestiller dig?",
				payload: {
					multiSelect: true,
					allowCustom: true,
					options: [
						{ label: "Ja, sådan", value: "ja", preview: "app:saml-concepts" },
						{ label: "Den anden", value: "anden", preview: "app:bundle-demo" },
						{ label: "Noget skal ændres", value: "nej" },
					],
				},
			}),
			context({ image, app: apps, inThread: true }),
		);
		const titles = () => [...card.querySelectorAll(".choice-apps .app-card-title")].map((title) => title.textContent);
		expect(card.querySelectorAll(".choice-picture")).toHaveLength(0);
		expect(titles()).toEqual(["saml-concepts", "bundle-demo"]);
		// The member picks an option and starts on an answer of their own.
		const boxes = [...card.querySelectorAll<HTMLButtonElement>(".choice-box")];
		expect(boxes).toHaveLength(2);
		boxes[1]?.click();
		const field = card.querySelector<HTMLInputElement>(".interaction-field");
		if (!field) throw new Error("no field");
		field.value = "Lidt varmere lys";
		// Then the apps are read.
		known = {
			"saml-concepts": { title: "Entirely you", emblem: "page", cover: "apps/saml-concepts/cover.png" },
			"bundle-demo": { title: "The bundle demo", emblem: "star", cover: null },
		};
		refreshAppPreviews(card, apps, image);
		await vi.waitFor(() => expect(boxes[0]?.querySelector(".choice-picture img")).not.toBeNull());
		expect(image.mock.calls.map(([path]) => path)).toEqual(["apps/saml-concepts/cover.png"]);
		expect(boxes[1]?.querySelector(".choice-app-name")?.textContent).toBe("The bundle demo");
		expect(card.querySelector(".choice-others")?.textContent).toBe("Noget skal ændres");
		expect(titles()).toEqual(["Entirely you", "The bundle demo"]);
		// In place: the same boxes, the pick and the words as they were.
		expect([...card.querySelectorAll(".choice-box")]).toEqual(boxes);
		expect(boxes.map((box) => box.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
		expect(card.querySelector(".interaction-field")).toBe(field);
		expect(field.value).toBe("Lidt varmere lys");
		// Nothing is drawn again while the apps stay as they are; a change to one is followed.
		const cover = boxes[0]?.querySelector(".choice-picture");
		refreshAppPreviews(card, apps, image);
		expect(boxes[0]?.querySelector(".choice-picture")).toBe(cover);
		known = { ...known, "saml-concepts": { title: "Entirely you", emblem: "page", cover: null } };
		refreshAppPreviews(card, apps, image);
		expect(boxes[0]?.querySelectorAll(".choice-picture")).toHaveLength(1);
		expect(boxes[0]?.querySelector(".choice-app-name")?.textContent).toBe("Entirely you");
		expect(field.value).toBe("Lidt varmere lys");
		created.mockRestore();
	});

	it("links an app once when several options show it", () => {
		const card = renderInteractionCard(
			item({
				surface: "question",
				title: "Which headline do you like best?",
				payload: {
					options: [
						{ label: "Entirely you", preview: "app:saml-concepts" },
						{ label: "Keep close", preview: "app:saml-concepts" },
						{ label: "The demo", preview: "app:bundle-demo" },
					],
				},
			}),
			context({ image: async () => null, app }),
		);
		expect(
			[...card.querySelectorAll<HTMLElement>(".choice-apps .app-card")].map((link) => link.dataset.appName),
		).toEqual(["saml-concepts", "bundle-demo"]);
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

	it("revokes cached object URLs and aborts in-flight image reads on disposal", async () => {
		let pendingSignal: AbortSignal | undefined;
		const image = vi.fn((path: string, signal: AbortSignal) => {
			if (path === "sketches/duo.svg") return Promise.resolve(new Blob([path], { type: "image/png" }));
			pendingSignal = signal;
			return new Promise<Blob | null>(() => {});
		});
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:card-1");
		const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		try {
			const card = renderInteractionCard(item(visual), context({ image, app }));
			await vi.waitFor(() => expect(card.querySelectorAll(".choice-picture img")).toHaveLength(1));
			expect(pendingSignal?.aborted).toBe(false);
			disposeCardPictures(image);
			await Promise.resolve();
			await Promise.resolve();
			expect(pendingSignal?.aborted).toBe(true);
			expect(revoked).toHaveBeenCalledWith("blob:card-1");
		} finally {
			created.mockRestore();
			revoked.mockRestore();
		}
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

describe("the address card", () => {
	const address: InteractionRequest = {
		surface: "question",
		title: "Your company's email address",
		payload: {
			allowCustom: true,
			input: { kind: "mail_address" },
			options: [
				{ label: "lerhave-keramik", value: "lerhave-keramik" },
				{ label: "lerhave", value: "lerhave" },
			],
		},
	};
	const taken = new Set(["brooks"]);
	function calls(overrides: Partial<MailAddressCalls> = {}) {
		return {
			canChoose: true,
			handles: vi.fn(async () => ({ domain: "inbox.qorpera.com", handles: ["mine"] })),
			status: vi.fn(async (handle: string) =>
				handle === "mine" ? ("ours" as const) : taken.has(handle) ? ("taken" as const) : ("free" as const),
			),
			choose: vi.fn(async () => {}),
			...overrides,
		};
	}
	const field = (card: HTMLElement) => card.querySelector<HTMLInputElement>(".interaction-address-handle")!;
	const check = (card: HTMLElement) => card.querySelector(".interaction-address-check")?.textContent;
	const use = (card: HTMLElement) =>
		[...card.querySelectorAll<HTMLButtonElement>(".interaction-actions .btn")].find(
			(pill) => pill.textContent === "Use this address",
		);
	const type = (card: HTMLElement, text: string) => {
		field(card).value = text;
		field(card).dispatchEvent(new Event("input"));
	};

	it("is a question that takes the member's own answer and says its input is a mail address", () => {
		expect(questionInput(address)).toBe("mail_address");
		expect(questionInput({ ...address, payload: { ...address.payload, allowCustom: false } })).toBeUndefined();
		expect(questionInput(question)).toBeUndefined();
		expect(questionInput({ ...address, payload: { ...address.payload, input: { kind: "phone" } } })).toBeUndefined();
	});

	it("shows hello., the first suggestion and the domain in one field, and checks the company's part as it is typed", async () => {
		const mail = calls();
		const card = renderInteractionCard(item(address), context({ inThread: true, mailAddress: mail }));
		expect(card.querySelector(".interaction-address-box")?.textContent).toBe("hello.");
		expect(field(card).value).toBe("lerhave-keramik");
		await vi.waitFor(() =>
			expect(card.querySelector(".interaction-address-domain")?.textContent).toBe("@inbox.qorpera.com"),
		);
		expect(card.querySelector(".interaction-field")).toBeNull();
		expect(check(card)).toBe("Checking…");
		expect(use(card)?.disabled).toBe(true);
		await vi.waitFor(() => expect(check(card)).toBe("Free"));
		expect(use(card)?.disabled).toBe(false);
		expect(mail.status).toHaveBeenCalledWith("lerhave-keramik", expect.any(AbortSignal));
		const suggestions = [...card.querySelectorAll<HTMLButtonElement>(".interaction-address-suggestions .btn")];
		expect(suggestions.map((pill) => pill.textContent)).toEqual(["lerhave-keramik", "lerhave"]);
		suggestions[1]!.click();
		expect(field(card).value).toBe("lerhave");
		expect(mail.choose).not.toHaveBeenCalled();
		type(card, "Brooks");
		expect(field(card).value).toBe("brooks");
		await vi.waitFor(() => expect(check(card)).toBe("That one belongs to another company"));
		expect(use(card)?.disabled).toBe(true);
		type(card, "mine");
		await vi.waitFor(() => expect(check(card)).toBe("Already yours"));
		type(card, "a");
		expect(check(card)).toBe("Use a–z, 0–9 and hyphens");
		expect(use(card)?.disabled).toBe(true);
		type(card, "lerhave keramik!");
		expect(field(card).value).toBe("lerhave-keramik-");
		expect(check(card)).toBe("Use a–z, 0–9 and hyphens");
	});

	it("makes the address with Use this address, and says why when it could not be made", async () => {
		const choose = vi
			.fn<(handle: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error("This address is taken."))
			.mockResolvedValueOnce(undefined);
		const ctx = context({ inThread: true, mailAddress: calls({ choose }) });
		const card = renderInteractionCard(item(address), ctx);
		document.body.append(card);
		await vi.waitFor(() => expect(check(card)).toBe("Free"));
		use(card)!.click();
		expect(choose).toHaveBeenCalledWith("lerhave-keramik");
		expect(field(card).getAttribute("aria-disabled")).toBe("true");
		await vi.waitFor(() => expect(check(card)).toBe("This address is taken."));
		expect(field(card).getAttribute("aria-disabled")).toBeNull();
		use(card)!.click();
		await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(2));
		expect(ctx.answer).not.toHaveBeenCalled();
		document.body.replaceChildren();
	});

	it("shows a member who is not a founder or an admin the address without a way to choose it", async () => {
		const card = renderInteractionCard(item(address), context({ mailAddress: calls({ canChoose: false }) }));
		expect(field(card).disabled).toBe(true);
		expect(use(card)).toBeUndefined();
		expect(card.querySelector(".interaction-address-suggestions")).toBeNull();
		expect(check(card)).toBe("Only founders and admins can choose the address");
		expect(card.querySelector(".interaction-quiet")?.textContent).toBe("Skip");
		const away = renderInteractionCard(item(address), context());
		expect(field(away).disabled).toBe(true);
		expect(check(away)).toBe("The address can be chosen in the chat.");
	});

	it("says when the company's mail is off", async () => {
		const card = renderInteractionCard(
			item(address),
			context({ mailAddress: calls({ handles: vi.fn(async () => ({ domain: null, handles: [] })) }) }),
		);
		await vi.waitFor(() => expect(check(card)).toBe("Company mail is not set up yet."));
		expect(use(card)?.disabled).toBe(true);
	});

	it("shows the address made as the member's own answer once it is answered", () => {
		const card = renderInteractionCard(
			item(address, {
				outcome: "answered",
				answer: { values: ["hello.lerhave-keramik@inbox.qorpera.com"] },
				answeredBy: MEMBER,
				answeredAt: "2026-09-22T20:05:00Z",
			}),
			context({ inThread: true, viewerId: MEMBER, mailAddress: calls() }),
		);
		expect(card.querySelector(".interaction-address")).toBeNull();
		expect(card.querySelector(".interaction-result.is-said.mine .bubble")?.textContent).toBe(
			"hello.lerhave-keramik@inbox.qorpera.com",
		);
	});

	it("aborts mail_address handles probes and stops HandleCheck when context.signal aborts or card rerenders", async () => {
		vi.useFakeTimers();
		try {
			const abort = new AbortController();
			const observedSignals: AbortSignal[] = [];
			let resolveHandles: ((value: { domain: string | null; handles: string[] }) => void) | undefined;
			const status = vi.fn(async () => "free" as const);
			const handles = vi.fn(
				(signal: AbortSignal) =>
					new Promise<{ domain: string | null; handles: string[] }>((resolve) => {
						observedSignals.push(signal);
						resolveHandles = resolve;
					}),
			);
			const card = renderInteractionCard(
				item(address),
				context({ mailAddress: calls({ handles, status }), signal: abort.signal }),
			);
			expect(observedSignals).toHaveLength(1);
			expect(observedSignals[0]?.aborted).toBe(false);
			field(card).value = "fresh-handle";
			field(card).dispatchEvent(new Event("input"));

			abort.abort();
			expect(observedSignals[0]?.aborted).toBe(true);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(status).not.toHaveBeenCalled();

			resolveHandles?.({ domain: "inbox.qorpera.com", handles: [] });
			await Promise.resolve();
			expect(card.querySelector(".interaction-address-domain")?.textContent).toBe("@…");

			const skippedHandles = vi.fn(async () => ({ domain: "inbox.qorpera.com", handles: [] }));
			renderInteractionCard(
				item(address),
				context({ mailAddress: calls({ handles: skippedHandles }), signal: abort.signal }),
			);
			expect(skippedHandles).not.toHaveBeenCalled();

			const rerenderSignals: AbortSignal[] = [];
			const choose = vi.fn(async () => undefined);
			const card2 = renderInteractionCard(
				item(address),
				context({
					mailAddress: calls({
						choose,
						handles: vi.fn((signal: AbortSignal) => {
							rerenderSignals.push(signal);
							return Promise.resolve({ domain: "inbox.qorpera.com", handles: [] });
						}),
					}),
				}),
			);
			document.body.append(card2);
			await vi.advanceTimersByTimeAsync(500);
			use(card2)!.click();
			await vi.advanceTimersByTimeAsync(0);
			expect(choose).toHaveBeenCalledTimes(1);
			expect(rerenderSignals[0]?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
