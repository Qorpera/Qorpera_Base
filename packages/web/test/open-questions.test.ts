// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyController, ConversationState } from "../src/app/company.ts";
import { OpenQuestions, questionApps } from "../src/app/open-questions.ts";
import { Store } from "../src/app/state.ts";
import { DecisionDock, decisionOrder, SETTLE_MS, UNDO_MS } from "../src/app/views/decision-dock.ts";
import { QuestionDock, type QuestionDockHost } from "../src/app/views/question-dock.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type {
	EmailDraftAction,
	EmailDraftContent,
	EmailDraftEditor,
	EmailDraftState,
} from "../src/cloud/email-drafts.ts";
import type { InteractionOutcome, InteractionRequest } from "../src/cloud/interactions.ts";
import {
	asOpenCards,
	type OpenApproval,
	type OpenDecision,
	type OpenDraft,
	parseOpenDecisions,
} from "../src/cloud/open-decisions.ts";
import { type OpenQuestion, parseOpenQuestions } from "../src/cloud/open-questions.ts";
import type { ActionReviewAnswer } from "../src/cloud/review-rules.ts";
import type { HostedStaffAgent, JsonValue } from "../src/cloud/types.ts";
import { refreshAppPreviews } from "../src/ui/interaction-card.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CARD_A = "44444444-4444-4444-8444-00000000000a";
const CARD_B = "44444444-4444-4444-8444-00000000000b";
const CARD_C = "44444444-4444-4444-8444-00000000000c";

