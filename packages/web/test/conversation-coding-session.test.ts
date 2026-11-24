// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CodingSession } from "../src/cloud/coding-session.ts";
import type { TranscriptMessage } from "../src/cloud/transcript.ts";
import {
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
	userB,
} from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse("2026-09-22T10:10:00Z") });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
	stubFigureMotion();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function message(
	sequence: number,
	text: string,
	createdAt: string,
	kind: "member" | "agent" = "agent",
): TranscriptMessage {
	return {
		kind,
		id: id(800 + sequence),
		sequence,
		text,
		attachmentCount: 0,
		phase: kind === "agent" ? "final" : undefined,
		createdAt,
		authorUserId: userA.id,
	};
}

function codingSession(overrides: Partial<CodingSession> = {}): CodingSession {
	return {
		workerId: id(900),
		workerKey: "fix-send",
		title: "Fix the delay after send",
		agentId: staff.id,
		ownerUserId: userA.id,
		harness: "codex",
		repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
		branch: `qorpera/coding/${id(900)}`,
		sequence: 1,
		workerState: "active",
		phase: "running",
		filesChanged: 0,
		checks: [],
		artifacts: [],
		startedAt: "2026-09-22T10:01:00Z",
		updatedAt: "2026-09-22T10:02:00Z",
		createdAt: "2026-09-22T10:01:00Z",
		sessionId: session.sessionId,
		isOwner: true,
		standby: true,
		attached: false,
		runningCommands: 0,
		machineAsleep: false,
		...overrides,
	};
}

function mount(prepare: (store: ReturnType<CompanyController["conversation"]>) => void = () => {}) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team: {
			...team,
			members: [
				{
					userId: userB.id,
					displayName: "Sofie Lund",
					role: "contributor",
					email: "s@example.invalid",
					joinedAt: timestamp,
				},
			],
		},
		staff: [staff],
		sessions: [{ ...session, staffAgentId: staff.id }],
		loading: false,
	});
	const store = company.conversation(session.sessionId, false);
	store.set({ loading: false, complete: true });
	prepare(store);
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, view, store };
}

const rows = (messages: HTMLElement) => [...messages.children].filter((node) => node.tagName !== "TIME");

describe("coding sessions stay silent in conversation views", () => {
	it("never renders coding lines, coding pills, or coding threads for active, waiting, or completed sessions", async () => {
		const f = mount((store) => {
			store.set({
				projection: {
					items: [
						message(1, "Can you fix it?", "2026-09-22T10:00:00Z", "member"),
						message(2, "On it.", "2026-09-22T10:00:30Z"),
						message(3, "Here is the summary.", "2026-09-22T10:05:00Z"),
					],
					hiddenCount: 0,
					lastSequence: 3,
				},
				codingSessions: [
					codingSession({ phase: "running", workerState: "active" }),
					codingSession({ workerId: id(901), phase: "awaiting_input", workerState: "blocked" }),
					codingSession({ workerId: id(902), phase: "completed", workerState: "succeeded" }),
				],
			});
		});
		await settle();
		const messages = f.view.el.querySelector<HTMLElement>('[role="log"]')!;
		expect(rows(messages).every((node) => node.classList.contains("message"))).toBe(true);
		expect(f.view.el.querySelector(".coding-line")).toBeNull();
		expect(f.view.el.querySelector(".coding-dock")).toBeNull();
		expect(f.view.el.querySelector(".coding-pill")).toBeNull();
		expect(f.view.el.querySelector(".coding-thread")).toBeNull();
	});

	it("does not poll listCodingSessions from the conversation view even when sessions are active or waiting", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [message(1, "On it.", "2026-09-22T10:00:30Z")], hiddenCount: 0, lastSequence: 1 },
				codingSessions: [
					codingSession({ phase: "running", workerState: "active" }),
					codingSession({ workerId: id(901), phase: "awaiting_input", workerState: "blocked" }),
				],
			});
		});
		await settle();
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(60_000);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.api.listCodingSessions).not.toHaveBeenCalled();
	});

	it("shows the empty message when only coding sessions exist without transcript items", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [], hiddenCount: 0, lastSequence: 0 },
				codingSessions: [codingSession({ phase: "awaiting_input", workerState: "blocked" })],
			});
		});
		await settle();
		expect(f.view.el.querySelector(".coding-line")).toBeNull();
		expect(f.view.el.querySelector(".coding-dock")).toBeNull();
		expect(f.view.el.querySelector(".messages")?.textContent).toContain("No messages yet.");
	});

	it("an older read never undoes a newer state the controller already has", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [], hiddenCount: 0, lastSequence: 0 },
				codingSessions: [codingSession({ phase: "input_ready", sequence: 2, updatedAt: "2026-09-22T10:04:00Z" })],
			});
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([
			codingSession({ phase: "awaiting_input", workerState: "blocked", updatedAt: "2026-09-22T10:03:00Z" }),
		]);
		await f.company.refreshCodingSessions(session.sessionId);
		expect(f.store.get().codingSessions?.[0]).toMatchObject({ phase: "input_ready", sequence: 2 });
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([
			codingSession({ phase: "running", sequence: 2, updatedAt: "2026-09-22T10:05:00Z" }),
		]);
		await f.company.refreshCodingSessions(session.sessionId);
		expect(f.store.get().codingSessions?.[0]).toMatchObject({ phase: "running" });
	});

	it("a cloud without coding sessions renders the thread as before", async () => {
		const f = mount();
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([]);
		vi.mocked(f.api.listCodingSessions).mockRejectedValue(
			new CloudRpcError(
				"qorpera_list_coding_sessions",
				{ message: "Could not find the function", code: "PGRST202" },
				404,
			),
		);
		await f.company.loadConversation(session.sessionId);
		await settle();
		const state = f.company.conversation(session.sessionId).get();
		expect(state.error).toBeUndefined();
		expect(state.codingSessions).toEqual([]);
		expect(f.view.el.querySelector(".coding-line")).toBeNull();
		expect(f.view.el.querySelector(".coding-dock")).toBeNull();
		expect(f.view.el.querySelector(".messages")?.textContent).toContain("No messages yet.");
	});
});

describe("the thread foot above the composer", () => {
	const conversation = readFileSync(resolve("src/styles/conversation.css"), "utf8");

	it("lays the thread's foot over the messages, with everything its bands hold taking the pointer", () => {
		expect(conversation).toMatch(
			/\.messages \{[^}]*padding: 16px clamp\(16px, 4\.5%, 56px\) calc\(40px \+ var\(--thread-foot, 0px\)\);/,
		);
		expect(conversation).toContain(".thread-foot > * { pointer-events: none; }");
		expect(conversation).toContain(".thread-foot > * > * { pointer-events: auto; }");
		expect(conversation).toContain(".thread-foot .composer { position: relative; z-index: 7; }");
		expect(conversation).toMatch(
			/\.thread-foot \.composer-shell::before \{[^}]*backdrop-filter: var\(--glass-blur\);/,
		);
		expect(conversation).not.toMatch(/\.thread-foot[^{]*\.composer-shell[,)][^{]*\{[^}]*backdrop-filter/);
		expect(conversation).not.toMatch(/\.thread-foot[^{]*\.composer-answer/);
	});
});
