// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyController, ConversationState } from "../src/app/company.ts";
import { OpenQuestions, questionApps } from "../src/app/open-questions.ts";
import { Store } from "../src/app/state.ts";
import { QuestionDock, type QuestionDockHost } from "../src/app/views/question-dock.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { InteractionOutcome, InteractionRequest } from "../src/cloud/interactions.ts";
import { type OpenQuestion, parseOpenQuestions } from "../src/cloud/open-questions.ts";
import type { HostedStaffAgent, JsonValue } from "../src/cloud/types.ts";
import { linkHref } from "../src/ui/dom.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CARD_A = "44444444-4444-4444-8444-00000000000a";
const CARD_B = "44444444-4444-4444-8444-00000000000b";
const CARD_C = "44444444-4444-4444-8444-00000000000c";

const directions: InteractionRequest = {
	surface: "question",
	title: "Which direction should the shop take?",
	payload: {
		options: [
			{ label: "Calm", value: "calm", preview: "app:shop-calm" },
			{ label: "Bold", value: "bold", preview: "app:shop-bold" },
		],
	},
};

function body(request: InteractionRequest): JsonValue {
	return {
		entry: {
			type: "custom",
			customType: "interaction_request",
			data: { schema: "qorpera.interaction/v1", ...request } as unknown as JsonValue,
		},
	};
}

function listed(id: string, request: InteractionRequest, createdAt: string) {
	return {
		sessionId: SESSION,
		interactionId: id,
		sequence: 7,
		actorUserId: MEMBER,
		staffAgentId: AGENT,
		body: body(request),
		createdAt,
	};
}

function question(id: string, request: InteractionRequest, createdAt = "2026-11-10T10:00:00Z"): OpenQuestion {
	return parseOpenQuestions({ schema: "qorpera.open-questions/v1", questions: [listed(id, request, createdAt)] })[0]!;
}

describe("open questions from the cloud", () => {
	it("keeps question cards it can read and drops the rest", () => {
		const parsed = parseOpenQuestions({
			schema: "qorpera.open-questions/v1",
			questions: [
				listed(CARD_A.toUpperCase(), directions, "2026-11-10T10:00:00Z"),
				listed(
					CARD_B,
					{ surface: "takeover", title: "Sign in", payload: { instruction: "Sign in." } },
					"2026-11-10T09:00:00Z",
				),
				{ ...listed(CARD_C, directions, "2026-11-10T08:00:00Z"), body: { entry: { type: "custom" } } },
			],
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ interactionId: CARD_A, sessionId: SESSION, staffAgentId: AGENT });
		expect(parsed[0]?.request.title).toBe("Which direction should the shop take?");
		expect(() => parseOpenQuestions({ schema: "other", questions: [] })).toThrow();
	});

	it("points a card at the apps its options preview or its body links", () => {
		expect([...questionApps(directions)]).toEqual(["shop-calm", "shop-bold"]);
		expect([
			...questionApps({
				surface: "question",
				title: "Which logo?",
				body: "Both are in [the concepts](app:concepts) and [elsewhere](https://example.com).",
				payload: {
					options: [
						{ label: "A", preview: "apps/concepts/logos/a.png" },
						{ label: "B", preview: "QorperaOS/brand/b.svg" },
						{ label: "C", preview: "app:Not_A_Name" },
					],
				},
			}),
		]).toEqual(["concepts"]);
		expect(questionApps({ surface: "secret", title: "Key", payload: {} }).size).toBe(0);
	});
});

/** A company as far as the questions need it: the read, the hints, the thread's conversation and the thread's answer
 * path, which shows the answer at once as CompanyController.answerInteraction does. */
