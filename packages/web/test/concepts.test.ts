// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyController, ConversationState } from "../src/app/company.ts";
import { type CompanyApp, readApps } from "../src/app/interface-apps.ts";
import { OpenQuestions } from "../src/app/open-questions.ts";
import { Store } from "../src/app/state.ts";
import type { AppPanelHost } from "../src/app/views/app-panel.ts";
import { ConceptsView } from "../src/app/views/concepts.ts";
import type { QuestionDockHost } from "../src/app/views/question-dock.ts";
import type { InteractionRequest } from "../src/cloud/interactions.ts";
import { type OpenQuestion, parseOpenQuestions } from "../src/cloud/open-questions.ts";
import type { HostedStaffAgent, JsonValue } from "../src/cloud/types.ts";
import { COMPACT, DEFAULT, MIN, STORAGE_KEY } from "../src/ui/rail-layout.ts";
import { folderFake } from "./folder-fake.ts";

/* The Concepts viewer (views/concepts.ts): which questions its dock shows, and that its side panel is the company
 * rail's width. The concept's own frame is app-panel.test.ts'. */

const SESSION = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CARD_A = "44444444-4444-4444-8444-00000000000a";
const CARD_B = "44444444-4444-4444-8444-00000000000b";

const views: ConceptsView[] = [];

afterEach(() => {
	for (const view of views.splice(0)) view.dispose();
	localStorage.clear();
	document.body.replaceChildren();
});

/** A question that points at the apps its options preview. */
function question(id: string, previews: readonly string[]): OpenQuestion {
	const request: InteractionRequest = {
		surface: "question",
		title: "Viser scenerne den lampe, du forestiller dig?",
		payload: { options: previews.map((preview, index) => ({ label: `Option ${index}`, preview })) },
	};
	return parseOpenQuestions({
		schema: "qorpera.open-questions/v1",
		questions: [
			{
				sessionId: SESSION,
				interactionId: id,
				sequence: 7,
				actorUserId: MEMBER,
				staffAgentId: AGENT,
				body: {
					entry: {
						type: "custom",
						customType: "interaction_request",
						data: { schema: "qorpera.interaction/v1", ...request } as unknown as JsonValue,
					},
				},
				createdAt: "2026-11-13T14:45:00Z",
			},
		],
	})[0]!;
}

/** A company with two concepts, and the open questions it is asked. */
function company(questions: OpenQuestion[] = []) {
	const fake = folderFake({ seed: [] });
	fake.put("apps/koncepter/app.toml", 'name = "Lysvækker – koncepter"\nabout = "Seks scener"\nconcept = true\n');
	fake.put("apps/koncepter/index.html", "<!doctype html><title>Koncepter</title>");
	fake.put("apps/udtryk/app.toml", 'name = "Lysvækkers udtryk"\nconcept = true\n');
	fake.put("apps/udtryk/index.html", "<!doctype html><title>Udtryk</title>");
	const conversations = new Map<string, Store<ConversationState>>();
	const conversation = (sessionId: string) => {
		let store = conversations.get(sessionId);
		if (!store) {
			store = new Store<ConversationState>({ sessionId, optimistic: [] } as unknown as ConversationState);
			conversations.set(sessionId, store);
		}
		return store;
	};
	const controller = {
		signal: new AbortController().signal,
		listOpenQuestions: async () => questions,
		onInvalidate: () => () => {},
		conversation,
		setExecutionSponsor: () => {},
		answerInteraction: async () => {},
	};
	const agent = { id: AGENT, displayName: "Bob", appearance: {} } as unknown as HostedStaffAgent;
	const dock: QuestionDockHost = {
		questions: new OpenQuestions(
			controller as unknown as CompanyController,
			{
				listConnections: async () => ({ connections: [] }),
			} as never,
		),
		agent: (id) => (id === AGENT ? agent : undefined),
		memberName: () => "Jonas",
		conversation,
	};
	let read: readonly CompanyApp[] = [];
	const panel = {
		folder: () => fake.folder,
		agents: () => [],
		questions: dock,
		readApps: async (signal: AbortSignal) => {
			read = await readApps(fake.folder, signal);
			return read;
		},
		apps: () => read,
		agentName: () => null,
		onFolderChange: () => () => {},
		openInStorage: vi.fn<(path: string) => void>(),
		openApp: vi.fn<(name: string) => void>(),
		budgetKey: crypto.randomUUID(),
	} satisfies AppPanelHost;
	return {
		panel,
		open: (name: string | undefined) => {
			const view = new ConceptsView(
				{
					panel,
					profileId: "p",
					companyName: () => "Lysvækker",
					back: () => "#/c/p",
					picture: async () => null,
				},
				[],
				name,
			);
			views.push(view);
			document.body.append(view.el);
			return view;
		},
	};
}

