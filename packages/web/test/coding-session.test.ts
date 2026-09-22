// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodingSession,
	type CodingSessionEvent,
	type CodingSessionRead,
	codingSessionTakesInput,
	parseCodingSession,
	parseCodingSessionRead,
	parseCodingSessions,
} from "../src/cloud/coding-session.ts";
import {
	CodingSessionElement,
	type CodingSessionNames,
	codingSessionCaption,
	codingSessionStatus,
	fmtDuration,
	shortBranch,
} from "../src/ui/coding-session.ts";
import { id, staff, stubFigureMotion, timestamp, userA } from "./fixtures.ts";

const WORKER = id(900);
const CONVERSATION = id(7);

function codingSession(overrides: Partial<CodingSession> = {}): CodingSession {
	return {
		workerId: WORKER,
		workerKey: "fix-send",
		title: "Fix the delay after send",
		agentId: staff.id,
		ownerUserId: userA.id,
		harness: "claude-code",
		model: "claude-sonnet-5",
		repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
		branch: `qorpera/coding/${WORKER}`,
		sequence: 1,
		workerState: "active",
		phase: "running",
		lastStep: "running vitest in packages/web",
		filesChanged: 3,
		checks: [],
		artifacts: [],
		startedAt: "2026-09-22T10:00:00Z",
		updatedAt: "2026-09-22T10:03:00Z",
		createdAt: "2026-09-22T09:59:00Z",
		sessionId: CONVERSATION,
		isOwner: true,
		...overrides,
	};
}

function event(
	idNumber: number,
	kind: CodingSessionEvent["kind"],
	body: CodingSessionEvent["body"],
	actor: CodingSessionEvent["actor"] = "harness",
): CodingSessionEvent {
	return { id: idNumber, sequence: 1, kind, actor, body, at: timestamp };
}

const owner: CodingSessionNames = { agent: "Mark", owner: "you", ownerIsViewer: true };
const other: CodingSessionNames = { agent: "Mark", owner: "Jonas", ownerIsViewer: false };
const NOW = Date.parse("2026-09-22T10:04:00Z");

describe("the captions the kernel state produces", () => {
	it("names the agent, the owner and the harness, and says what the session needs", () => {
		expect(codingSessionCaption(codingSession(), owner)).toBe(
			"Mark started a coding session with you in Claude Code",
		);
		expect(codingSessionCaption(codingSession({ harness: "codex" }), other)).toBe(
			"Mark started a coding session with Jonas in Codex",
		);
		expect(codingSessionCaption(codingSession({ phase: "awaiting_input" }), owner)).toBe(
			"Mark's coding session with you in Claude Code needs your answer",
		);
		expect(codingSessionCaption(codingSession({ phase: "awaiting_input" }), other)).toBe(
			"Mark's coding session with Jonas in Claude Code needs an answer from Jonas",
		);
		expect(
			codingSessionCaption(
				codingSession({
					phase: "completed",
					pullRequest: { url: "https://github.com/Qorpera/Qorpera_Base/pull/204", number: 204 },
				}),
				owner,
			),
		).toBe("Mark's coding session with you in Claude Code opened a draft PR");
		expect(codingSessionCaption(codingSession({ phase: "completed" }), owner)).toMatch(/finished$/);
		expect(codingSessionCaption(codingSession({ phase: "failed" }), owner)).toMatch(/failed$/);
		expect(codingSessionCaption(codingSession({ phase: "cancelled" }), owner)).toMatch(/was cancelled$/);
	});

	it("writes the status from the phase, the clock, the last step and the diff size", () => {
		expect(codingSessionStatus(codingSession(), owner, NOW)).toEqual({
			text: "Working · 4 min · running vitest in packages/web · 3 files changed",
			tone: "working",
		});
		expect(codingSessionStatus(codingSession({ phase: "queued" }), owner, NOW).text).toBe("Waiting for a computer");
		expect(codingSessionStatus(codingSession({ phase: "awaiting_input" }), owner, NOW)).toEqual({
			text: "Needs you · your answer is recorded in this thread",
			tone: "attention",
		});
		expect(codingSessionStatus(codingSession({ phase: "awaiting_input" }), other, NOW).text).toBe(
			"Needs Jonas · paused 1 min",
		);
		expect(
			codingSessionStatus(
				codingSession({ phase: "completed", pullRequest: { url: "https://x.invalid/pull/1", number: 1 } }),
				owner,
				NOW,
			),
		).toEqual({ text: "Draft PR ready · session kept for follow-ups", tone: "done" });
		expect(codingSessionStatus(codingSession({ phase: "failed" }), owner, NOW)).toEqual({
			text: "Failed · workspace kept",
			tone: "failed",
		});
		expect(fmtDuration(30_000)).toBe("less than a minute");
		expect(fmtDuration(65 * 60_000)).toBe("1 h 5 min");
		expect(shortBranch(`qorpera/coding/${WORKER}`)).toBe("qorpera/coding/1111…");
	});

	it("knows when the owner may type: while the session asks, or once it settled", () => {
		expect(codingSessionTakesInput(codingSession())).toBe(false);
		expect(codingSessionTakesInput(codingSession({ phase: "awaiting_input" }))).toBe(true);
		expect(codingSessionTakesInput(codingSession({ phase: "completed" }))).toBe(true);
		expect(codingSessionTakesInput(codingSession({ phase: "cancelled", sequence: 64 }))).toBe(false);
	});
});