function company(options: { questions?: OpenQuestion[]; refuse?: string } = {}) {
	const conversations = new Map<string, Store<ConversationState>>();
	const listeners = new Set<(resource: string) => void>();
	let questions = options.questions ?? [];
	const conversation = (sessionId: string) => {
		let store = conversations.get(sessionId);
		if (!store) {
			store = new Store<ConversationState>({ sessionId, optimistic: [] } as unknown as ConversationState);
			conversations.set(sessionId, store);
		}
		return store;
	};
	const answers: [string, string, InteractionOutcome, Record<string, JsonValue>][] = [];
	const controller = {
		signal: new AbortController().signal,
		listOpenQuestions: vi.fn(async () => questions),
		onInvalidate: (listener: (resource: string) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		conversation,
		setExecutionSponsor: vi.fn(),
		answerInteraction: vi.fn(
			async (
				sessionId: string,
				interactionId: string,
				outcome: InteractionOutcome,
				value: Record<string, JsonValue>,
			) => {
				answers.push([sessionId, interactionId, outcome, value]);
				const store = conversation(sessionId);
				store.set({
					interactionAnswers: {
						[interactionId]: {
							outcome,
							answer: value,
							answeredBy: MEMBER,
							answeredAt: "2026-11-10T10:01:00Z",
							pending: true,
						},
					},
					interactionError: undefined,
				});
				await Promise.resolve();
				if (options.refuse) {
					store.set({ interactionAnswers: undefined, interactionError: options.refuse });
					throw new Error("refused");
				}
				questions = questions.filter((item) => item.interactionId !== interactionId);
			},
		),
	};
	const accounts = { listConnections: vi.fn(), selectSessionAccount: undefined };
	const open = new OpenQuestions(controller as unknown as CompanyController, accounts as never);
	const agent = { id: AGENT, displayName: "Bob", appearance: { color: "", shape: "" } } as unknown as HostedStaffAgent;
	const host: QuestionDockHost = {
		questions: open,
		agent: (id) => (id === AGENT ? agent : undefined),
		memberName: () => "Jonas",
		conversation,
		chatHref: (sessionId) => `#/c/p/chat/${sessionId}`,
	};
	return {
		controller,
		open,
		host,
		answers,
		hint: () => {
			for (const listener of listeners) listener("sessions");
		},
	};
}

const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("the questions dock", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorage.clear();
	});
	afterEach(() => {
		vi.useRealTimers();
		document.body.replaceChildren();
	});

	it("shows only the questions that point at its app, drawn as the thread draws them", async () => {
		const { host } = company({
			questions: [
				question(CARD_A, directions, "2026-11-10T10:00:00Z"),
				question(CARD_B, { ...directions, payload: { options: [{ label: "X", preview: "app:other" }] } }),
			],
		});
		const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
		document.body.append(dock.el);
		await settle();
		expect(dock.el.hidden).toBe(false);
		expect(dock.el.querySelectorAll(".interaction-card")).toHaveLength(1);
		expect(dock.el.textContent).toContain("Bob asks you");
		expect(dock.el.textContent).toContain("Which direction should the shop take?");
		const chat = dock.el.querySelector<HTMLElement>(".question-dock-note a");
		expect(chat && linkHref(chat)).toBe(`#/c/p/chat/${SESSION}`);
		dock.dispose();
	});

	it("stays away when nothing points here", async () => {
		const { host } = company({ questions: [question(CARD_A, directions)] });
		const dock = new QuestionDock(host, (apps) => apps.has("mailbox"));
		await settle();
		expect(dock.el.hidden).toBe(true);
		dock.dispose();
	});

	it("answers in one tap, shows it at once, then lets the card go", async () => {
		const { host, answers } = company({ questions: [question(CARD_A, directions)] });
		const dock = new QuestionDock(host, (apps) => apps.has("shop-bold"));
		document.body.append(dock.el);
		await settle();
		const boxes = [...dock.el.querySelectorAll<HTMLButtonElement>(".choice-box")];
		expect(boxes.map((box) => box.querySelector(".choice-label")?.textContent)).toEqual(["Calm", "Bold"]);
		boxes[1]?.click();
		await settle();
		expect(answers).toEqual([[SESSION, CARD_A, "answered", { values: ["bold"] }]]);
		await settle();
		// Taken: the chosen box is marked, the agent has it, and nothing is left to press.
		expect(dock.el.classList.contains("is-answered")).toBe(true);
		expect(dock.el.querySelector(".choice-box.is-chosen .choice-label")?.textContent).toBe("Bold");
		expect(dock.el.textContent).toContain("Sent to Bob");
		expect(dock.el.querySelector(".question-dock-burst")).not.toBeNull();
		expect(dock.el.querySelector(".choice-box:not(:disabled)")).toBeNull();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(dock.el.hidden).toBe(true);
		dock.dispose();
	});

	it("opens the card again and says why when the answer is refused", async () => {
		const { host } = company({
			questions: [question(CARD_A, directions)],
			refuse: "Select an active model account, then try again.",
		});
		const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
		document.body.append(dock.el);
		await settle();
		dock.el.querySelector<HTMLButtonElement>(".choice-box")?.click();
		await settle();
		await vi.advanceTimersByTimeAsync(0);
		expect(dock.el.querySelector(".question-dock-error")?.textContent).toBe(
			"Select an active model account, then try again.",
		);
		expect(dock.el.classList.contains("is-answered")).toBe(false);
		expect(dock.el.querySelector(".choice-box:not(:disabled)")).not.toBeNull();
		dock.dispose();
	});

	it("folds to a pill with the count and steps between questions", async () => {
		const { host } = company({
			questions: [
				question(CARD_A, directions, "2026-11-10T10:00:00Z"),
				question(CARD_B, directions, "2026-11-10T09:00:00Z"),
			],
		});
		const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
		document.body.append(dock.el);
		await settle();
		expect(dock.el.querySelector(".question-dock-count")?.textContent).toBe("1 of 2");
		dock.el.querySelector<HTMLButtonElement>(".question-dock-button.is-next")?.click();
		expect(dock.el.querySelector(".question-dock-count")?.textContent).toBe("2 of 2");
		dock.el.querySelector<HTMLButtonElement>('[aria-label="Hide the question"]')?.click();
		expect(dock.el.classList.contains("is-folded")).toBe(true);
		expect(dock.el.querySelector(".question-dock-pill")?.textContent).toContain("2 questions for you");
		expect(localStorage.getItem("qorpera.web.question-dock-folded")).toBe("1");
		dock.el.querySelector<HTMLButtonElement>(".question-dock-pill")?.click();
		expect(dock.el.querySelector(".interaction-card")).not.toBeNull();
		dock.dispose();
	});
});

describe("reading the open questions", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reads while watched, again on a hint, and stops with the last watcher", async () => {
		const { controller, open, hint } = company({ questions: [question(CARD_A, directions)] });
		expect(controller.listOpenQuestions).not.toHaveBeenCalled();
		const stop = open.watch();
		await settle();
		expect(controller.listOpenQuestions).toHaveBeenCalledTimes(1);
		expect(open.store.get()).toMatchObject({ read: true, unavailable: false });
		hint();
		await settle();
		expect(controller.listOpenQuestions).toHaveBeenCalledTimes(2);
		stop();
		hint();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(controller.listOpenQuestions).toHaveBeenCalledTimes(2);
	});

	it("stops asking a cloud without the read", async () => {
		const { controller, open } = company();
		controller.listOpenQuestions.mockRejectedValueOnce(
			new CloudRpcError("qorpera_list_member_open_questions", { code: "PGRST202", message: "missing" }, 404),
		);
		const stop = open.watch();
		await settle();
		expect(open.store.get().unavailable).toBe(true);
		await open.refresh();
		expect(controller.listOpenQuestions).toHaveBeenCalledTimes(1);
		stop();
	});
});
