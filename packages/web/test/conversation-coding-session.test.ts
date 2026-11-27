// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
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
import "./register-lazy.ts";

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

describe("silent coding sessions in conversations", () => {
	it("renders no coding pill, no inline coding line, and no thread overlay for running, waiting, or completed sessions", async () => {
		const f = mount((store) => {
			store.set({
				projection: {
					items: [
						message(1, "Can you inspect the site?", "2026-09-22T10:00:00Z", "member"),
						message(2, "On it.", "2026-09-22T10:00:30Z"),
					],
					hiddenCount: 0,
					lastSequence: 2,
				},
				codingSessions: [
					codingSession({ workerId: id(900), phase: "running" }),
					codingSession({
						workerId: id(901),
						phase: "awaiting_input",
						workerState: "blocked",
					}),
					codingSession({
						workerId: id(902),
						phase: "completed",
						workerState: "succeeded",
						createdAt: "2026-09-22T09:00:00Z",
					}),
				],
			});
		});
		await settle();
		expect(f.view.el.querySelector(".coding-dock, .coding-pill, .coding-line, .coding-thread")).toBeNull();
		expect(f.view.el.querySelectorAll("article.message")).toHaveLength(2);
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.api.listCodingSessions).not.toHaveBeenCalled();
	});

	it("still shows the empty state when a conversation has only hidden coding sessions", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [], hiddenCount: 0, lastSequence: 0 },
				codingSessions: [codingSession({ phase: "completed", workerState: "succeeded" })],
			});
		});
		await settle();
		expect(f.view.el.querySelector(".coding-line")).toBeNull();
		expect(f.view.el.querySelector(".empty")?.textContent).toBe("No messages yet.");
	});
});