const DRAFT = "66666666-6666-4666-8666-00000000000a";
const letter: InteractionRequest = {
	surface: "draft",
	title: "New email",
	payload: {
		platform: "email",
		connectorId: "gmail",
		to: ["ada@acme.test"],
		cc: [],
		subject: "Our offer",
		body: "Hello Ada",
	},
};

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
function company(
	options: {
		questions?: OpenQuestion[];
		approvals?: OpenApproval[];
		drafts?: OpenDraft[];
		company?: OpenDecision[];
		spectator?: boolean;
		draft?: (action: EmailDraftAction | "load", content?: EmailDraftContent) => Promise<EmailDraftState>;
		refuse?: string;
		/** The cloud takes the answer only when this resolves. */
		gate?: Promise<void>;
		accounts?: {
			listConnections: () => Promise<unknown>;
			selectSessionAccount?: (id: string) => Promise<string | null>;
		};
	} = {},
) {
	const conversations = new Map<string, Store<ConversationState>>();
	const listeners = new Set<(resource: string) => void>();
	let questions = options.questions ?? [];
	let approvals = options.approvals ?? [];
	let drafts = options.drafts ?? [];
	const editors = new Map<string, EmailDraftEditor>();
	const draftSteps: [string, string, EmailDraftAction | "load"][] = [];
	const votesCast: [string, string | undefined, string | undefined][] = [];
	const draftStep = (sessionId: string, interactionId: string, action: EmailDraftAction | "load") => {
		draftSteps.push([sessionId, interactionId, action]);
		if (!options.draft) throw new Error("no draft in this fixture");
	};
	const reviews: [string, string, ActionReviewAnswer, string | undefined][] = [];
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
		setOpenDecisions: vi.fn(),
		userId: MEMBER,
		store: new Store({ team: { capabilities: { read: true, write: options.spectator !== true } } }),
		listCompanyOpenDecisions: vi.fn(async (): Promise<OpenDecision[]> => {
			if (!options.company)
				throw new CloudRpcError(
					"qorpera_list_company_open_decisions",
					{ message: "missing", code: "PGRST202" },
					404,
				);
			return options.company;
		}),
		castDecisionVote: vi.fn(async (itemId: string, choice: string | undefined, note: string | undefined) => {
			votesCast.push([itemId, choice, note]);
			await (options.gate ?? Promise.resolve());
			if (options.refuse) throw new Error(options.refuse);
			const at = options.company?.findIndex((listed) => listed.interactionId === itemId) ?? -1;
			const voted = options.company?.[at];
			if (!options.company || !voted) return;
			options.company[at] = {
				...voted,
				votes: [
					...(voted.votes ?? []).filter((vote) => vote.userId !== MEMBER),
					...(choice === undefined && note === undefined
						? []
						: [
								{
									userId: MEMBER,
									...(choice === undefined ? {} : { choice }),
									...(note === undefined ? {} : { note }),
									updatedAt: "2026-11-10T10:10:00Z",
								},
							]),
				],
			};
		}),
		listOpenDecisions: vi.fn(async (): Promise<OpenDecision[]> => {
			if (!options.approvals && !options.drafts)
				throw new CloudRpcError(
					"qorpera_list_member_open_decisions",
					{ message: "missing", code: "PGRST202" },
					404,
				);
			return [...asOpenCards(questions), ...approvals, ...drafts];
		}),
		emailDraftEditor: (interactionId: string) => {
			let editor = editors.get(interactionId);
			if (!editor) {
				editor = {};
				editors.set(interactionId, editor);
			}
			return editor;
		},
		loadEmailDraft: vi.fn(async (sessionId: string, interactionId: string) => {
			draftStep(sessionId, interactionId, "load");
			return options.draft!("load");
		}),
		actEmailDraft: vi.fn(
			async (sessionId: string, interactionId: string, action: EmailDraftAction, content: EmailDraftContent) => {
				draftStep(sessionId, interactionId, action);
				return options.draft!(action, content);
			},
		),
		answerActionReview: vi.fn(
			async (sessionId: string, reviewId: string, answer: ActionReviewAnswer, ruleText?: string) => {
				reviews.push([sessionId, reviewId, answer, ruleText]);
				approvals = approvals.filter((item) => item.interactionId !== reviewId);
			},
		),
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
				await (options.gate ?? Promise.resolve());
				if (options.refuse) {
					store.set({ interactionAnswers: undefined, interactionError: options.refuse });
					throw new Error("refused");
				}
				questions = questions.filter((item) => item.interactionId !== interactionId);
			},
		),
	};
	const accounts = options.accounts ?? { listConnections: vi.fn(), selectSessionAccount: undefined };
	const open = new OpenQuestions(controller as unknown as CompanyController, accounts as never);
	const agent = { id: AGENT, displayName: "Bob", appearance: { color: "", shape: "" } } as unknown as HostedStaffAgent;
	const host: QuestionDockHost = {
		questions: open,
		agent: (id) => (id === AGENT ? agent : undefined),
		memberName: () => "Jonas",
		conversation,
	};
	return {
		controller,
		open,
		host,
		answers,
		reviews,
		draftSteps,
		votesCast,
		unlist: (interactionId: string) => {
			drafts = drafts.filter((item) => item.interactionId !== interactionId);
		},
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
		dock.dispose();
	});

	it("is headed once: who asks, its label row for a screen reader only", async () => {
		const { host } = company({ questions: [question(CARD_A, directions)] });
		const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
		document.body.append(dock.el);
		await settle();
		const heading = dock.el.querySelector(".interaction-heading");
		// Kept for a screen reader, shown to nobody: the dock's own head says who asks.
		expect(heading?.classList.contains("visually-hidden")).toBe(true);
		expect(heading?.textContent).toContain("Question");
		expect(dock.el.querySelector(".question-dock-title")?.textContent).toBe("Bob asks you");
		// The card draws no second "asks you" of its own under the dock's head.
		expect(dock.el.querySelector(".interaction-call")).toBeNull();
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

	it("shows the answer as sent while the cloud has not taken it yet", async () => {
		let take = () => {};
		const gate = new Promise<void>((resolve) => {
			take = resolve;
		});
		const { host } = company({ questions: [question(CARD_A, directions)], gate });
		const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
		document.body.append(dock.el);
		await settle();
		dock.el.querySelectorAll<HTMLButtonElement>(".choice-box")[0]?.click();
		await settle();
		expect(dock.el.textContent).toContain("Sending to Bob…");
		expect(dock.el.querySelector(".choice-box.is-chosen .choice-label")?.textContent).toBe("Calm");
		expect(dock.el.querySelector(".question-dock-burst")).toBeNull();
		take();
		await settle();
		expect(dock.el.textContent).toContain("Sent to Bob");
		dock.dispose();
	});

	it("gives the thread the account the cloud chooses now, on every answer", async () => {
		const selectSessionAccount = vi.fn(async () => "conn-2");
		const listConnections = vi.fn(async () => ({ connections: [] }));
		const { controller, open } = company({
			questions: [question(CARD_A, directions), question(CARD_B, directions)],
			accounts: { listConnections, selectSessionAccount },
		});
		// The thread already had an account: the cloud's current choice is read again anyway.
		controller.conversation(SESSION).set({ executionSponsor: { sponsorBindingId: "old" } } as never);
		await open.answer(question(CARD_A, directions), "answered", { values: ["calm"] });
		expect(selectSessionAccount).toHaveBeenCalledWith(SESSION, controller.signal);
		expect(controller.setExecutionSponsor).toHaveBeenCalledWith(SESSION, { connections: [] }, "conn-2");
		// A message on its way keeps the account it carries.
		controller.conversation(SESSION).set({ sending: true } as never);
		await open.answer(question(CARD_B, directions), "answered", { values: ["bold"] });
		expect(selectSessionAccount).toHaveBeenCalledTimes(1);
		expect(controller.answerInteraction).toHaveBeenCalledTimes(2);
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

	describe("when the member goes to another concept with an answer just given (review r1 of #1763, F3)", () => {
		/** One question about each concept: the calm shop's and the bold shop's. */
		const about = (app: string, title: string): InteractionRequest => ({
			surface: "question",
			title,
			payload: {
				options: [
					{ label: "Yes", value: "yes", preview: `app:${app}` },
					{ label: "No", value: "no" },
				],
			},
		});
		const calm = about("shop-calm", "Is the calm shop right?");
		const bold = about("shop-bold", "Is the bold shop right?");
		const both = () => [
			question(CARD_A, calm, "2026-11-10T10:00:00Z"),
			question(CARD_B, bold, "2026-11-10T09:00:00Z"),
		];
		/** The other concept's card stays on screen while the answered one's hold runs out, and nothing flies. */
		const staysOnBold = async (dock: QuestionDock) => {
			expect(dock.el.textContent).toContain("Is the bold shop right?");
			expect(dock.el.textContent).not.toContain("Is the calm shop right?");
			await vi.advanceTimersByTimeAsync(2_250);
			expect(dock.el.classList.contains("is-flying")).toBe(false);
			expect(dock.el.textContent).not.toContain("Is the calm shop right?");
			await vi.advanceTimersByTimeAsync(1_000);
			expect(dock.el.hidden).toBe(false);
			expect(dock.el.textContent).toContain("Is the bold shop right?");
		};

		it("keeps the answered card off the other concept's page while it is held", async () => {
			const { host, answers } = company({ questions: both() });
			const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
			document.body.append(dock.el);
			await settle();
			expect(dock.el.textContent).toContain("Is the calm shop right?");
			dock.el.querySelector<HTMLButtonElement>(".choice-box")?.click();
			await settle();
			expect(answers).toEqual([[SESSION, CARD_A, "answered", { values: ["yes"] }]]);
			expect(dock.el.textContent).toContain("Sent to Bob");
			// Right after the answer, the member opens the bold shop's concept.
			dock.setMatch((apps) => apps.has("shop-bold"));
			await staysOnBold(dock);
			dock.dispose();
		});

		it("keeps it off when the answer is taken after the member left", async () => {
			let take = () => {};
			const gate = new Promise<void>((resolve) => {
				take = resolve;
			});
			const { host } = company({ questions: both(), gate });
			const dock = new QuestionDock(host, (apps) => apps.has("shop-calm"));
			document.body.append(dock.el);
			await settle();
			dock.el.querySelector<HTMLButtonElement>(".choice-box")?.click();
			await settle();
			expect(dock.el.textContent).toContain("Sending to Bob…");
			// While the answer is on its way, the member opens the bold shop's concept; then the cloud takes the answer.
			dock.setMatch((apps) => apps.has("shop-bold"));
			expect(dock.el.textContent).toContain("Is the bold shop right?");
			take();
			await settle();
			await staysOnBold(dock);
			dock.dispose();
		});
	});

	it("brings an app's preview into its card once the company's apps are read, keeping an answer being typed", async () => {
		const request: InteractionRequest = {
			surface: "question",
			title: "Viser scenerne den lampe, du forestiller dig?",
			payload: {
				allowCustom: true,
				options: [
					{ label: "Ja, sådan", value: "ja", preview: "app:shop-calm" },
					{ label: "Noget skal ændres", value: "nej" },
				],
			},
		};
		const { host } = company({ questions: [question(CARD_A, request)] });
		// The company's apps are not read yet when the dock draws the card (review r1 of #1763, F1).
		let read = false;
		const app = (name: string) =>
			read && name === "shop-calm" ? { title: "The calm shop", emblem: "star" as const, cover: null } : undefined;
		const dock = new QuestionDock({ ...host, app }, (apps) => apps.has("shop-calm"));
		document.body.append(dock.el);
		await settle();
		expect(dock.el.querySelector(".choice-picture")).toBeNull();
		const field = dock.el.querySelector<HTMLInputElement>(".interaction-field");
		if (!field) throw new Error("no field");
		field.value = "Mere lys";
		read = true;
		// What the page does after each read of the company's apps (app/application.ts decorateAppCards).
		refreshAppPreviews(document.body, app);
		expect(dock.el.querySelector(".choice-box .choice-app-name")?.textContent).toBe("The calm shop");
		expect(dock.el.querySelector(".interaction-field")).toBe(field);
		expect(field.value).toBe("Mere lys");
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
		// A second hint within the interval queues a trailing read; the last watcher leaving drops it.
		hint();
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

describe("open decisions from the cloud", () => {
	const REVIEW = "55555555-5555-4555-8555-00000000000b";
	const row = { sessionId: SESSION, staffAgentId: AGENT, createdAt: "2026-11-10T10:00:00Z", canAnswer: true };
	const review = {
		schema: "qorpera.action-review/v1",
		reviewId: REVIEW,
		title: "Send an email",
		summary: "It writes to someone outside the company.",
		builtIn: "none",
		approverScope: "owners_admins",
		alwaysAllow: false,
	};

	it("keeps the questions, approvals and Gmail drafts it can draw and drops the rest", () => {
		const parsed = parseOpenDecisions({
			schema: "qorpera.member-open-decisions/v1",
			decisions: [
				{ ...row, kind: "approval", id: REVIEW.toUpperCase(), answererUserId: null, review },
				{ ...row, kind: "question", id: CARD_A, answererUserId: MEMBER, sequence: 7, body: body(directions) },
				{ ...row, kind: "draft", id: CARD_B, answererUserId: MEMBER, sequence: 8, body: body(directions) },
				{ ...row, kind: "draft", id: DRAFT, answererUserId: MEMBER, sequence: 9, body: body(letter) },
				{
					...row,
					kind: "draft",
					id: CARD_C,
					answererUserId: MEMBER,
					sequence: 10,
					body: body({ ...letter, payload: { ...letter.payload, connectorId: "outlook" } }),
				},
				{ ...row, kind: "approval", id: CARD_C, answererUserId: null, review },
				{ ...row, kind: "approval", id: REVIEW, answererUserId: null, review: { schema: "other" } },
			],
		});
		expect(parsed.map((decision) => [decision.kind, decision.interactionId])).toEqual([
			["approval", REVIEW],
			["question", CARD_A],
			["draft", DRAFT],
		]);
		expect(parsed[0]?.kind === "approval" && parsed[0].review.title).toBe("Send an email");
		expect(parsed[1]?.kind === "question" && parsed[1].actorUserId).toBe(MEMBER);
		expect(() => parseOpenDecisions({ schema: "other", decisions: [] })).toThrow();
	});
});

describe("the decisions dock in the Co-Founder chat", () => {
	const name: InteractionRequest = {
		surface: "question",
		title: "What should the app be called?",
		payload: { options: [{ label: "mywave" }, { label: "Not yet" }], allowCustom: true },
	};
	const cards = () => [
		question(CARD_A, directions, "2026-11-10T10:00:00Z"),
		question(CARD_B, name, "2026-11-10T09:00:00Z"),
		question(
			CARD_C,
			{ ...name, title: "Launch this week?", expiresAt: "2099-01-01T00:00:00Z" },
			"2026-11-10T11:00:00Z",
		),
	];
	const tabs = (dock: DecisionDock) => [...dock.el.querySelectorAll<HTMLElement>(".decision-tab")];
	const chosen = (dock: DecisionDock) =>
		dock.el.querySelector<HTMLElement>('.decision-tab[aria-selected="true"]')?.dataset.decision;

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	it("orders decisions once and for all: the one that runs out first, then the oldest", () => {
		expect(
			asOpenCards(cards())
				.sort(decisionOrder)
				.map((card) => card.interactionId),
		).toEqual([CARD_C, CARD_B, CARD_A]);
	});

	it("shows every open question, one card at a time, with a tab for each under it", async () => {
		const { host } = company({ questions: cards() });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.hidden).toBe(false);
		expect(dock.el.querySelectorAll(".decision-card .interaction-card")).toHaveLength(1);
		expect(dock.el.querySelector(".decision-card .interaction-card")?.classList.contains("is-asking")).toBe(true);
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("Launch this week?");
		expect(dock.el.querySelector(".interaction-call strong")?.textContent).toBe("Bob asks you");
		expect(dock.el.querySelector(".interaction-call strong b")?.textContent).toBe("Bob");
		expect(dock.el.querySelector(".decision-figure .figure")).not.toBeNull();
		expect(tabs(dock).map((tab) => tab.querySelector(".decision-tab-label")?.textContent)).toEqual([
			"Launch this week?",
			"What should the app be called?",
			"Which direction should the shop take?",
		]);
		expect(dock.el.querySelector(".decision-tabs")?.getAttribute("role")).toBe("tablist");
		expect(chosen(dock)).toBe(CARD_C);
		expect(tabs(dock).map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
		expect(dock.waiting).toBe([CARD_C, CARD_B, CARD_A].join(" "));
		expect(dock.shows(CARD_A.toUpperCase())).toBe(true);
		dock.dispose();
	});

	it("flicks by a tab and by the arrow keys, and keeps the tabs where they stand", async () => {
		const { host } = company({ questions: cards() });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const first = tabs(dock);
		first[2]?.click();
		expect(chosen(dock)).toBe(CARD_A);
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("Which direction should the shop take?");
		expect(tabs(dock)).toEqual(first);
		const key = (name: string) =>
			dock.el
				.querySelector(".decision-tabs")
				?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
		key("ArrowRight");
		expect(chosen(dock)).toBe(CARD_C);
		key("ArrowLeft");
		expect(chosen(dock)).toBe(CARD_A);
		expect(document.activeElement).toBe(first[2]);
		dock.dispose();
	});

	const pick = (dock: DecisionDock, label: string) =>
		[...dock.el.querySelectorAll<HTMLButtonElement>(".interaction-options .btn")]
			.find((pill) => pill.textContent === label)
			?.click();

	it("holds a pick five seconds with Undo, then sends it to the asking agent's thread", async () => {
		const { host, answers } = company({ questions: cards().slice(0, 2) });
		const dock = new DecisionDock(host);
		const changes = vi.fn();
		dock.onChange(changes);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("What should the app be called?");
		pick(dock, "mywave");
		await settle();
		expect(answers).toEqual([]);
		expect(dock.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[CARD_B, "held"]]);
		expect(dock.decidedKey).toBe(`${CARD_B}:held`);
		expect(dock.shows(CARD_B)).toBe(true);
		expect(changes).toHaveBeenCalled();
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("Which direction should the shop take?");
		expect(dock.el.querySelector<HTMLElement>(".decision-tabs")?.hidden).toBe(true);
		const held = dock.renderDecided(dock.decided[0]!);
		expect(held.querySelector(".decided-rule")?.textContent).toBe("Decided");
		expect(held.querySelector(".decided-ask")?.textContent).toBe("What should the app be called?");
		expect(held.querySelector(".decided-answer")?.textContent).toBe("mywave");
		expect(held.querySelector(".decided-by span")?.textContent).toBe("Goes to Bob in a moment");
		expect(held.querySelector(".decided-undo")?.textContent).toBe("Undo");

		await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
		expect(answers).toEqual([]);
		await vi.advanceTimersByTimeAsync(2);
		await settle();
		expect(answers).toEqual([[SESSION, CARD_B, "answered", { values: ["mywave"] }]]);
		expect(dock.decided[0]?.state).toBe("sent");
		expect(dock.shows(CARD_B)).toBe(true);
		const sent = dock.renderDecided(dock.decided[0]!);
		expect(sent.querySelector(".decided-by span")?.textContent).toBe("Sent to Bob");
		expect(sent.querySelector(".decided-undo")).toBeNull();
		dock.dispose();
	});

	it("takes a pick back on Undo: nothing is sent and the card stands again", async () => {
		const { host, answers } = company({ questions: cards().slice(0, 2) });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		pick(dock, "mywave");
		await settle();
		dock.renderDecided(dock.decided[0]!).querySelector<HTMLButtonElement>(".decided-undo")?.click();
		expect(dock.decided).toEqual([]);
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("What should the app be called?");
		expect(tabs(dock)).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1_000);
		expect(answers).toEqual([]);
		dock.dispose();
	});

	it("names a typed note and a skip for what they are", async () => {
		const { host } = company({ questions: cards().slice(0, 2) });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const field = dock.el.querySelector<HTMLInputElement>(".interaction-field");
		if (!field) throw new Error("field expected");
		field.value = "Something calmer";
		field.dispatchEvent(new Event("input"));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		await settle();
		const note = dock.renderDecided(dock.decided[0]!);
		expect(note.querySelector(".decided-rule")?.textContent).toBe("Your note");
		expect(note.querySelector(".decided-answer")?.textContent).toBe("“Something calmer”");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		dock.el.querySelector<HTMLButtonElement>(".interaction-quiet")?.click();
		await settle();
		const skipped = dock.renderDecided(dock.decided[1]!);
		expect(skipped.querySelector(".decided-rule")?.textContent).toBe("Skipped");
		expect(skipped.querySelector(".decided-answer")).toBeNull();
		expect(dock.el.hidden).toBe(true);
		dock.dispose();
	});

	it("sends what it holds at once when the chat is left, and the next dock knows what was decided", async () => {
		const { host, answers } = company({ questions: cards().slice(0, 2) });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		pick(dock, "mywave");
		await settle();
		dock.dispose();
		await settle();
		expect(answers).toEqual([[SESSION, CARD_B, "answered", { values: ["mywave"] }]]);
		const again = new DecisionDock(host);
		expect(again.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[CARD_B, "sent"]]);
		expect(again.shows(CARD_B)).toBe(true);
		again.dispose();
	});

	it("sends what it holds when the page is hidden or goes, and asks before a close while it holds", async () => {
		const { host, answers } = company({ questions: cards() });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const calm = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(calm);
		expect(calm.defaultPrevented).toBe(false);

		dock.el.querySelector<HTMLButtonElement>(".interaction-quiet")?.click();
		await settle();
		window.dispatchEvent(new Event("pagehide"));
		await settle();
		expect(answers).toEqual([[SESSION, CARD_C, "declined", {}]]);

		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		pick(dock, "mywave");
		await settle();
		const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		hidden.mockRestore();
		expect(answers).toHaveLength(2);
		expect(answers[1]).toEqual([SESSION, CARD_B, "answered", { values: ["mywave"] }]);

		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		dock.el.querySelector<HTMLElement>(".choice-box, .interaction-options .btn")?.click();
		await settle();
		const leaving = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(leaving);
		expect(leaving.defaultPrevented).toBe(true);
		await settle();
		expect(answers).toHaveLength(3);
		dock.dispose();
	});

	it("drops a sent decision whose answer never reached the agent, so its card is drawn again", async () => {
		const { host } = company({ questions: cards().slice(0, 2) });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		pick(dock, "mywave");
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["sent"]);
		expect(dock.shows(CARD_B)).toBe(true);
		const failedBefore = {
			kind: "interaction" as const,
			id: CARD_B,
			sequence: 7,
			actorUserId: MEMBER,
			request: name,
			createdAt: "2026-11-10T09:00:00Z",
			answerFailed: true,
		};
		host.conversation(SESSION).set({ projection: { items: [failedBefore], hiddenCount: 0, lastSequence: 7 } });
		expect(host.conversation(SESSION).get().interactionAnswers?.[CARD_B]).toBeDefined();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["sent"]);
		expect(dock.shows(CARD_B)).toBe(true);
		const changes = vi.fn();
		dock.onChange(changes);
		host.conversation(SESSION).set({
			interactionAnswers: undefined,
			projection: {
				items: [
					{
						kind: "interaction",
						id: CARD_B,
						sequence: 7,
						actorUserId: MEMBER,
						request: name,
						createdAt: "2026-11-10T09:00:00Z",
						answerFailed: true,
					},
				],
				hiddenCount: 0,
				lastSequence: 7,
			},
		});
		await settle();
		expect(changes).toHaveBeenCalledTimes(1);
		expect(dock.shows(CARD_B)).toBe(false);
		expect(dock.decided).toEqual([]);
		expect(dock.decidedKey).toBe("");
		dock.dispose();
	});

	it("hears of a decided card's thread being read while no card of that thread is on screen", async () => {
		const { host } = company({ questions: [question(CARD_B, name)] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		pick(dock, "mywave");
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["sent"]);
		expect(dock.el.hidden).toBe(true);
		const changes = vi.fn();
		dock.onChange(changes);
		host.conversation(SESSION).set({
			interactionAnswers: undefined,
			projection: {
				items: [
					{
						kind: "interaction",
						id: CARD_B,
						sequence: 7,
						actorUserId: MEMBER,
						request: name,
						createdAt: "2026-11-10T09:00:00Z",
						answerFailed: true,
					},
				],
				hiddenCount: 0,
				lastSequence: 7,
			},
		});
		await settle();
		expect(changes).toHaveBeenCalledTimes(1);
		expect(dock.el.hidden).toBe(true);
		expect(dock.decided).toEqual([]);
		dock.dispose();
	});

	it("tells the dock that stands now when an answer sent on leaving is refused", async () => {
		let refuse = () => {};
		const gate = new Promise<void>((resolve) => {
			refuse = resolve;
		});
		const { host } = company({
			questions: [question(CARD_B, name)],
			refuse: "Select an active model account.",
			gate,
		});
		const left = new DecisionDock(host);
		document.body.append(left.el);
		await settle();
		pick(left, "mywave");
		await settle();
		left.dispose();
		const now = new DecisionDock(host);
		document.body.append(now.el);
		await settle();
		expect(now.decided.map((entry) => entry.state)).toEqual(["sending"]);
		expect(now.el.hidden).toBe(true);
		refuse();
		await settle();
		expect(now.decided).toEqual([]);
		expect(now.el.hidden).toBe(false);
		expect(now.el.querySelector(".decision-error")?.textContent).toBe("Select an active model account.");
		now.dispose();
	});

	it("brings the card back and says why when the answer is refused", async () => {
		const { host } = company({ questions: [question(CARD_B, name)], refuse: "Select an active model account." });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		pick(dock, "mywave");
		await settle();
		expect(dock.el.hidden).toBe(true);
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await settle();
		expect(dock.decided).toEqual([]);
		expect(dock.el.hidden).toBe(false);
		expect(dock.el.querySelector(".decision-error")?.textContent).toBe("Select an active model account.");
		expect(dock.el.querySelector(".decision-card .interaction-card")?.classList.contains("is-asking")).toBe(true);
		dock.dispose();
	});

	it("lets a card go the moment its time is up, so its thread shows it past its time", async () => {
		vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
		const soon = question(CARD_C, { ...name, title: "Launch today?", expiresAt: "2026-11-10T12:00:30Z" });
		const gone = question(CARD_A, { ...name, expiresAt: "2026-11-10T11:59:00Z" });
		const { host } = company({ questions: [soon, question(CARD_B, name), gone] });
		const dock = new DecisionDock(host);
		const changes = vi.fn();
		dock.onChange(changes);
		document.body.append(dock.el);
		await settle();
		expect(dock.waiting).toBe([CARD_C, CARD_B].join(" "));
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("Launch today?");
		changes.mockClear();
		await vi.advanceTimersByTimeAsync(30_001);
		expect(dock.waiting).toBe(CARD_B);
		expect(dock.shows(CARD_C)).toBe(false);
		expect(changes).toHaveBeenCalledTimes(1);
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("What should the app be called?");
		dock.dispose();
	});

	it("marks a card taller than its room as cut until it is scrolled to its end", async () => {
		const { host } = company({ questions: [question(CARD_B, name)] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const card = dock.el.querySelector<HTMLElement>(".decision-card > .interaction-card");
		if (!card) throw new Error("card expected");
		Object.defineProperty(card, "scrollHeight", { value: 500 });
		Object.defineProperty(card, "clientHeight", { value: 300 });
		card.dispatchEvent(new Event("scroll"));
		expect(card.classList.contains("is-cut")).toBe(true);
		card.scrollTop = 198;
		card.dispatchEvent(new Event("scroll"));
		expect(card.classList.contains("is-cut")).toBe(false);
		dock.dispose();
	});

	it("marks a cut card as it is drawn, before any scroll, and lets its observer go with the card", async () => {
		const made: { run: () => void; seen: Element[]; gone: boolean }[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly #entry: { run: () => void; seen: Element[]; gone: boolean };
				constructor(run: () => void) {
					this.#entry = { run, seen: [], gone: false };
					made.push(this.#entry);
				}
				observe(target: Element) {
					this.#entry.seen.push(target);
				}
				disconnect() {
					this.#entry.gone = true;
				}
			},
		);
		const { host } = company({
			questions: [question(CARD_B, name), question(CARD_A, directions, "2026-11-10T11:00:00Z")],
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const shown = () => {
			const card = dock.el.querySelector<HTMLElement>(".decision-card > .interaction-card");
			if (!card) throw new Error("card expected");
			return card;
		};
		const card = shown();
		const first = made.find((entry) => entry.seen.includes(card));
		expect(first?.seen).toEqual([card, ...card.children]);
		expect(card.children.length).toBeGreaterThan(0);
		Object.defineProperty(card, "scrollHeight", { value: 500 });
		Object.defineProperty(card, "clientHeight", { value: 300 });
		first?.run();
		expect(card.classList.contains("is-cut")).toBe(true);

		tabs(dock)[1]?.click();
		expect(first?.gone).toBe(true);
		const second = made.find((entry) => entry.seen.includes(shown()));
		expect(second).not.toBe(first);
		expect(second?.gone).toBe(false);
		dock.dispose();
		expect(second?.gone).toBe(true);
	});

	it("lets the observer go when the last decision leaves", async () => {
		const made: { seen: Element[]; gone: boolean }[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly #entry: { seen: Element[]; gone: boolean } = { seen: [], gone: false };
				constructor() {
					made.push(this.#entry);
				}
				observe(target: Element) {
					this.#entry.seen.push(target);
				}
				disconnect() {
					this.#entry.gone = true;
				}
			},
		);
		const { host, open } = company({ questions: [question(CARD_B, name)] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const card = dock.el.querySelector(".decision-card > .interaction-card");
		const watching = made.find((entry) => card !== null && entry.seen.includes(card));
		expect(watching?.gone).toBe(false);
		open.forget(CARD_B);
		await settle();
		expect(dock.el.hidden).toBe(true);
		expect(watching?.gone).toBe(true);
		dock.dispose();
	});

	const REVIEW = "55555555-5555-4555-8555-00000000000a";
	const approval: OpenApproval = {
		kind: "approval",
		sessionId: SESSION,
		interactionId: REVIEW,
		staffAgentId: AGENT,
		createdAt: "2026-11-10T08:00:00Z",
		review: {
			reviewId: REVIEW,
			title: "Send an email",
			summary: "It writes to someone outside the company.",
			target: "bob@acme.test",
			details: [],
			builtIn: "none",
			rules: [],
			approverScope: "member",
			approverUserId: MEMBER,
			alwaysAllow: false,
		},
	};

	it("draws an approval as its own card, holds the answer with Undo, then sends it as its thread does", async () => {
		const { host, reviews, answers, controller } = company({
			questions: [question(CARD_B, name)],
			approvals: [approval],
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(controller.listOpenDecisions).toHaveBeenCalledTimes(1);
		expect(controller.listOpenQuestions).not.toHaveBeenCalled();
		expect(tabs(dock).map((tab) => tab.querySelector(".decision-tab-label")?.textContent)).toEqual([
			"Send an email",
			"What should the app be called?",
		]);
		expect(dock.el.querySelector(".decision-card > .auth-card h3")?.textContent).toBe("Send an email");
		expect(dock.el.querySelector(".decision-card .interaction-card")).toBeNull();
		[...dock.el.querySelectorAll<HTMLButtonElement>(".decision-card button")]
			.find((button) => button.textContent === "Allow once")
			?.click();
		await settle();
		expect(reviews).toEqual([]);
		expect(dock.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[REVIEW, "held"]]);
		expect(dock.shows(REVIEW)).toBe(true);
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("What should the app be called?");
		const block = dock.renderDecided(dock.decided[0]!);
		expect(block.querySelector(".decided-rule")?.textContent).toBe("Allowed once");
		expect(block.querySelector(".decided-ask")?.textContent).toBe("Send an email");
		expect(block.querySelector(".decided-answer")).toBeNull();
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await settle();
		expect(reviews).toEqual([[SESSION, REVIEW, "allow_once", undefined]]);
		expect(answers).toEqual([]);
		expect(dock.decided[0]?.state).toBe("sent");
		dock.dispose();
	});

	it("says Denied for a denied approval, and Undo puts its card back", async () => {
		const { host, reviews } = company({ approvals: [approval] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		[...dock.el.querySelectorAll<HTMLButtonElement>(".decision-card button")]
			.find((button) => button.textContent === "Deny")
			?.click();
		await settle();
		const block = dock.renderDecided(dock.decided[0]!);
		expect(block.querySelector(".decided-rule")?.textContent).toBe("Denied");
		expect(dock.el.hidden).toBe(true);
		block.querySelector<HTMLButtonElement>(".decided-undo")?.click();
		expect(dock.el.hidden).toBe(false);
		expect(dock.el.querySelector(".decision-card > .auth-card")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1_000);
		expect(reviews).toEqual([]);
		dock.dispose();
	});

	it("tells the company how many decisions wait, as the list changes", async () => {
		const { host, controller } = company({ questions: [question(CARD_B, name)], approvals: [approval] });
		const stop = host.questions.watch();
		await settle();
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(2);
		host.questions.hold(REVIEW);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(1);
		host.questions.release(REVIEW);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(2);
		host.questions.hold(CARD_B);
		host.questions.forget(CARD_B);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(1);
		stop();
	});

	it("leaves a decision out of the count from the pick on, and counts it again on Undo", async () => {
		const { host, controller } = company({ questions: cards().slice(0, 2) });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(2);
		pick(dock, "mywave");
		await settle();
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(1);
		dock.undo(CARD_B);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(2);
		pick(dock, "mywave");
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await settle();
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(1);
		dock.dispose();
	});

	it("reads again the moment the company's membership is known, and when it stops being writable", async () => {
		const { host, controller } = company({ questions: [question(CARD_B, name)] });
		controller.store.set({ team: undefined as never });
		await settle();
		const stop = host.questions.watch();
		await settle();
		const before = controller.listOpenQuestions.mock.calls.length;
		controller.store.set({ team: { capabilities: { read: true, write: true } } });
		await settle();
		expect(controller.listOpenQuestions.mock.calls.length).toBe(before + 1);
		const then = controller.listOpenQuestions.mock.calls.length;
		controller.store.set({ team: { capabilities: { read: true, write: true } } });
		await settle();
		expect(controller.listOpenQuestions.mock.calls.length).toBe(then);
		controller.store.set({ team: { capabilities: { read: true, write: false } } });
		await settle();
		expect(controller.listOpenQuestions.mock.calls.length).toBe(then + 1);
		stop();
	});

	it("asks a cloud without the company's list once while the company is open, and reads the member's own list as before", async () => {
		const { host, controller } = company({ questions: [question(CARD_B, name)], approvals: [approval] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(tabs(dock).map((tab) => [tab.dataset.decision, tab.classList.contains("is-others")])).toEqual([
			[REVIEW, false],
			[CARD_B, false],
		]);
		expect(dock.el.querySelector(".decision-note")).toBeNull();
		expect(dock.el.querySelector(".vote-faces")).toBeNull();
		await host.questions.refresh();
		await host.questions.refresh();
		expect(controller.listCompanyOpenDecisions).toHaveBeenCalledTimes(1);
		expect(controller.listOpenDecisions).toHaveBeenCalledTimes(3);
		expect(controller.listOpenQuestions).not.toHaveBeenCalled();
		expect(controller.castDecisionVote).not.toHaveBeenCalled();
		dock.dispose();

		const neither = company({ questions: [question(CARD_B, name)] });
		const older = new DecisionDock(neither.host);
		document.body.append(older.el);
		await settle();
		await neither.host.questions.refresh();
		expect(neither.controller.listCompanyOpenDecisions).toHaveBeenCalledTimes(1);
		expect(neither.controller.listOpenDecisions).toHaveBeenCalledTimes(1);
		expect(neither.controller.listOpenQuestions).toHaveBeenCalledTimes(2);
		older.dispose();
	});

	it("falls back to the questions alone while the cloud has no list of decisions", async () => {
		const { host, controller } = company({ questions: [question(CARD_B, name)] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("What should the app be called?");
		await host.questions.refresh();
		expect(controller.listOpenDecisions).toHaveBeenCalledTimes(1);
		expect(controller.listOpenQuestions).toHaveBeenCalledTimes(2);
		dock.dispose();
	});

	const content: EmailDraftContent = { to: ["ada@acme.test"], cc: [], subject: "Our offer", body: "Hello Ada" };
	const readyDraft: EmailDraftState = { from: "jonas@mywave.test", content, status: "ready" };
	const draft: OpenDraft = {
		kind: "draft",
		sessionId: SESSION,
		interactionId: DRAFT,
		sequence: 9,
		actorUserId: MEMBER,
		staffAgentId: AGENT,
		request: letter,
		createdAt: "2026-11-10T07:00:00Z",
	};
	const rest = async () => {
		for (let i = 0; i < 6; i++) await settle();
	};
	const press = (dock: DecisionDock, label: string) =>
		[...dock.el.querySelectorAll<HTMLButtonElement>(".decision-card button")]
			.find((button) => button.textContent === label)
			?.click();

	it("draws a Gmail draft as its thread's email card and sends it at once, with no hold and no Undo", async () => {
		const selectSessionAccount = vi.fn(async () => "conn-2");
		const { host, draftSteps, controller } = company({
			questions: [question(CARD_B, name)],
			drafts: [draft],
			draft: async (action) => (action === "send" ? { ...readyDraft, status: "sent" } : readyDraft),
			accounts: { listConnections: vi.fn(async () => ({})), selectSessionAccount },
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		expect(tabs(dock).map((tab) => tab.querySelector(".decision-tab-label")?.textContent)).toEqual([
			"New email",
			"What should the app be called?",
		]);
		expect(dock.el.querySelector(".decision-card > .email-draft-card .email-draft-from")?.textContent).toBe(
			"jonas@mywave.test",
		);
		expect(dock.shows(DRAFT)).toBe(true);
		expect(selectSessionAccount).not.toHaveBeenCalled();
		press(dock, "Send email");
		await rest();
		expect(draftSteps).toEqual([
			[SESSION, DRAFT, "load"],
			[SESSION, DRAFT, "send"],
		]);
		expect(selectSessionAccount).toHaveBeenCalledWith(SESSION, controller.signal);
		expect(controller.actEmailDraft).toHaveBeenCalledWith(SESSION, DRAFT, "send", content);
		expect(dock.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[DRAFT, "sent"]]);
		const block = dock.renderDecided(dock.decided[0]!);
		expect(block.querySelector(".decided-rule")?.textContent).toBe("Email sent");
		expect(block.querySelector(".decided-answer")?.textContent).toBe("Our offer");
		expect(block.querySelector(".decided-by span")?.textContent).toBe("To ada@acme.test");
		expect(block.querySelector(".decided-undo")).toBeNull();
		expect(dock.el.querySelector(".decision-card .email-draft-card")).toBeNull();
		expect(dock.el.querySelector(".interaction-title")?.textContent).toBe("What should the app be called?");
		expect(dock.shows(DRAFT)).toBe(true);
		dock.dispose();
	});

	it("says a discarded draft was not sent, and keeps a draft saved to Gmail where it stands", async () => {
		const { host, draftSteps } = company({
			drafts: [draft],
			draft: async (action) =>
				action === "discard"
					? { ...readyDraft, status: "discarded" }
					: action === "save"
						? { ...readyDraft, status: "saved" }
						: readyDraft,
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		press(dock, "Save to Gmail");
		await rest();
		expect(dock.decided).toEqual([]);
		expect(dock.el.querySelector(".decision-card .email-draft-status")?.textContent).toBe("Saved to Gmail");
		press(dock, "Discard");
		await rest();
		expect(draftSteps.map((step) => step[2])).toEqual(["load", "save", "discard"]);
		const block = dock.renderDecided(dock.decided[0]!);
		expect(block.querySelector(".decided-rule")?.textContent).toBe("Discarded");
		expect(block.querySelector(".decided-by span")?.textContent).toBe("Nothing was sent");
		expect(dock.el.hidden).toBe(true);
		dock.dispose();
	});

	it("keeps a draft whose send was not confirmed, also once the list has let it go, until a read settles it", async () => {
		let sent = false;
		const { host, open, unlist } = company({
			drafts: [draft],
			draft: async (action) => {
				if (action === "send") throw new Error("The connection dropped");
				return sent ? { ...readyDraft, status: "sent" } : readyDraft;
			},
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		press(dock, "Send email");
		await rest();
		expect(dock.decided).toEqual([]);
		expect(dock.el.querySelector(".decision-card .email-draft-status")?.textContent).toBe("Send unconfirmed");
		unlist(DRAFT);
		await open.refresh();
		await rest();
		expect(open.store.get().decisions).toEqual([]);
		expect(dock.el.hidden).toBe(false);
		expect(dock.shows(DRAFT)).toBe(true);
		expect(dock.el.querySelector(".decision-card .email-draft-error")?.textContent).toBe("The connection dropped");

		const next = new DecisionDock(host);
		document.body.append(next.el);
		await rest();
		expect(next.el.querySelector(".decision-card .email-draft-status")?.textContent).toBe("Send unconfirmed");
		next.dispose();

		sent = true;
		press(dock, "Refresh");
		await rest();
		expect(dock.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[DRAFT, "sent"]]);
		expect(dock.el.hidden).toBe(true);
		dock.dispose();
	});

	it("keeps a sent email whose agent was not told in the dock, and picks the account only to tell the agent", async () => {
		let owed: boolean[] = [];
		const selectSessionAccount = vi.fn(async () => "conn-2");
		const { host, open, unlist, draftSteps, controller } = company({
			drafts: [draft],
			draft: async (action) =>
				action === "send"
					? { ...readyDraft, status: "sent", actionId: CARD_C, notificationPending: true }
					: draftSteps.length > 1
						? { ...readyDraft, status: "sent", actionId: CARD_C, notificationPending: owed.shift() ?? false }
						: readyDraft,
			accounts: { listConnections: vi.fn(async () => ({})), selectSessionAccount },
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		expect(selectSessionAccount).not.toHaveBeenCalled();
		press(dock, "Send email");
		await rest();
		unlist(DRAFT);
		await open.refresh();
		await rest();
		expect(dock.decided).toEqual([]);
		expect(dock.el.querySelector(".decision-card .email-draft-note")?.textContent).toBe(
			"Your email action is complete. The agent has not been notified yet.",
		);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(1);
		selectSessionAccount.mockClear();
		owed = [true, false];
		press(dock, "Retry notifying agent");
		await rest();
		expect(selectSessionAccount).toHaveBeenCalledExactlyOnceWith(SESSION, controller.signal);
		expect(draftSteps.slice(-2)).toEqual([
			[SESSION, DRAFT, "load"],
			[SESSION, DRAFT, "load"],
		]);
		expect(dock.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[DRAFT, "sent"]]);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(0);
		dock.dispose();
	});

	it("keeps a draft whose send was not confirmed when its time runs out, and sets no clock for a time that has passed", async () => {
		vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
		const timed: OpenDraft = { ...draft, request: { ...letter, expiresAt: "2026-11-10T12:00:10Z" } };
		const reads: EmailDraftState["status"][] = ["ready", "unconfirmed", "sent"];
		const { host } = company({
			drafts: [timed],
			draft: async (action) => {
				if (action === "send") throw new Error("The connection dropped");
				return { ...readyDraft, status: reads.shift() ?? "sent" };
			},
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		press(dock, "Send email");
		await rest();
		await vi.advanceTimersByTimeAsync(11_000);
		await rest();
		expect(dock.shows(DRAFT)).toBe(true);
		expect(dock.el.querySelector(".decision-card .email-draft-error")?.textContent).toBe("The connection dropped");
		expect(vi.getTimerCount()).toBeLessThanOrEqual(1);

		press(dock, "Refresh");
		await rest();
		expect(dock.el.querySelector(".decision-card .email-draft-status")?.textContent).toBe("Send unconfirmed");
		expect(dock.decided).toEqual([]);
		const again = new DecisionDock(host);
		document.body.append(again.el);
		await rest();
		expect(
			[...again.el.querySelectorAll<HTMLButtonElement>(".decision-card button")].map((button) => button.textContent),
		).toContain("Refresh");
		again.dispose();
		press(dock, "Refresh");
		await rest();
		expect(dock.decided.map((entry) => [entry.decision.interactionId, entry.state])).toEqual([[DRAFT, "sent"]]);
		dock.dispose();
	});

	it("marks a draft taller than its room as cut once its card has drawn itself again with the sender", async () => {
		const seen = new Set<Element>();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe(target: Element) {
					seen.add(target);
				}
				disconnect() {}
			},
		);
		let loaded: (state: EmailDraftState) => void = () => {};
		const { host } = company({
			drafts: [draft],
			draft: () =>
				new Promise<EmailDraftState>((resolve) => {
					loaded = resolve;
				}),
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		const card = dock.el.querySelector<HTMLElement>(".decision-card > .email-draft-card");
		if (!card) throw new Error("card expected");
		Object.defineProperty(card, "scrollHeight", { value: 500 });
		Object.defineProperty(card, "clientHeight", { value: 300 });
		expect(card.classList.contains("is-cut")).toBe(false);
		loaded(readyDraft);
		await rest();
		expect(card.querySelector(".email-draft-from")?.textContent).toBe("jonas@mywave.test");
		expect(card.classList.contains("is-cut")).toBe(true);
		expect([...card.children].every((part) => seen.has(part))).toBe(true);
		dock.dispose();
	});

	it("marks only the Gmail draft for the dock's email layout, never the approval of an email", async () => {
		const { host } = company({
			approvals: [{ ...approval, review: { ...approval.review, tool: "gmail_send_message" } }],
			drafts: [draft],
			draft: async () => readyDraft,
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		const shown = () => dock.el.querySelector<HTMLElement>(".decision-card > .email-draft-card");
		expect(shown()?.matches(".surface-draft")).toBe(true);
		tabs(dock)
			.find((tab) => tab.dataset.decision === REVIEW)
			?.click();
		expect(shown()?.matches(".review-email")).toBe(true);
		expect(shown()?.matches(".surface-draft")).toBe(false);
		dock.dispose();
	});

	const SARA = "33333333-3333-4333-8333-00000000000b";
	const others = (id: string, request: InteractionRequest, votes: OpenDecision["votes"] = []): OpenDecision => ({
		...asOpenCards([question(id, request)])[0]!,
		actorUserId: SARA,
		othersAnswer: true,
		votes,
	});
	const option = (dock: DecisionDock, value: string) =>
		dock.el.querySelector<HTMLButtonElement>(`.decision-card [data-option-value="${value}"]`);

	it("reads every member's decisions with their votes, and knows which ones another member answers", () => {
		const listedRow = { sessionId: SESSION, staffAgentId: AGENT, createdAt: "2026-11-10T10:00:00Z" };
		const parsed = parseOpenDecisions({
			schema: "qorpera.company-open-decisions/v1",
			decisions: [
				{
					...listedRow,
					kind: "question",
					id: CARD_A,
					answererUserId: SARA,
					canAnswer: false,
					sequence: 7,
					body: body(directions),
					votes: [
						{ userId: MEMBER, choice: "calm", note: null, updatedAt: "2026-11-10T10:05:00Z" },
						{ userId: SARA, choice: null, note: "Either works.", updatedAt: "2026-11-10T10:06:00Z" },
					],
				},
				{
					...listedRow,
					kind: "question",
					id: CARD_B,
					answererUserId: MEMBER,
					canAnswer: true,
					sequence: 8,
					body: body(directions),
					votes: [],
				},
			],
		});
		expect(parsed.map((decision) => [decision.interactionId, decision.othersAnswer, decision.votes])).toEqual([
			[
				CARD_A,
				true,
				[
					{ userId: MEMBER, choice: "calm", updatedAt: "2026-11-10T10:05:00Z" },
					{ userId: SARA, note: "Either works.", updatedAt: "2026-11-10T10:06:00Z" },
				],
			],
			[CARD_B, undefined, []],
		]);
		expect(() =>
			parseOpenDecisions({
				schema: "qorpera.company-open-decisions/v1",
				decisions: [
					{
						...listedRow,
						kind: "question",
						id: CARD_A,
						answererUserId: SARA,
						sequence: 7,
						body: body(directions),
					},
				],
			}),
		).toThrow();
	});

	it("reads the round of a question asked again, and shows it on the card in the dock", async () => {
		const again: InteractionRequest = { ...directions, payload: { ...directions.payload, asksAgain: CARD_A } };
		const row = {
			sessionId: SESSION,
			staffAgentId: AGENT,
			createdAt: "2026-11-10T10:00:00Z",
			kind: "question",
			answererUserId: MEMBER,
			canAnswer: true,
			sequence: 9,
			votes: [],
		};
		const round = {
			number: 2,
			previous: { interactionId: CARD_A, answeredBy: MEMBER, values: ["Warmer, with more motion"] },
		};
		const parsed = parseOpenDecisions({
			schema: "qorpera.company-open-decisions/v1",
			decisions: [
				{ ...row, id: CARD_B, body: body(again), round },
				{ ...row, id: CARD_A, body: body(directions), round },
				{ ...row, id: SESSION, body: body(again), round: { number: 1 } },
				{ ...row, id: AGENT, body: body(again), round: { number: 3, previous: { values: ["a", "b"] } } },
			],
		});
		expect(parsed.map((decision) => (decision.kind === "question" ? decision.round : null))).toEqual([
			{ number: 2, note: "Warmer, with more motion", by: MEMBER },
			undefined,
			undefined,
			{ number: 3 },
		]);
		const { host } = company({ company: [parsed[0]!] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.querySelector(".decision-card .interaction-round")?.textContent).toBe(
			"Round 2You said: “Warmer, with more motion”",
		);
	});

	it("shows another member's question after the member's own, and counts and offers elsewhere only their own", async () => {
		const { host, open, controller } = company({
			company: [others(CARD_A, directions), ...asOpenCards([question(CARD_B, name)])],
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(controller.listCompanyOpenDecisions).toHaveBeenCalledTimes(1);
		expect(controller.listOpenDecisions).not.toHaveBeenCalled();
		expect(tabs(dock).map((tab) => [tab.dataset.decision, tab.classList.contains("is-others")])).toEqual([
			[CARD_B, false],
			[CARD_A, true],
		]);
		expect(open.store.get().questions.map((listed) => listed.interactionId)).toEqual([CARD_B]);
		expect(controller.setOpenDecisions).toHaveBeenLastCalledWith(1);
		expect(dock.shows(CARD_A)).toBe(true);
		dock.dispose();
	});

	it("takes a tap on another member's question as a vote: never an answer, taken back by a second tap", async () => {
		const { host, votesCast, answers } = company({
			company: [
				others(CARD_B, name, [
					{
						userId: SARA,
						choice: "Not yet",
						note: "The domain is not ours yet.",
						updatedAt: "2026-11-10T10:05:00Z",
					},
				]),
			],
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const card = dock.el.querySelector<HTMLElement>(".decision-card > .interaction-card");
		expect(card?.classList.contains("is-voting")).toBe(true);
		expect(card?.querySelector(".interaction-call strong")?.textContent).toBe("Bob asks Jonas");
		expect(card?.querySelector(".interaction-field")).toBeNull();
		expect([...(card?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).not.toContain("Skip");
		expect(option(dock, "Not yet")?.querySelectorAll(".vote-faces .person-avatar")).toHaveLength(1);
		expect(option(dock, "Not yet")?.querySelector(".vote-faces .visually-hidden")?.textContent).toBe(
			"Voted for by Jonas",
		);
		expect(dock.el.querySelector(".vote-notes li")?.textContent).toBe("JJonasThe domain is not ours yet.");

		option(dock, "mywave")?.click();
		await settle();
		expect(votesCast).toEqual([[CARD_B, "mywave", undefined]]);
		expect(answers).toEqual([]);
		expect(dock.decided).toEqual([]);
		expect(dock.el.querySelector(".decision-card > .interaction-card")).toBe(card);
		expect(option(dock, "mywave")?.classList.contains("is-voted")).toBe(true);
		expect(option(dock, "mywave")?.getAttribute("aria-pressed")).toBe("true");
		expect(option(dock, "mywave")?.querySelectorAll(".vote-faces .person-avatar")).toHaveLength(1);
		expect(option(dock, "Not yet")?.getAttribute("aria-pressed")).toBe("false");

		const note = dock.el.querySelector<HTMLInputElement>(".decision-note");
		if (!note) throw new Error("note field expected");
		note.value = "  Short and ours.  ";
		note.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(votesCast.at(-1)).toEqual([CARD_B, "mywave", "Short and ours."]);
		expect([...dock.el.querySelectorAll(".vote-notes li span:last-child")].map((line) => line.textContent)).toEqual([
			"The domain is not ours yet.",
			"Short and ours.",
		]);

		option(dock, "mywave")?.click();
		await settle();
		expect(votesCast.at(-1)).toEqual([CARD_B, undefined, "Short and ours."]);
		expect(option(dock, "mywave")?.classList.contains("is-voted")).toBe(false);
		expect(option(dock, "mywave")?.querySelector(".vote-faces")).toBeNull();
		dock.dispose();
	});

	it("puts the voters' faces on the member's own question without redrawing it, so a half-typed answer stays", async () => {
		const list: OpenDecision[] = asOpenCards([question(CARD_B, name)]);
		const { host, open, answers } = company({ company: list });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const field = dock.el.querySelector<HTMLInputElement>(".decision-card .interaction-field");
		if (!field) throw new Error("field expected");
		field.value = "Stillewave, perh";
		expect(dock.el.querySelector(".decision-note")).toBeNull();
		list[0] = {
			...list[0]!,
			votes: [{ userId: SARA, choice: "mywave", note: "Keep it.", updatedAt: "2026-11-10T10:05:00Z" }],
		};
		await open.refresh();
		await settle();
		expect(dock.el.querySelector<HTMLInputElement>(".decision-card .interaction-field")).toBe(field);
		expect(field.value).toBe("Stillewave, perh");
		expect(option(dock, "mywave")?.querySelectorAll(".vote-faces .person-avatar")).toHaveLength(1);
		expect(option(dock, "mywave")?.hasAttribute("aria-pressed")).toBe(false);
		expect(dock.el.querySelector(".vote-notes li span:last-child")?.textContent).toBe("Keep it.");
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["held"]);
		expect(answers).toEqual([]);
		dock.dispose();
	});

	it("lets a spectator see the options and the votes, with nothing to press", async () => {
		const { host, votesCast } = company({
			spectator: true,
			company: [others(CARD_A, directions, [{ userId: SARA, choice: "bold", updatedAt: "2026-11-10T10:05:00Z" }])],
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(option(dock, "bold")?.disabled).toBe(true);
		expect(option(dock, "calm")?.disabled).toBe(true);
		expect(option(dock, "bold")?.querySelectorAll(".vote-faces .person-avatar")).toHaveLength(1);
		expect(dock.el.querySelector(".decision-note")).toBeNull();
		option(dock, "bold")?.click();
		await settle();
		expect(votesCast).toEqual([]);
		dock.dispose();
	});

	it("says why when a vote is refused, and shows the votes as they were", async () => {
		const { host, votesCast } = company({ company: [others(CARD_B, name)], refuse: "This decision is not open" });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		option(dock, "mywave")?.click();
		await settle();
		expect(votesCast).toEqual([[CARD_B, "mywave", undefined]]);
		expect(dock.el.querySelector(".decision-error")?.textContent).toBe("This decision is not open");
		expect(option(dock, "mywave")?.classList.contains("is-voted")).toBe(false);
		dock.dispose();
	});

	it("shows another member's approval with nothing to answer and a note to add, and leaves out their email draft", async () => {
		const { host, votesCast, reviews } = company({
			company: [
				{ ...approval, othersAnswer: true, votes: [] },
				{ ...draft, othersAnswer: true, votes: [] },
			],
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(tabs(dock).map((tab) => tab.dataset.decision)).toEqual([REVIEW]);
		expect(
			[...dock.el.querySelectorAll<HTMLButtonElement>(".decision-card button")].map((button) => button.textContent),
		).not.toContain("Allow once");
		const note = dock.el.querySelector<HTMLInputElement>(".decision-note");
		if (!note) throw new Error("note field expected");
		note.value = "Check the amount first.";
		note.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(votesCast).toEqual([[REVIEW, undefined, "Check the amount first."]]);
		expect(reviews).toEqual([]);
		dock.dispose();
	});

	it("takes no tap for a moment when another member's card leaves and the member's own slides in", async () => {
		const list: OpenDecision[] = [...asOpenCards([question(CARD_B, name)]), others(CARD_A, name)];
		const { host, open, answers, votesCast } = company({ company: list });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		tabs(dock)
			.find((tab) => tab.dataset.decision === CARD_A)
			?.click();
		expect(dock.el.querySelector(".decision-card > .interaction-card.is-voting")).not.toBeNull();
		list.splice(1, 1);
		await open.refresh();
		await settle();
		expect(dock.el.querySelector(".decision-card > .interaction-card.is-voting")).toBeNull();
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided).toEqual([]);
		expect(votesCast).toEqual([]);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["held"]);
		expect(answers).toEqual([]);
		dock.dispose();
	});

	it("takes no tap for a moment when the card on screen turns from a vote into the member's own to answer", async () => {
		const list: OpenDecision[] = [others(CARD_B, name)];
		const { host, open, votesCast } = company({ company: list });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.querySelector(".decision-card > .interaction-card.is-voting")).not.toBeNull();
		list[0] = asOpenCards([question(CARD_B, name)])[0]!;
		await open.refresh();
		await settle();
		expect(dock.el.querySelector(".decision-card > .interaction-card.is-voting")).toBeNull();
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided).toEqual([]);
		expect(votesCast).toEqual([]);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["held"]);
		dock.dispose();
	});

	it("takes a second quick tap for no answer to the next card, and takes taps at once after Undo", async () => {
		const { host } = company({ questions: [question(CARD_B, name), question(CARD_A, name, "2026-11-10T11:00:00Z")] });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		option(dock, "mywave")?.click();
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.decision.interactionId)).toEqual([CARD_B]);
		dock.undo(CARD_B);
		option(dock, "Not yet")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.decision.interactionId)).toEqual([CARD_B]);
		dock.dispose();
	});

	it("says nothing of a vote that failed once a later vote was sent", async () => {
		const list: OpenDecision[] = [others(CARD_B, name)];
		const { host, controller } = company({ company: list });
		controller.castDecisionVote.mockImplementationOnce(async () => {
			throw new Error("The connection dropped");
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		const note = dock.el.querySelector<HTMLInputElement>(".decision-note");
		option(dock, "mywave")?.click();
		option(dock, "Not yet")?.click();
		await settle();
		await settle();
		expect(dock.el.querySelector(".decision-error")).toBeNull();
		expect(dock.el.querySelector<HTMLInputElement>(".decision-note")).toBe(note);
		expect(option(dock, "Not yet")?.classList.contains("is-voted")).toBe(true);
		dock.dispose();
	});

	it("takes no tap for a moment on the card that follows a sent email draft", async () => {
		const { host } = company({
			questions: [question(CARD_B, name)],
			drafts: [draft],
			draft: async (action) => (action === "send" ? { ...readyDraft, status: "sent" } : readyDraft),
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		press(dock, "Send email");
		await rest();
		expect(dock.decided.map((entry) => entry.decision.interactionId)).toEqual([DRAFT]);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.decision.interactionId)).toEqual([DRAFT]);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.decision.interactionId)).toEqual([DRAFT, CARD_B]);
		dock.dispose();
	});

	it("takes no tap for a moment on a card that arrives in a dock that stood empty, but takes the first cards at once", async () => {
		const list: OpenDecision[] = [];
		const { host, open } = company({ company: list });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.hidden).toBe(true);
		list.push(...asOpenCards([question(CARD_B, name)]));
		await open.refresh();
		await settle();
		expect(dock.el.hidden).toBe(false);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided).toEqual([]);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["held"]);
		dock.dispose();

		const first = company({ company: asOpenCards([question(CARD_B, name)]) });
		const fresh = new DecisionDock(first.host);
		document.body.append(fresh.el);
		await settle();
		option(fresh, "mywave")?.click();
		await settle();
		expect(fresh.decided.map((entry) => entry.state)).toEqual(["held"]);
		fresh.dispose();
	});

	it("keeps a note being typed when the card is drawn again for a refused vote and its retry", async () => {
		const list: OpenDecision[] = [others(CARD_B, name)];
		const { host, controller } = company({ company: list });
		controller.castDecisionVote.mockImplementationOnce(async () => {
			throw new Error("The connection dropped");
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		option(dock, "mywave")?.click();
		await settle();
		await settle();
		expect(dock.el.querySelector(".decision-error")?.textContent).toBe("The connection dropped");
		const note = dock.el.querySelector<HTMLInputElement>(".decision-note");
		if (!note) throw new Error("note field expected");
		note.focus();
		note.value = "Because the domain is ours";
		option(dock, "mywave")?.click();
		await settle();
		await settle();
		expect(dock.el.querySelector(".decision-error")).toBeNull();
		const again = dock.el.querySelector<HTMLInputElement>(".decision-note");
		expect(again?.value).toBe("Because the domain is ours");
		expect(document.activeElement).toBe(again);
		expect(option(dock, "mywave")?.classList.contains("is-voted")).toBe(true);
		dock.dispose();
	});

	it("goes on to the next of the other members' decisions when the one on screen leaves", async () => {
		const list: OpenDecision[] = [
			...asOpenCards([question(CARD_B, name)]),
			others(CARD_A, name),
			others(CARD_C, directions),
		];
		const { host, open } = company({ company: list });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		tabs(dock)
			.find((tab) => tab.dataset.decision === CARD_A)
			?.click();
		list.splice(1, 1);
		await open.refresh();
		await settle();
		expect(chosen(dock)).toBe(CARD_C);
		dock.dispose();
	});

	it("keeps a vote in sight through a read that began before it, and sends quick taps in their order", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const list: OpenDecision[] = [others(CARD_B, name)];
		const { host, open, votesCast, controller } = company({ company: list, gate });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		let stale: (value: OpenDecision[]) => void = () => {};
		controller.listCompanyOpenDecisions.mockImplementationOnce(
			() =>
				new Promise<OpenDecision[]>((resolve) => {
					stale = resolve;
				}),
		);
		const reading = open.refresh();
		option(dock, "mywave")?.click();
		option(dock, "Not yet")?.click();
		await settle();
		expect(votesCast).toEqual([[CARD_B, "mywave", undefined]]);
		expect(option(dock, "Not yet")?.classList.contains("is-voted")).toBe(true);
		stale([others(CARD_B, name)]);
		await reading;
		await settle();
		expect(option(dock, "Not yet")?.classList.contains("is-voted")).toBe(true);
		expect(option(dock, "mywave")?.classList.contains("is-voted")).toBe(false);
		release();
		await settle();
		await settle();
		expect(votesCast).toEqual([
			[CARD_B, "mywave", undefined],
			[CARD_B, "Not yet", undefined],
		]);
		expect(option(dock, "Not yet")?.classList.contains("is-voted")).toBe(true);
		expect(list[0]?.votes?.map((vote) => vote.choice)).toEqual(["Not yet"]);
		dock.dispose();
	});

	it("reads a note of any letters, and drops a vote it cannot read without losing the list", () => {
		const listedRow = { sessionId: SESSION, staffAgentId: AGENT, createdAt: "2026-11-10T10:00:00Z" };
		const long = "\u{1F30A}".repeat(400);
		const parsed = parseOpenDecisions({
			schema: "qorpera.company-open-decisions/v1",
			decisions: [
				{
					...listedRow,
					kind: "question",
					id: CARD_A,
					answererUserId: SARA,
					canAnswer: false,
					sequence: 7,
					body: body(directions),
					votes: [
						{ userId: SARA, choice: null, note: long, updatedAt: "2026-11-10T10:06:00Z" },
						{ userId: "not-an-id", choice: "calm", note: null, updatedAt: "2026-11-10T10:06:00Z" },
						{ userId: MEMBER, choice: "calm", note: null, updatedAt: "never" },
						"nothing",
					],
				},
			],
		});
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.votes).toEqual([{ userId: SARA, note: long, updatedAt: "2026-11-10T10:06:00Z" }]);
	});

	const login = {
		computeIdentity: {
			status: "active",
			ownerUserId: MEMBER,
			computeIdentityId: "77777777-7777-4777-8777-00000000000a",
		},
		connections: [
			{
				connectionId: "conn-2",
				provider: "openai",
				nativeHarness: "codex-cli",
				connectionStatus: "active",
				authorizationState: "active",
				policy: { implementationStatus: "supported", enablementStatus: "enabled" },
				sponsorBindingId: "77777777-7777-4777-8777-00000000000b",
				sponsorVersion: 1,
			},
		],
	};
	const withLogin = { listConnections: vi.fn(async () => login), selectSessionAccount: undefined };
	const sendPick = (dock: DecisionDock) => dock.el.querySelector<HTMLButtonElement>(".decision-pick-send");

	it("offers to send another member's pick only once they voted, with the words about the login first", async () => {
		const list: OpenDecision[] = [
			others(CARD_B, name, [{ userId: MEMBER, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }]),
		];
		const { host, open, answers } = company({ company: list, accounts: withLogin });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		expect(sendPick(dock)).toBeNull();
		list[0] = others(CARD_B, name, [{ userId: SARA, choice: "Not yet", updatedAt: "2026-11-10T10:06:00Z" }]);
		await open.refresh();
		await rest();
		expect(sendPick(dock)?.textContent).toBe("Send Jonas's pick: Not yet");
		expect(dock.el.querySelector(".decision-pick-words")?.textContent).toBe(
			"The work then runs on your login. The agent's next questions about this will come to you, and your approval rules apply.",
		);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		sendPick(dock)?.click();
		await settle();
		expect(answers).toEqual([]);
		const block = dock.renderDecided(dock.decided[0]!);
		expect(block.querySelector(".decided-rule")?.textContent).toBe("Jonas's pick");
		expect(block.querySelector(".decided-answer")?.textContent).toBe("Not yet");
		expect(block.querySelector(".decided-undo")).not.toBeNull();
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await settle();
		expect(answers).toEqual([[SESSION, CARD_B, "answered", { values: ["Not yet"] }]]);
		dock.dispose();
	});

	it("takes no tap on the send button for a moment when the asked member changes their vote under it", async () => {
		const list: OpenDecision[] = [
			others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }]),
		];
		const { host, open } = company({ company: list, accounts: withLogin });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		expect(sendPick(dock)?.textContent).toBe("Send Jonas's pick: mywave");
		list[0] = others(CARD_B, name, [{ userId: SARA, choice: "Not yet", updatedAt: "2026-11-10T10:07:00Z" }]);
		await open.refresh();
		await rest();
		expect(sendPick(dock)?.textContent).toBe("Send Jonas's pick: Not yet");
		sendPick(dock)?.click();
		await settle();
		expect(dock.decided).toEqual([]);
		list[0] = others(CARD_B, name, [{ userId: SARA, note: "Not sure yet.", updatedAt: "2026-11-10T10:08:00Z" }]);
		await open.refresh();
		await rest();
		expect(sendPick(dock)).toBeNull();
		dock.dispose();
	});

	it("takes a tap on the member's own question as their pick when they have no login, and says another member can send it", async () => {
		const list: OpenDecision[] = [{ ...asOpenCards([question(CARD_B, name)])[0]!, votes: [] }];
		const { host, votesCast, answers } = company({
			company: list,
			accounts: {
				listConnections: vi.fn(async () => ({ ...login, connections: [] })),
				selectSessionAccount: undefined,
			},
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		const card = dock.el.querySelector<HTMLElement>(".decision-card > .interaction-card");
		expect(card?.classList.contains("is-voting")).toBe(true);
		expect(card?.querySelector(".interaction-call strong")?.textContent).toBe("Bob asks you");
		expect(card?.querySelector(".interaction-field")).toBeNull();
		expect(dock.el.querySelector(".decision-pick-words")?.textContent).toBe(
			"You have no login here that can answer, so a tap is your pick, not an answer. A member who has one can then send your pick; tap it again to take it back.",
		);
		expect(sendPick(dock)).toBeNull();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(dock, "mywave")?.click();
		await rest();
		expect(votesCast).toEqual([[CARD_B, "mywave", undefined]]);
		expect(answers).toEqual([]);
		expect(dock.decided).toEqual([]);
		expect(option(dock, "mywave")?.classList.contains("is-voted")).toBe(true);
		option(dock, "mywave")?.click();
		await rest();
		expect(votesCast.at(-1)).toEqual([CARD_B, undefined, undefined]);
		dock.dispose();

		const signedIn = company({
			company: [{ ...asOpenCards([question(CARD_B, name)])[0]!, votes: [] }],
			accounts: withLogin,
		});
		const second = new DecisionDock(signedIn.host);
		document.body.append(second.el);
		await rest();
		expect(second.el.querySelector(".decision-card > .interaction-card.is-voting")).toBeNull();
		expect(second.el.querySelector(".decision-pick-words")).toBeNull();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(second, "mywave")?.click();
		await settle();
		expect(second.decided.map((entry) => entry.state)).toEqual(["held"]);
		expect(signedIn.votesCast).toEqual([]);
		second.dispose();
	});

	it("draws the member's own question as an answer card while the login is not known, and turns it back when a login appears", async () => {
		let connections: unknown[] = [];
		let held: ((value: typeof login) => void) | undefined;
		const listConnections = vi.fn(
			() =>
				new Promise<typeof login>((resolve) => {
					held = resolve;
				}),
		);
		const { host, open, votesCast } = company({
			company: [{ ...asOpenCards([question(CARD_B, name)])[0]!, votes: [] }],
			accounts: { listConnections, selectSessionAccount: undefined },
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		const voting = () => dock.el.querySelector(".decision-card > .interaction-card.is-voting") !== null;
		expect(voting()).toBe(false);
		held?.({ ...login, connections: connections as never });
		await rest();
		expect(voting()).toBe(true);
		option(dock, "mywave")?.click();
		await rest();
		expect(votesCast).toEqual([]);
		expect(dock.decided).toEqual([]);

		connections = login.connections;
		await vi.advanceTimersByTimeAsync(10_001);
		await open.refresh();
		await rest();
		expect(listConnections).toHaveBeenCalledTimes(2);
		held?.({ ...login, connections: connections as never });
		await rest();
		expect(voting()).toBe(false);
		expect(dock.el.querySelector(".decision-pick-words")).toBeNull();
		option(dock, "mywave")?.click();
		await rest();
		expect(dock.decided).toEqual([]);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		option(dock, "mywave")?.click();
		await settle();
		expect(dock.decided.map((entry) => entry.state)).toEqual(["held"]);
		expect(votesCast).toEqual([]);
		dock.dispose();

		const failing = company({
			company: [{ ...asOpenCards([question(CARD_B, name)])[0]!, votes: [] }],
			accounts: {
				listConnections: vi.fn(async () => {
					throw new Error("offline");
				}),
				selectSessionAccount: undefined,
			},
		});
		const second = new DecisionDock(failing.host);
		document.body.append(second.el);
		await rest();
		expect(second.el.querySelector(".decision-card > .interaction-card.is-voting")).toBeNull();
		second.dispose();
	});

	it("says a sent pick is not the member's pick now when the cloud refuses it, and reads the votes again", async () => {
		const list: OpenDecision[] = [
			others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }]),
		];
		const { host, controller } = company({ company: list, accounts: withLogin });
		controller.answerInteraction.mockImplementationOnce(async () => {
			throw new Error("Only the member this card was raised for can answer it");
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		sendPick(dock)?.click();
		await settle();
		list[0] = others(CARD_B, name, [{ userId: SARA, choice: "Not yet", updatedAt: "2026-11-10T10:09:00Z" }]);
		const reads = controller.listCompanyOpenDecisions.mock.calls.length;
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await rest();
		expect(dock.decided).toEqual([]);
		expect(dock.el.querySelector(".decision-error")?.textContent).toBe(
			"Nothing was sent. Jonas's pick is not that option now. Look at their vote again.",
		);
		expect(controller.listCompanyOpenDecisions.mock.calls.length).toBeGreaterThan(reads);
		expect(sendPick(dock)?.textContent).toBe("Send Jonas's pick: Not yet");
		dock.dispose();
	});

	it("keeps a pick the member left on their own question in sight, with a way to take it back, once they can answer", async () => {
		const list: OpenDecision[] = [
			{
				...asOpenCards([question(CARD_B, name)])[0]!,
				votes: [{ userId: MEMBER, choice: "mywave", note: "For now.", updatedAt: "2026-11-10T10:05:00Z" }],
			},
		];
		const { host, votesCast, answers } = company({ company: list, accounts: withLogin });
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		expect(dock.el.querySelector(".decision-card > .interaction-card.is-voting")).toBeNull();
		expect(dock.el.querySelector(".decision-pick-words")?.textContent).toBe(
			"Your pick stands: a member with a login can send it. Answer here yourself, or take it back.",
		);
		const back = dock.el.querySelector<HTMLButtonElement>(".decision-pick-back");
		expect(back?.textContent).toBe("Take my pick back");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		back?.click();
		await rest();
		expect(votesCast).toEqual([[CARD_B, undefined, "For now."]]);
		expect(answers).toEqual([]);
		expect(dock.el.querySelector(".decision-pick-back")).toBeNull();
		dock.dispose();
	});

	it("does not say the pick changed when the cloud refuses a send for another reason", async () => {
		const list: OpenDecision[] = [
			others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }]),
		];
		const { host, controller } = company({ company: list, accounts: withLogin });
		controller.answerInteraction.mockImplementationOnce(async () => {
			throw new Error("Only the member this card was raised for can answer it");
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		sendPick(dock)?.click();
		await settle();
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await rest();
		expect(dock.el.querySelector(".decision-error")?.textContent).toBe(
			"Only the member this card was raised for can answer it",
		);
		expect(sendPick(dock)?.textContent).toBe("Send Jonas's pick: mywave");
		dock.dispose();
	});

	it("judges a refused pick by votes read after the refusal, never by a read that was already on its way", async () => {
		const list: OpenDecision[] = [
			others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }]),
		];
		const { host, open, controller } = company({ company: list, accounts: withLogin });
		controller.answerInteraction.mockImplementationOnce(async () => {
			throw new Error("Only the member this card was raised for can answer it");
		});
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await rest();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		sendPick(dock)?.click();
		await settle();
		let early: (value: OpenDecision[]) => void = () => {};
		controller.listCompanyOpenDecisions.mockImplementationOnce(
			() =>
				new Promise<OpenDecision[]>((resolve) => {
					early = resolve;
				}),
		);
		void open.refresh();
		const before = [others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }])];
		list[0] = others(CARD_B, name, [{ userId: SARA, choice: "Not yet", updatedAt: "2026-11-10T10:09:00Z" }]);
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await rest();
		expect(dock.el.querySelector(".decision-error")).toBeNull();
		early(before);
		await rest();
		await rest();
		expect(dock.el.querySelector(".decision-error")?.textContent).toBe(
			"Nothing was sent. Jonas's pick is not that option now. Look at their vote again.",
		);
		expect(sendPick(dock)?.textContent).toBe("Send Jonas's pick: Not yet");
		dock.dispose();

		const offline = company({
			company: [others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }])],
			accounts: withLogin,
		});
		offline.controller.answerInteraction.mockImplementationOnce(async () => {
			throw new Error("Only the member this card was raised for can answer it");
		});
		const second = new DecisionDock(offline.host);
		document.body.append(second.el);
		await rest();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		sendPick(second)?.click();
		await settle();
		offline.controller.listCompanyOpenDecisions.mockImplementation(async () => {
			throw new Error("offline");
		});
		await vi.advanceTimersByTimeAsync(UNDO_MS + 1);
		await rest();
		expect(second.el.querySelector(".decision-error")?.textContent).toBe(
			"Nothing was sent. Jonas's pick is not that option now. Look at their vote again.",
		);
		second.dispose();
	});

	it("offers no send to a member without a usable login, nor to a spectator", async () => {
		const voted = () => [
			others(CARD_B, name, [{ userId: SARA, choice: "mywave", updatedAt: "2026-11-10T10:05:00Z" }]),
		];
		const none = company({
			company: voted(),
			accounts: {
				listConnections: vi.fn(async () => ({ ...login, connections: [] })),
				selectSessionAccount: undefined,
			},
		});
		const dock = new DecisionDock(none.host);
		document.body.append(dock.el);
		await rest();
		expect(option(dock, "mywave")).not.toBeNull();
		expect(sendPick(dock)).toBeNull();
		dock.dispose();

		const disabled = company({
			company: voted(),
			accounts: {
				listConnections: vi.fn(async () => ({
					...login,
					connections: [{ ...login.connections[0], connectionStatus: "disabled" }],
				})),
				selectSessionAccount: undefined,
			},
		});
		const second = new DecisionDock(disabled.host);
		document.body.append(second.el);
		await rest();
		expect(sendPick(second)).toBeNull();
		second.dispose();

		const spectator = company({ company: voted(), accounts: withLogin, spectator: true });
		const third = new DecisionDock(spectator.host);
		document.body.append(third.el);
		await rest();
		expect(sendPick(third)).toBeNull();
		third.dispose();
	});

	it("is not there with nothing to decide", async () => {
		const { host } = company();
		const dock = new DecisionDock(host);
		document.body.append(dock.el);
		await settle();
		expect(dock.el.hidden).toBe(true);
		expect(dock.waiting).toBe("");
		dock.dispose();
	});
});