describe("the kernel's shapes", () => {
	const wire = {
		schema: "qorpera.coding-session/v1",
		workerId: WORKER,
		workerKey: "fix-send",
		title: "Fix the delay after send",
		agentId: staff.id,
		ownerUserId: userA.id,
		harness: "codex",
		model: null,
		repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
		branch: `qorpera/coding/${WORKER}`,
		baseSha: null,
		sequence: 2,
		workerState: "blocked",
		phase: "awaiting_input",
		lastStep: "Cloning the repository",
		filesChanged: 0,
		pullRequest: null,
		checks: [{ name: "web client", status: "passed" }, { bogus: true }],
		artifacts: [],
		needs: "Keep 250 ms, or raise to 500 ms?",
		summary: "Composer fixed.",
		startedAt: "2026-09-22T18:40:27.933676+00:00",
		finishedAt: null,
		updatedAt: "2026-09-22T18:41:07.23231+00:00",
		harnessSessionRef: "sess-1",
		sessionId: CONVERSATION,
		createdAt: "2026-09-22T18:40:18.641597+00:00",
	};

	it("parses the listing, the read and the view, dropping what it does not know", () => {
		const sessions = parseCodingSessions({
			schema: "qorpera.coding-sessions/v1",
			sessions: [{ ...wire, isOwner: true }],
		});
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			workerId: WORKER,
			harness: "codex",
			phase: "awaiting_input",
			needs: "Keep 250 ms, or raise to 500 ms?",
			checks: [{ name: "web client", status: "passed" }],
			isOwner: true,
		});
		expect(sessions[0]?.model).toBeUndefined();
		const read = parseCodingSessionRead({
			schema: "qorpera.coding-session-read/v1",
			session: wire,
			isOwner: false,
			events: [
				{
					id: 3,
					sequence: 1,
					kind: "needs_input",
					actor: "executor",
					body: { needs: "Keep?" },
					at: wire.updatedAt,
				},
			],
		});
		expect(read.isOwner).toBe(false);
		expect(read.events[0]).toMatchObject({ id: 3, kind: "needs_input", body: { needs: "Keep?" } });
		expect(() => parseCodingSession({ ...wire, phase: "sleeping" })).toThrow();
		expect(() => parseCodingSession({ ...wire, harness: "cursor" })).toThrow();
	});
});