const settle = async () => {
	for (let index = 0; index < 20; index++) await Promise.resolve();
};

/** The dock, once the apps are read and the questions are in. */
const shown = (view: ConceptsView) =>
	vi.waitFor(() => {
		const dock = view.el.querySelector<HTMLElement>(".question-dock");
		if (!dock || dock.hidden) throw new Error("the dock is not here yet");
		return dock;
	});

describe("the Concepts viewer's dock", () => {
	it("shows a question only on the concept it asks about", async () => {
		const { open } = company([question(CARD_A, ["app:koncepter"])]);
		const view = open("koncepter");
		const dock = await shown(view);
		expect(dock.textContent).toContain("Bob asks you");
		// The other concept's page is not where this question was asked (Jonas, 13 November 2026).
		const other = company([question(CARD_A, ["app:koncepter"])]).open("udtryk");
		await settle();
		expect(other.el.querySelector<HTMLElement>(".question-dock")?.hidden).toBe(true);
	});

	it("follows the concept the member opens", async () => {
		const { open, panel } = company([question(CARD_B, ["app:udtryk"])]);
		const view = open("koncepter");
		await settle();
		expect(view.el.querySelector<HTMLElement>(".question-dock")?.hidden).toBe(true);
		view.update(await panel.readApps(new AbortController().signal), "udtryk");
		await shown(view);
	});

	it("shows nothing for a question that points at no concept, or at one that is gone", async () => {
		const { open } = company([question(CARD_A, ["app:gone", "apps/mailbox/a.png"])]);
		const view = open("koncepter");
		await settle();
		expect(view.el.querySelector<HTMLElement>(".question-dock")?.hidden).toBe(true);
	});
});

describe("the Concepts viewer's side panel", () => {
	it("is the company rail's width, the member's own choice there", async () => {
		const { open } = company();
		const view = open("koncepter");
		await settle();
		expect(view.el.style.getPropertyValue("--concepts-width")).toBe(`${DEFAULT}px`);
		localStorage.setItem(STORAGE_KEY, "320");
		const resized = company().open("koncepter");
		await settle();
		expect(resized.el.style.getPropertyValue("--concepts-width")).toBe("320px");
	});

	it("is never a compact rail's strip, and folds on its own", async () => {
		// The member made the company rail compact: it keeps that strip's width, and no expanded width beside it.
		localStorage.setItem(STORAGE_KEY, String(COMPACT));
		const view = company().open("koncepter");
		await settle();
		expect(view.el.style.getPropertyValue("--concepts-width")).toBe(`${DEFAULT}px`);
		expect(DEFAULT).toBeGreaterThanOrEqual(MIN);
		expect(view.el.classList.contains("is-collapsed")).toBe(false);
		// Folding the panel and opening it again gives the same width back: the rail's preference is not the panel's fold.
		view.el.querySelector<HTMLButtonElement>(".concepts-collapse")?.click();
		expect(view.el.classList.contains("is-collapsed")).toBe(true);
		view.el.querySelector<HTMLButtonElement>(".concepts-collapse")?.click();
		expect(view.el.classList.contains("is-collapsed")).toBe(false);
		expect(view.el.style.getPropertyValue("--concepts-width")).toBe(`${DEFAULT}px`);
		expect(localStorage.getItem(STORAGE_KEY)).toBe(String(COMPACT));
	});
});