describe("the element in the thread", () => {
	let disposeAll: AbortController;
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
		stubFigureMotion();
		disposeAll = new AbortController();
	});
	afterEach(() => {
		disposeAll.abort();
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function mount(
		session: CodingSession,
		options: {
			viewer?: "owner" | "other";
			events?: CodingSessionEvent[];
			askAgent?: (text: string) => void;
			open?: () => void;
		} = {},
	) {
		const events = options.events ?? [];
		const state = { session, events };
		const read = vi.fn(
			async (_workerId: string, afterEvent: number): Promise<CodingSessionRead> => ({
				session: state.session,
				isOwner: options.viewer !== "other",
				events: state.events.filter((event) => event.id > afterEvent),
			}),
		);
		const answer = vi.fn(async (_workerId: string, _text: string, _clientRequestId: string): Promise<void> => {});
		const delegate = vi.fn(async (_workerId: string, _clientRequestId: string): Promise<void> => {});
		const names = options.viewer === "other" ? other : owner;
		const element = new CodingSessionElement(session, {
			agent: staff,
			names: () => names,
			viewerOwns: () => options.viewer !== "other",
			api: { read, answer, delegate },
			signal: disposeAll.signal,
			askAgent: options.askAgent,
			open: options.open,
		});
		document.body.append(element.el);
		return { element, read, answer, delegate, state };
	}
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	const button = (root: ParentNode, label: string) => {
		const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
		if (!found) throw new Error(`Missing button: ${label}`);
		return found;
	};

	it("collapsed, it is the chip and the status, nothing more", async () => {
		const open = vi.fn();
		const { element, read } = mount(codingSession(), { open });
		await settle();
		expect(read).toHaveBeenCalledWith(WORKER, 0);
		const chip = element.el.querySelector<HTMLButtonElement>(".coding-chip")!;
		expect(chip.textContent).toBe("Mark started a coding session with you in Claude Code");
		// The agent's name and the harness carry weight; the harness wears its mark.
		expect(chip.querySelector(".coding-agent")?.textContent).toBe("Mark");
		expect(chip.querySelector(".coding-harness .coding-badge-claude-code")).not.toBeNull();
		expect(chip.querySelector(".figure")).not.toBeNull();
		const status = element.el.querySelector(".coding-status")!;
		expect(status.querySelector(".coding-status-title")?.textContent).toBe("Fix the delay after send");
		expect(status.textContent).toContain("Working · 4 min · running vitest");
		expect(element.el.querySelector(".coding-body")).toBeNull();
		expect(element.el.querySelector(".coding-rule")).toBeNull();
		// The chip opens the session as its own thread; Show unfolds it here.
		chip.click();
		expect(open).toHaveBeenCalledTimes(1);
		expect(element.el.querySelector(".coding-body")).toBeNull();
	});

	it("expanded, it shows the session's own steps and voice, the input and the status", async () => {
		const events = [
			event(1, "phase", { phase: "queued" }, "kernel"),
			event(2, "step", { text: "Cloning Qorpera_Base" }, "executor"),
			event(3, "text", { text: "The delay came from the composer.\n\nMoving the refresh after the post." }),
			event(4, "step", { text: "npx vitest run test/composer-send.test.ts", status: "passed" }),
		];
		const { element } = mount(codingSession(), { events });
		await settle();
		button(element.el, "Show").click();
		expect(element.el.querySelector(".coding-title")?.textContent).toBe("Fix the delay after send");
		expect(element.el.querySelector(".coding-meta")?.textContent).toContain("managed by Mark");
		const rows = [...element.el.querySelectorAll(".coding-body .coding-row")].map((row) => row.textContent);
		expect(rows).toEqual([
			"Cloning Qorpera_Base",
			"The delay came from the composer.Moving the refresh after the post.",
			"npx vitest run test/composer-send.test.ts passed",
		]);
		expect(element.el.querySelector(".coding-row-voice .coding-badge-claude-code")).not.toBeNull();
		// The session is working: the owner's field waits, and says so.
		const field = element.el.querySelector<HTMLInputElement>(".coding-field-input")!;
		expect(field.disabled).toBe(true);
		expect(element.el.querySelector(".coding-hint")?.textContent).toContain("Uses your Claude Code plan");
		const statuses = element.el.querySelectorAll(".coding-status");
		expect(statuses[statuses.length - 1]?.textContent).toContain("Working · 4 min");
		button(element.el, "Hide").click();
		expect(element.el.querySelector(".coding-body")).toBeNull();
	});

	it("a question opens the body for the owner, with the choices, 'Let Mark decide' and a free answer", async () => {
		const events = [
			event(1, "step", { text: "Cloning" }, "executor"),
			event(
				2,
				"needs_input",
				{ needs: "Keep 250 ms or raise to 500 ms?", options: ["Keep 250 ms", "Raise to 500 ms"] },
				"executor",
			),
		];
		const { element, answer, delegate, read } = mount(
			codingSession({ phase: "awaiting_input", workerState: "blocked" }),
			{
				events,
			},
		);
		await settle();
		expect(element.el.classList.contains("coding-session-expanded")).toBe(true);
		expect(element.el.querySelector(".coding-question")?.textContent).toContain("Claude Code asks");
		expect(element.el.querySelector(".coding-question")?.textContent).toContain("Keep 250 ms or raise to 500 ms?");
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		button(element.el, "Keep 250 ms").click();
		await settle();
		expect(answer).toHaveBeenCalledTimes(1);
		expect(answer.mock.calls[0]?.[0]).toBe(WORKER);
		expect(answer.mock.calls[0]?.[1]).toBe("Keep 250 ms");
		expect(answer.mock.calls[0]?.[2]).toMatch(uuid);
		// Answering re-reads the session at once.
		expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
		button(element.el, "Let Mark decide").click();
		await settle();
		expect(delegate).toHaveBeenCalledWith(WORKER, expect.stringMatching(uuid));
		const field = element.el.querySelector<HTMLInputElement>(".coding-field-input")!;
		expect(field.disabled).toBe(false);
		field.value = "Keep it, and add a comment why.";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(answer).toHaveBeenLastCalledWith(WORKER, "Keep it, and add a comment why.", expect.stringMatching(uuid));
	});

	it("a failed answer keeps the same request id for the retry and shows why", async () => {
		const { element, answer } = mount(codingSession({ phase: "awaiting_input", workerState: "blocked" }), {
			events: [event(1, "needs_input", { needs: "Which?", options: ["A", "B"] }, "executor")],
		});
		await settle();
		answer.mockRejectedValueOnce(new Error("The session is still working; wait for its question or its result"));
		button(element.el, "A").click();
		await settle();
		expect(element.el.querySelector(".coding-row-error")?.textContent).toContain("still working");
		button(element.el, "A").click();
		await settle();
		expect(answer).toHaveBeenCalledTimes(2);
		expect(answer.mock.calls[0]?.[2]).toBe(answer.mock.calls[1]?.[2]);
	});

	it("another member reads the same body behind a lock line and never gets a field", async () => {
		const { element } = mount(codingSession({ phase: "awaiting_input", workerState: "blocked", isOwner: false }), {
			viewer: "other",
			events: [event(1, "needs_input", { needs: "Which?" }, "executor")],
		});
		await settle();
		// Not the viewer's question: the body stays closed until asked for.
		expect(element.el.classList.contains("coding-session-expanded")).toBe(false);
		expect(element.el.querySelector(".coding-chip")?.textContent).toBe(
			"Mark's coding session with Jonas in Claude Code needs an answer from Jonas",
		);
		button(element.el, "Show").click();
		expect(element.el.querySelector(".coding-field-input")).toBeNull();
		expect(element.el.querySelector(".coding-talk-locked")?.textContent).toContain(
			"Only Jonas can type here. Everyone else steers through Mark. Uses Jonas's Claude Code plan.",
		);
	});

	it("a draft PR is a card with its checks and links, and the owner may follow up", async () => {
		const ask = vi.fn();
		const { element } = mount(
			codingSession({
				phase: "completed",
				workerState: "succeeded",
				pullRequest: {
					url: "https://github.com/Qorpera/Qorpera_Base/pull/204",
					number: 204,
					headSha: "b".repeat(40),
				},
				checks: [
					{ name: "web client", status: "passed" },
					{ name: "hosted database", status: "running" },
				],
				artifacts: [{ kind: "screenshot", objectId: id(201) }],
				finishedAt: "2026-09-22T10:11:00Z",
			}),
			{
				events: [
					event(
						1,
						"published",
						{ url: "https://github.com/Qorpera/Qorpera_Base/pull/204", number: 204 },
						"executor",
					),
					event(2, "finished", { summary: "Draft PR opened." }, "executor"),
				],
				askAgent: ask,
			},
		);
		await settle();
		expect(element.el.querySelector(".coding-status")?.textContent).toContain(
			"Draft PR ready · session kept for follow-ups",
		);
		button(element.el, "Show").click();
		expect(element.el.querySelector(".coding-pr-title")?.textContent).toBe("Draft pull request #204");
		expect(element.el.querySelector(".coding-pr-meta")?.textContent).toBe(
			"Qorpera/Qorpera_Base · qorpera/coding/1111… → master · 3 files · 1 artifact",
		);
		expect([...element.el.querySelectorAll(".coding-check")].map((check) => check.textContent)).toEqual([
			"web client · passed",
			"hosted database · running",
		]);
		const links = [...element.el.querySelectorAll<HTMLAnchorElement>(".coding-actions a")].map((a) => [
			a.textContent,
			a.href,
		]);
		expect(links).toEqual([
			["Review changes", "https://github.com/Qorpera/Qorpera_Base/pull/204/files"],
			["Open on GitHub", "https://github.com/Qorpera/Qorpera_Base/pull/204"],
		]);
		button(element.el, "Ask Mark to review").click();
		expect(ask).toHaveBeenCalledWith(expect.stringContaining("draft PR #204"));
		const field = element.el.querySelector<HTMLInputElement>(".coding-field-input")!;
		expect(field.disabled).toBe(false);
		expect(field.placeholder).toBe("Follow up on this session");
		expect([...element.el.querySelectorAll(".coding-body .coding-row")].map((row) => row.textContent)).toEqual([
			"Draft PR #204 opened",
			"Draft PR opened.",
		]);
	});

	it("folds older steps into one line and opens them on request", async () => {
		const events = Array.from({ length: 14 }, (_, index) =>
			event(index + 1, "step", { text: `Step ${index + 1}` }, "executor"),
		);
		const { element } = mount(codingSession(), { events });
		await settle();
		button(element.el, "Show").click();
		expect(element.el.querySelector(".coding-row-fold")?.textContent).toBe("4 earlier steps");
		expect(element.el.querySelectorAll(".coding-row-step")).toHaveLength(10);
		button(element.el, "4 earlier steps").click();
		expect(element.el.querySelectorAll(".coding-row-step")).toHaveLength(14);
	});

	it("follows the stream on its own clock: fast while working, slow once settled, and stops when disposed", async () => {
		const { element, read, state } = mount(codingSession());
		await settle();
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(read).toHaveBeenCalledTimes(2);
		// The cursor moves past the events it has seen.
		state.events.push(event(1, "step", { text: "One" }, "executor"));
		await vi.advanceTimersByTimeAsync(2_500);
		expect(read).toHaveBeenLastCalledWith(WORKER, 0);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(read).toHaveBeenLastCalledWith(WORKER, 1);
		state.session = codingSession({
			phase: "completed",
			workerState: "succeeded",
			updatedAt: "2026-09-22T10:20:00Z",
		});
		await vi.advanceTimersByTimeAsync(2_500);
		const settledReads = read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledTimes(settledReads);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).toHaveBeenCalledTimes(settledReads + 1);
		element.dispose();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(read).toHaveBeenCalledTimes(settledReads + 1);
	});

	it("takes a newer listing from the thread and keeps the older of two", async () => {
		const { element } = mount(codingSession());
		await settle();
		element.update(codingSession({ phase: "queued", updatedAt: "2026-09-22T09:59:30Z" }));
		expect(element.session.phase).toBe("running");
		element.update(
			codingSession({ phase: "awaiting_input", workerState: "blocked", updatedAt: "2026-09-22T10:05:00Z" }),
		);
		expect(element.session.phase).toBe("awaiting_input");
		expect(element.el.querySelector(".coding-chip")?.textContent).toContain("needs your answer");
	});
});
