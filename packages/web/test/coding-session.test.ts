// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodingSession,
	type CodingSessionEvent,
	type CodingSessionLogins,
	type CodingSessionRead,
	codingSessionGoing,
	codingSessionTakesInput,
	compareCodingSessions,
	parseCodingSession,
	parseCodingSessionLogins,
	parseCodingSessionRead,
	parseCodingSessions,
} from "../src/cloud/coding-session.ts";
import conversationCss from "../src/styles/conversation.css?raw";
import {
	CodingPill,
	CodingSessionElement,
	type CodingSessionNames,
	codingLoginReason,
	codingSessionActivity,
	codingSessionLine,
	codingSessionStandby,
	codingSessionStatus,
	codingTurnStartedAt,
	fmtDuration,
	harnessBadge,
	harnessMark,
	shortBranch,
} from "../src/ui/coding-session.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
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
		standby: true,
		attached: false,
		runningCommands: 0,
		machineAsleep: false,
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

/** An event of a given turn, at a given time. */
function turnEvent(
	idNumber: number,
	sequence: number,
	kind: CodingSessionEvent["kind"],
	body: CodingSessionEvent["body"],
	at: string,
	actor: CodingSessionEvent["actor"] = "executor",
): CodingSessionEvent {
	return { ...event(idNumber, kind, body, actor), sequence, at };
}

const owner: CodingSessionNames = { agent: "Mark", owner: "you", ownerIsViewer: true };
const other: CodingSessionNames = { agent: "Mark", owner: "Jonas", ownerIsViewer: false };
const NOW = Date.parse("2026-09-22T10:04:00Z");
/** The report of 31 Oct: a session started 22 h 11 min before NOW is on a follow-up's turn. */
const RESUMED: Partial<CodingSession> = {
	sequence: 2,
	startedAt: "2026-09-21T11:53:00Z",
	lastStep: "Workspace ready",
	filesChanged: 0,
};

describe("the captions the kernel state produces", () => {
	it("is one plain sentence around the harness, in English and in Danish", () => {
		expect(codingSessionLine("codex")).toEqual({ before: "Started a coding session in ", name: "Codex", after: "" });
		expect(codingSessionLine("claude-code").name).toBe("Claude Code");
		setLanguagePreference("da");
		try {
			expect(codingSessionLine("codex")).toEqual({ before: "Startede en kodesession i ", name: "Codex", after: "" });
		} finally {
			setLanguagePreference("system");
			localStorage.clear();
		}
	});

	it("draws each harness with its maker's own mark", () => {
		// OpenAI's mark for Codex (as on the Connections card), the Claude spark for Claude Code.
		const codex = harnessMark("codex", 14);
		expect(codex.getAttribute("viewBox")).toBe("146.694 227.042 267.198 264.812");
		expect(codex.querySelector("path")?.getAttribute("d")).toMatch(/^M249\.176 323\.434V298\.276/);
		expect(codex.getAttribute("width")).toBe("14");
		const claude = harnessMark("claude-code", 14);
		expect(claude.getAttribute("viewBox")).toBe("0 0 24 24");
		expect(claude.querySelector("path")?.getAttribute("d")).toMatch(/^m4\.7144 15\.9555/);
		expect(claude.classList.contains("coding-mark-claude-code")).toBe(true);
		const badge = harnessBadge("claude-code");
		expect(badge.className).toBe("coding-badge coding-badge-claude-code");
		expect(badge.querySelector(".coding-mark-claude-code")).not.toBeNull();
	});

	it("moves the header's figure as an agent's: working, waiting on an answer, still in the queue or archived", () => {
		expect(codingSessionActivity({ phase: "running" })).toBe("Working");
		expect(codingSessionActivity({ phase: "preparing" })).toBe("Working");
		expect(codingSessionActivity({ phase: "input_ready" })).toBe("Working");
		expect(codingSessionActivity({ phase: "publishing" })).toBe("Working");
		expect(codingSessionActivity({ phase: "awaiting_input" })).toBe("Waiting");
		expect(codingSessionActivity({ phase: "queued" })).toBe("Idle");
		expect(codingSessionActivity({ phase: "completed" })).toBe("Idle");
		// An archived session that was asking waits for nothing.
		expect(codingSessionActivity({ phase: "awaiting_input", archivedAt: "2026-09-22T10:04:00Z" })).toBe("Idle");
		expect(codingSessionGoing({ phase: "awaiting_input", archivedAt: "2026-09-22T10:04:00Z" })).toBe(false);
		expect(codingSessionGoing({ phase: "awaiting_input" })).toBe(true);
	});

	it("writes the status from the phase, the clock, the last step and the diff size", () => {
		expect(codingSessionStatus(codingSession(), owner, NOW)).toEqual({
			text: "Working · 4 min · running vitest in packages/web · 3 files changed",
			tone: "working",
		});
		expect(codingSessionStatus(codingSession({ phase: "queued" }), owner, NOW).text).toBe("Waiting for a computer");
		// A turn waiting for its company's computer hours says so (20260928319760).
		expect(
			codingSessionStatus(codingSession({ phase: "queued", lastStep: "Waiting for computer hours" }), owner, NOW),
		).toEqual({ text: "Waiting for computer hours", tone: "idle" });
		expect(
			codingSessionStatus(
				codingSession({ phase: "input_ready", lastStep: "Waiting for computer hours" }),
				owner,
				NOW,
			),
		).toEqual({ text: "Answer sent · waiting for computer hours", tone: "idle" });
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
		// Between turns: where the session is, instead of the generic "kept".
		const done = { phase: "completed" as const, pullRequest: { url: "https://x.invalid/pull/1", number: 1 } };
		expect(codingSessionStatus(codingSession({ ...done, attached: true }), owner, NOW).text).toBe(
			"Draft PR ready · standing by",
		);
		expect(codingSessionStatus(codingSession({ ...done, attached: true, runningCommands: 2 }), owner, NOW).text).toBe(
			"Draft PR ready · running 2 commands",
		);
		expect(codingSessionStatus(codingSession({ ...done, machineAsleep: true }), owner, NOW).text).toBe(
			"Draft PR ready · asleep",
		);
		expect(
			codingSessionStatus(codingSession({ phase: "awaiting_input", attached: true, runningCommands: 1 }), owner, NOW)
				.text,
		).toBe("Needs you · your answer is recorded in this thread · running 1 command");
		expect(codingSessionStatus(codingSession({ phase: "failed", attached: true }), owner, NOW).text).toBe(
			"Failed · standing by",
		);
		expect(
			codingSessionStatus(codingSession({ phase: "cancelled", archivedAt: "2026-09-22T10:04:00Z" }), owner, NOW),
		).toEqual({ text: "Archived · files kept", tone: "idle" });
		expect(codingSessionStandby(codingSession({ attached: false, runningCommands: 3 }))).toBeUndefined();
		expect(fmtDuration(30_000)).toBe("less than a minute");
		expect(fmtDuration(65 * 60_000)).toBe("1 h 5 min");
		expect(shortBranch(`qorpera/coding/${WORKER}`)).toBe("qorpera/coding/1111…");
	});

	it("times a later turn from its own first claim, never from the session's start", () => {
		const resumed = codingSession(RESUMED);
		const events = [
			turnEvent(1, 1, "phase", { phase: "preparing", owner: "executor" }, "2026-09-21T11:53:00Z"),
			turnEvent(2, 1, "phase", { phase: "running" }, "2026-09-21T11:53:20Z"),
			turnEvent(3, 2, "input", { text: "Also check the footer" }, "2026-09-22T10:03:02.824Z", "member"),
			turnEvent(4, 2, "phase", { phase: "preparing", owner: "executor" }, "2026-09-22T10:03:03Z"),
			turnEvent(5, 2, "phase", { phase: "running" }, "2026-09-22T10:03:10Z"),
		];
		// The turn was claimed 57 s ago: it says so, not 22 h.
		expect(codingTurnStartedAt(resumed, events)).toBe("2026-09-22T10:03:03Z");
		expect(codingSessionStatus(resumed, owner, NOW, events)).toEqual({
			text: "Working · less than a minute · Workspace ready",
			tone: "working",
		});
		// Without the stream (the pill reads only the listing) a later turn shows no time, never the session's age.
		expect(codingTurnStartedAt(resumed)).toBeUndefined();
		expect(codingSessionStatus(resumed, owner, NOW)).toEqual({ text: "Working · Workspace ready", tone: "working" });
		// An earlier turn's claim never dates this one: until this turn's claim is read, no time either.
		expect(codingSessionStatus(resumed, owner, NOW, events.slice(0, 3)).text).toBe("Working · Workspace ready");
		// A turn claimed again (deferred, then taken) counts from its first claim, as startedAt does for the first.
		const reclaimed = [
			...events.slice(0, 3),
			turnEvent(4, 2, "phase", { phase: "preparing", owner: "executor" }, "2026-09-22T10:02:30Z"),
			turnEvent(5, 2, "phase", { phase: "preparing", owner: "executor" }, "2026-09-22T10:03:30Z"),
			turnEvent(6, 2, "phase", { phase: "running" }, "2026-09-22T10:03:40Z"),
		];
		expect(codingSessionStatus(resumed, owner, NOW, reclaimed).text).toBe("Working · 1 min · Workspace ready");
		// The first turn keeps its own time, from startedAt, with the stream or without it.
		const first = "Working · 4 min · running vitest in packages/web · 3 files changed";
		expect(codingSessionStatus(codingSession(), owner, NOW, events.slice(0, 2)).text).toBe(first);
		expect(codingSessionStatus(codingSession(), owner, NOW).text).toBe(first);
		// Preparing and waiting for an answer count from updatedAt, as before, on any turn.
		for (const sequence of [1, 2]) {
			const turn = { ...RESUMED, sequence };
			expect(codingSessionStatus(codingSession({ ...turn, phase: "preparing" }), owner, NOW, events).text).toBe(
				"Preparing the workspace · 1 min",
			);
			expect(codingSessionStatus(codingSession({ ...turn, phase: "awaiting_input" }), other, NOW, events).text).toBe(
				"Needs Jonas · paused 1 min",
			);
			expect(codingSessionStatus(codingSession({ ...turn, phase: "awaiting_input" }), owner, NOW).text).toBe(
				"Needs you · your answer is recorded in this thread",
			);
		}
	});

	it("knows when the owner may type: while the session asks, or once it settled", () => {
		expect(codingSessionTakesInput(codingSession())).toBe(false);
		expect(codingSessionTakesInput(codingSession({ phase: "awaiting_input" }))).toBe(true);
		expect(codingSessionTakesInput(codingSession({ phase: "completed" }))).toBe(true);
		// Any number of turns; an archived session takes a message, which reopens it.
		expect(codingSessionTakesInput(codingSession({ phase: "cancelled", sequence: 65 }))).toBe(true);
		expect(codingSessionTakesInput(codingSession({ phase: "cancelled", archivedAt: "2026-09-22T10:04:00Z" }))).toBe(
			true,
		);
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

	it("reads whether the session's login can pay, the last turn's reason and the owner's logins", () => {
		// 20260930551000: the view names the login's state and the last turn's reason; an older cloud names neither.
		expect(parseCodingSession(wire)).not.toHaveProperty("loginState");
		expect(parseCodingSession(wire)).not.toHaveProperty("reason");
		expect(parseCodingSession({ ...wire, loginState: "removed", reason: "login_removed" })).toMatchObject({
			loginState: "removed",
			reason: "login_removed",
		});
		expect(parseCodingSession({ ...wire, loginState: "gone", reason: null })).not.toHaveProperty("loginState");
		const logins = parseCodingSessionLogins({
			schema: "qorpera.coding-session-logins/v1",
			workerId: WORKER,
			current: { connectionId: id(31), state: "removed" },
			logins: [
				{ connectionId: id(32), email: "b@example.com", current: false },
				{ connectionId: id(33), email: null, current: false },
			],
		});
		expect(logins).toEqual({
			current: { connectionId: id(31), state: "removed" },
			logins: [
				{ connectionId: id(32), email: "b@example.com", current: false },
				{ connectionId: id(33), current: false },
			],
		});
		expect(parseCodingSessionLogins({ schema: "qorpera.coding-session-logins/v1", current: {}, logins: [] })).toEqual(
			{ current: {}, logins: [] },
		);
		expect(() => parseCodingSessionLogins({ schema: "qorpera.other/v1", current: {}, logins: [] })).toThrow();
		expect(() =>
			parseCodingSessionLogins({
				schema: "qorpera.coding-session-logins/v1",
				current: {},
				logins: [{ connectionId: "nope" }],
			}),
		).toThrow();
	});

	it("reads where the session is between turns, and any number of turns", () => {
		// A cloud that does not keep sessions standing by yet says nothing about it.
		expect(parseCodingSession(wire)).toMatchObject({
			standby: false,
			attached: false,
			runningCommands: 0,
			machineAsleep: false,
		});
		const standing = parseCodingSession({
			...wire,
			sequence: 120,
			attached: true,
			runningCommands: 2,
			busyAt: wire.updatedAt,
			machineAsleep: false,
			archivedAt: null,
			archivedBy: null,
		});
		expect(standing).toMatchObject({ standby: true, sequence: 120, attached: true, runningCommands: 2 });
		expect(standing.archivedAt).toBeUndefined();
		expect(
			parseCodingSession({ ...wire, attached: false, archivedAt: wire.updatedAt, machineAsleep: true }),
		).toMatchObject({ standby: true, archivedAt: wire.updatedAt, machineAsleep: true });
		expect(parseCodingSession({ ...wire, runningCommands: -1 }).runningCommands).toBe(0);
	});

	it("orders two copies by their update, then by when they were asked for", () => {
		const earlier = parseCodingSession(wire, 100),
			later = parseCodingSession(wire, 200);
		expect(earlier.askedAt).toBe(100);
		expect(compareCodingSessions(later, earlier)).toBeGreaterThan(0);
		expect(compareCodingSessions(earlier, later)).toBeLessThan(0);
		const updated = parseCodingSession(
			{ ...wire, updatedAt: new Date(Date.parse(wire.updatedAt) + 60_000).toISOString() },
			50,
		);
		expect(compareCodingSessions(updated, later)).toBeGreaterThan(0);
		expect(parseCodingSessions({ sessions: [wire] }, 300)[0]?.askedAt).toBe(300);
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
			/** How many events one read returns at most, as the cloud's page does. */
			page?: number;
			/** The owner's logins as the cloud lists them; without, the api has no login calls. */
			logins?: CodingSessionLogins;
		} = {},
	) {
		const events = options.events ?? [];
		const state = { session, events };
		const read = vi.fn(
			async (_workerId: string, afterEvent: number): Promise<CodingSessionRead> => ({
				session: state.session,
				isOwner: options.viewer !== "other",
				events: state.events.filter((event) => event.id > afterEvent).slice(0, options.page),
			}),
		);
		const answer = vi.fn(async (_workerId: string, _text: string, _clientRequestId: string): Promise<void> => {});
		const delegate = vi.fn(async (_workerId: string, _clientRequestId: string): Promise<void> => {});
		const archive = vi.fn(async (_workerId: string, _clientRequestId: string): Promise<void> => {});
		const logins = vi.fn(async (_workerId: string): Promise<CodingSessionLogins> => options.logins!);
		const chooseLogin = vi.fn(async (_workerId: string, _connectionId: string): Promise<void> => {});
		const names = options.viewer === "other" ? other : owner;
		const element = new CodingSessionElement(session, {
			names: () => names,
			viewerOwns: () => options.viewer !== "other",
			api: { read, answer, delegate, archive, ...(options.logins ? { logins, chooseLogin } : {}) },
			signal: disposeAll.signal,
			askAgent: options.askAgent,
		});
		document.body.append(element.el);
		return { element, read, answer, delegate, archive, logins, chooseLogin, state };
	}
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	const archiveOffered = (root: ParentNode) => {
		const pill = root.querySelector<HTMLButtonElement>(".coding-archive");
		return Boolean(pill && !pill.hidden);
	};
	const button = (root: ParentNode, label: string) => {
		const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
		if (!found) throw new Error(`Missing button: ${label}`);
		return found;
	};

	it("shows the session's own steps and voice, the input and the status", async () => {
		const events = [
			event(1, "phase", { phase: "queued" }, "kernel"),
			event(2, "step", { text: "Cloning Qorpera_Base" }, "executor"),
			event(3, "text", { text: "The delay came from the composer.\n\nMoving the refresh after the post." }),
			event(4, "step", { text: "npx vitest run test/composer-send.test.ts", status: "passed" }),
		];
		const { element, read } = mount(codingSession(), { events });
		await settle();
		expect(read).toHaveBeenCalledWith(WORKER, 0);
		expect(element.el.querySelector(".coding-intro .coding-title")?.textContent).toBe("Fix the delay after send");
		expect(element.el.querySelector(".coding-meta")?.textContent).toBe(
			`Qorpera_Base·qorpera/coding/1111…·claude-sonnet-5`,
		);
		// One turn for the harness, behind its mark: its steps, then what it said, a bubble a paragraph, then a step.
		const turns = [...element.el.querySelectorAll<HTMLElement>(".coding-body .coding-turn")];
		expect(turns.map((turn) => turn.className)).toEqual(["coding-turn coding-turn-harness"]);
		const turn = turns[0]!;
		expect(turn.querySelector(".coding-avatar .coding-badge-claude-code")).not.toBeNull();
		expect(turn.querySelector(".message-author")?.textContent).toBe("Claude Code");
		expect(
			[...turn.querySelectorAll(".coding-turn-body > *")].map((node) =>
				node.classList.contains("coding-steps")
					? `steps: ${[...node.children].map((row) => row.textContent).join(" | ")}`
					: node.classList.contains("bubble")
						? `bubble: ${node.textContent}`
						: node.className,
			),
		).toEqual([
			"message-author",
			"steps: Cloning Qorpera_Base",
			"bubble: The delay came from the composer.",
			"bubble: Moving the refresh after the post.",
			"steps: npx vitest run test/composer-send.test.ts passed",
		]);
		// The session is working: the owner's field, under the transcript, waits and says so.
		const field = element.el.querySelector<HTMLTextAreaElement>(".coding-footer .coding-field-input")!;
		// Read-only, never disabled: a disabled field would drop the caret and the thread's Escape with it.
		expect(field.disabled).toBe(false);
		expect(field.readOnly).toBe(true);
		expect(field.getAttribute("aria-disabled")).toBe("true");
		expect(field.placeholder).toBe("Claude Code is working");
		expect(element.el.querySelector(".coding-hint")).toBeNull();
		expect(element.el.querySelector(".coding-footer .coding-status")?.textContent).toContain("Working · 4 min");
		// The visible line changes with every step; only a phase change is read out.
		expect(element.el.querySelector(".coding-status")?.hasAttribute("role")).toBe(false);
		const announced = element.el.querySelector<HTMLElement>(".coding-footer .visually-hidden[role=status]")!;
		expect(announced.textContent).toContain("Working · 4 min");
		// No fold in the session's own thread: it is always open.
		expect(element.el.querySelector(".coding-chip, .coding-link")).toBeNull();
	});

	it("a question gives the owner the choices, 'Let Mark decide' and a free answer", async () => {
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
		// The question is the harness's bubble, marked while it waits; the choices stand over the composer.
		const question = element.el.querySelector(".coding-turn-harness .coding-question")!;
		expect(question.textContent).toBe("Keep 250 ms or raise to 500 ms?");
		expect(question.classList.contains("coding-question-live")).toBe(true);
		expect(
			[...element.el.querySelectorAll(".coding-footer .coding-options button")].map((item) => item.textContent),
		).toEqual(["Keep 250 ms", "Raise to 500 ms", "Let Mark decide"]);
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		// A used choice goes with the redraw; the focus stays in the session's log, not on the page's body.
		const keep = button(element.el, "Keep 250 ms");
		keep.focus();
		keep.click();
		await settle();
		expect(document.activeElement).toBe(element.el.querySelector(".coding-log"));
		expect(answer).toHaveBeenCalledTimes(1);
		expect(answer.mock.calls[0]?.[0]).toBe(WORKER);
		expect(answer.mock.calls[0]?.[1]).toBe("Keep 250 ms");
		expect(answer.mock.calls[0]?.[2]).toMatch(uuid);
		// Answering re-reads the session at once.
		expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
		button(element.el, "Let Mark decide").click();
		await settle();
		expect(delegate).toHaveBeenCalledWith(WORKER, expect.stringMatching(uuid));
		const field = element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		expect(field.getAttribute("aria-disabled")).toBe("false");
		expect(field.readOnly).toBe(false);
		expect(field.placeholder).toBe("Or answer in your own words");
		field.value = "Keep it, and add a comment why.";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(answer).toHaveBeenLastCalledWith(WORKER, "Keep it, and add a comment why.", expect.stringMatching(uuid));
		// A typed answer empties the composer; the same field stays in place for the next.
		expect(field.value).toBe("");
		expect(element.el.querySelector(".coding-field-input")).toBe(field);
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
		expect(element.el.querySelector(".coding-question")?.textContent).toBe("Which?");
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Needs Jonas · paused 1 min");
		expect(element.el.querySelector(".coding-field-input, .coding-options")).toBeNull();
		expect(element.el.querySelector(".coding-footer .coding-talk-locked")?.textContent).toBe(
			"Only Jonas can write to this session. Steer it through Mark.",
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
		// The card stands in the harness's turn where the pull request was published, not as a line as well.
		expect(element.el.querySelector(".coding-turn-harness .coding-pr .coding-pr-title")?.textContent).toBe(
			"Draft pull request #204",
		);
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
		const field = element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		expect(field.getAttribute("aria-disabled")).toBe("false");
		expect(field.placeholder).toBe("Follow up on this session");
		expect([...element.el.querySelectorAll(".coding-body .coding-row")].map((row) => row.textContent)).toEqual([
			"Draft PR opened.",
		]);
	});

	it("keeps the caret in the composer after a follow-up, and sends once until the session is read again", async () => {
		const { element, answer, read, state } = mount(
			codingSession({ phase: "completed", workerState: "succeeded", finishedAt: "2026-09-22T10:03:00Z" }),
		);
		await settle();
		const field = element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		field.focus();
		field.value = "Also cover the retry.";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		// The read after the answer is slow: until it lands, the controls stay busy.
		let land: (() => void) | undefined;
		read.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				land = resolve;
			});
			return { session: state.session, isOwner: true, events: [] };
		});
		state.session = codingSession({ phase: "running", sequence: 2, updatedAt: "2026-09-22T10:05:00Z" });
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(answer).toHaveBeenCalledTimes(1);
		expect(field.value).toBe("");
		field.value = "Again";
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(answer).toHaveBeenCalledTimes(1);
		land?.();
		await settle();
		// Working again: the field turns read-only in place and keeps the caret.
		expect(element.session.phase).toBe("running");
		expect(field.readOnly).toBe(true);
		expect(document.activeElement).toBe(field);
	});

	it("draws a time break only over a step that shows, and dedupes a summary within its turn", async () => {
		const later = "2026-09-22T10:20:00Z";
		const { element } = mount(codingSession({ phase: "completed", workerState: "succeeded" }), {
			events: [
				{ ...event(1, "text", { text: "Done: the send waits no more." }), at: "2026-09-22T10:00:00Z" },
				// The same words as the harness's last message, ten minutes on: no bare time break for it.
				{ ...event(2, "finished", { summary: "Done: the send waits no more." }, "executor"), at: later },
			],
		});
		await settle();
		expect(element.el.querySelectorAll(".coding-body time")).toHaveLength(1);
		expect(element.el.querySelector(".coding-row-done")).toBeNull();
		// After the owner's follow-up the same words are the new turn's own summary, and show.
		const again = mount(codingSession({ phase: "completed", workerState: "succeeded" }), {
			events: [
				event(1, "text", { text: "Done." }),
				event(2, "input", { text: "And the retry?" }, "member"),
				event(3, "finished", { summary: "Done." }, "executor"),
			],
		});
		await settle();
		expect([...again.element.el.querySelectorAll(".coding-body .coding-turn")].map((turn) => turn.className)).toEqual(
			["coding-turn coding-turn-harness", "coding-turn coding-turn-mine mine", "coding-turn coding-turn-harness"],
		);
		expect(again.element.el.querySelector(".coding-row-done")?.textContent).toBe("Done.");
	});

	it("keeps the pull request's card at the top of what is shown when its publish is folded away", async () => {
		const url = "https://github.com/Qorpera/Qorpera_Base/pull/204";
		const { element } = mount(
			codingSession({
				phase: "running",
				sequence: 2,
				pullRequest: { url, number: 204 },
			}),
			{
				events: [
					event(1, "published", { url, number: 204 }, "executor"),
					...Array.from({ length: 12 }, (_, index) => event(index + 2, "step", { text: `Step ${index + 1}` })),
				],
			},
		);
		await settle();
		const body = element.el.querySelector(".coding-body")!;
		// Fold, the first shown step's time break, then the harness's turn opening with the card.
		expect([...body.children].slice(0, 3).map((node) => node.tagName.toLowerCase())).toEqual(["div", "time", "div"]);
		expect(body.children[0]?.classList.contains("coding-row-fold")).toBe(true);
		expect(body.children[2]?.querySelector(".coding-turn-body > .message-author + .coding-pr")).not.toBeNull();
		expect(body.querySelectorAll(".coding-pr")).toHaveLength(1);
		// Opening the older steps keeps the focus in the session, off the button the redraw removed.
		const fold = button(element.el, "3 earlier steps");
		fold.focus();
		fold.click();
		expect(document.activeElement).toBe(element.el.querySelector(".coding-log"));
	});

	it("answers only the question of the session's current turn", async () => {
		// The listing already says the session asks again (turn 2); the new question is not read yet.
		const { element } = mount(codingSession({ phase: "awaiting_input", workerState: "blocked", sequence: 2 }), {
			events: [{ ...event(1, "needs_input", { needs: "Which?", options: ["A", "B"] }, "executor"), sequence: 1 }],
		});
		await settle();
		expect(element.el.querySelector(".coding-question-live")).toBeNull();
		expect([...element.el.querySelectorAll(".coding-options button")].map((item) => item.textContent)).toEqual([
			"Let Mark decide",
		]);
	});

	it("takes a follow-up past any turn, and a message reopens an archived session", async () => {
		const { element } = mount(codingSession({ phase: "completed", workerState: "succeeded", sequence: 70 }));
		await settle();
		const field = element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		expect(field.getAttribute("aria-disabled")).toBe("false");
		expect(field.placeholder).toBe("Follow up on this session");
		element.dispose();
		element.el.remove();
		const archived = mount(
			codingSession({ phase: "cancelled", workerState: "cancelled", archivedAt: "2026-09-22T10:04:00Z" }),
		);
		await settle();
		const again = archived.element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		expect(again.getAttribute("aria-disabled")).toBe("false");
		expect(again.placeholder).toBe("Send a message to reopen this session");
		// Archived already: no second Archive.
		expect(archiveOffered(archived.element.el)).toBe(false);
	});

	it("lets the owner archive the session under one request id, and reads it again after", async () => {
		const { element, archive, read, state } = mount(
			codingSession({ phase: "completed", workerState: "succeeded", attached: true, runningCommands: 1 }),
		);
		await settle();
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Finished · running 1 command");
		const reads = read.mock.calls.length;
		archive.mockImplementationOnce(async () => {
			state.session = codingSession({
				phase: "completed",
				workerState: "succeeded",
				archivedAt: "2026-09-22T10:04:00Z",
				updatedAt: "2026-09-22T10:04:00Z",
			});
		});
		element.el.querySelector<HTMLButtonElement>(".coding-archive")!.click();
		await settle();
		expect(archive).toHaveBeenCalledTimes(1);
		expect(archive.mock.calls[0]?.[0]).toBe(WORKER);
		expect(read.mock.calls.length).toBeGreaterThan(reads);
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Archived · files kept");
		expect(archiveOffered(element.el)).toBe(false);
		// Read out once, now that it changed.
		expect(element.el.querySelector(".coding-footer [role=status]")?.textContent).toBe("Archived · files kept");
	});

	it("offers Archive to the owner only, once the cloud keeps sessions standing by", async () => {
		const { element } = mount(codingSession({ phase: "completed", workerState: "succeeded" }), { viewer: "other" });
		await settle();
		expect(archiveOffered(element.el)).toBe(false);
		const before = mount(codingSession({ phase: "completed", workerState: "succeeded", standby: false }));
		await settle();
		expect(archiveOffered(before.element.el)).toBe(false);
		const now = mount(codingSession({ phase: "completed", workerState: "succeeded" }));
		await settle();
		expect(archiveOffered(now.element.el)).toBe(true);
	});

	it("retries a refused archive under the same request id, and an answer under its own", async () => {
		const { element, archive, answer } = mount(codingSession({ phase: "completed", workerState: "succeeded" }));
		await settle();
		archive.mockRejectedValueOnce(new Error("The cloud is busy"));
		const pill = element.el.querySelector<HTMLButtonElement>(".coding-archive")!;
		pill.click();
		await settle();
		expect(element.el.querySelector(".coding-row-error")?.textContent).toBe("The cloud is busy");
		pill.click();
		await settle();
		expect(archive).toHaveBeenCalledTimes(2);
		expect(archive.mock.calls[1]?.[1]).toBe(archive.mock.calls[0]?.[1]);
		const field = element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		field.value = "And the retry?";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		element.el.querySelector<HTMLButtonElement>(".coding-send")!.click();
		await settle();
		expect(answer.mock.calls[0]?.[2]).not.toBe(archive.mock.calls[0]?.[1]);
	});

	it("keeps the focus on Archive while the status line changes under it", async () => {
		const { element } = mount(codingSession());
		await settle();
		const pill = element.el.querySelector<HTMLButtonElement>(".coding-archive")!;
		pill.focus();
		element.update(codingSession({ lastStep: "running biome", updatedAt: "2026-09-22T10:05:00Z" }));
		expect(element.el.querySelector(".coding-status-text")?.textContent).toContain("running biome");
		expect(document.activeElement).toBe(pill);
		expect(pill.isConnected).toBe(true);
		// Archived elsewhere (the agent, another tab) while the pill has the focus: it stays in the session.
		element.update(codingSession({ archivedAt: "2026-09-22T10:06:00Z", updatedAt: "2026-09-22T10:06:00Z" }));
		expect(pill.hidden).toBe(true);
		expect(document.activeElement).toBe(element.el.querySelector(".coding-log"));
	});

	it("keeps what it read over an older copy of the same update handed in after", async () => {
		const done = { phase: "completed", workerState: "succeeded" } as const;
		const { element, state } = mount(codingSession({ ...done, attached: true, runningCommands: 1, askedAt: 1 }));
		await settle();
		state.session = codingSession({ ...done, machineAsleep: true, askedAt: 3 });
		await element.refresh();
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Finished · asleep");
		// A listing asked for before that read, from the conversation's store.
		element.update(codingSession({ ...done, attached: true, runningCommands: 1, askedAt: 2 }));
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Finished · asleep");
		// One asked for after it is newer.
		element.update(codingSession({ ...done, attached: true, askedAt: 4 }));
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Finished · standing by");
	});

	it("reads out nothing new while a turn works and only its commands change", async () => {
		const { element } = mount(codingSession());
		await settle();
		const status = element.el.querySelector(".coding-footer [role=status]")!;
		expect(status.textContent).toContain("Working");
		status.textContent = "(read)";
		element.update(codingSession({ attached: true, runningCommands: 1, askedAt: 5 }));
		element.update(codingSession({ attached: true, runningCommands: 0, askedAt: 6 }));
		expect(status.textContent).toBe("(read)");
		// Between turns the same change is shown, and read out.
		element.update(
			codingSession({
				phase: "completed",
				workerState: "succeeded",
				attached: true,
				updatedAt: "2026-09-22T10:06:00Z",
			}),
		);
		expect(status.textContent).toBe("Finished · standing by");
	});

	it("treats an archived session that was asking as settled: no choices, the slow pace", async () => {
		const { element, read } = mount(
			codingSession({ phase: "awaiting_input", workerState: "blocked", archivedAt: "2026-09-22T10:04:00Z" }),
			{ events: [event(1, "needs_input", { needs: "Which?", options: ["A", "B"] }, "executor")] },
		);
		await settle();
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe("Archived · files kept");
		expect(element.el.querySelector(".coding-options")).toBeNull();
		expect(element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")?.placeholder).toBe(
			"Send a message to reopen this session",
		);
		const reads = read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read.mock.calls.length).toBe(reads);
	});

	it("tells where the session went as notes, not as the harness speaking", async () => {
		const { element } = mount(codingSession({ phase: "completed", workerState: "succeeded" }), {
			events: [
				event(1, "step", { text: "Prepared the repository at abc1234" }, "executor"),
				event(
					2,
					"step",
					{
						text: "The machine went to sleep; 1 command was stopped",
						reason: "SLEEP",
						stopped: [{ commandId: id(5), turn: 1, command: "npm run dev" }],
					},
					"executor",
				),
				event(3, "step", { text: "Archived", archived: true, by: "agent" }, "kernel"),
				event(4, "step", { text: "Reopened", reopened: true }, "kernel"),
				// Only the kernel says a session was archived.
				event(5, "step", { text: "Archived the old branch", archived: true }, "harness"),
				event(
					7,
					"step",
					{ text: "Quiet for 3 days; asked the agent whether it can be archived", quietDays: 3 },
					"kernel",
				),
				event(
					6,
					"step",
					{
						text: "The session lost its machine; 35 commands were stopped",
						reason: "EXPIRED",
						stopped: Array.from({ length: 32 }, (_, index) => ({
							commandId: id(40 + index),
							turn: 1,
							command: "x",
						})),
						moreStopped: 3,
					},
					"executor",
				),
				// The machine stopped from outside, with commands running in this session and without.
				event(
					8,
					"step",
					{
						text: "The machine stopped; 2 commands were stopped",
						reason: "MACHINE_STOPPED",
						stopped: [
							{ commandId: id(80), turn: 2, command: "npm run dev" },
							{ commandId: id(81), turn: 2, command: "npm test -- --watch" },
						],
						moreStopped: 0,
					},
					"executor",
				),
				event(
					9,
					"step",
					{ text: "The machine stopped", reason: "MACHINE_STOPPED", stopped: [], moreStopped: 0 },
					"executor",
				),
				// The executor restarted the machine for the company folder (F3 5g-5).
				event(
					10,
					"step",
					{
						text: "The machine restarted for the company folder; 1 command was stopped",
						reason: "FOLDER_RESTART",
						stopped: [{ commandId: id(82), turn: 3, command: "npm run dev" }],
						moreStopped: 0,
					},
					"executor",
				),
				// The executor gave the machine a new disk, as a read it held is no longer readable (F3 5g-5).
				event(
					11,
					"step",
					{
						text: "The machine got a new disk; only the company folder was kept; 2 commands were stopped",
						reason: "MACHINE_NEW_DISK",
						stopped: [
							{ commandId: id(83), turn: 4, command: "npm run dev" },
							{ commandId: id(84), turn: 4, command: "docker compose up" },
						],
						moreStopped: 0,
					},
					"executor",
				),
			],
		});
		await settle();
		const notes = [...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent);
		expect(notes).toEqual([
			"The machine went to sleep · 1 command stopped",
			"Mark archived the session",
			"Reopened",
			"The session lost its machine · 35 commands stopped",
			"Quiet for 3 days · asked Mark whether it can be archived",
			"The machine stopped · 2 commands stopped",
			"The machine stopped",
			"The machine restarted · 1 command stopped",
			"The machine got a new disk · 2 commands stopped",
		]);
		// The working step stays the harness's.
		expect(element.el.querySelector(".coding-steps")?.textContent).toContain("Prepared the repository at abc1234");
	});

	it("says a turn cut off for computer hours in plain words, never with its code", async () => {
		const { element } = mount(codingSession({ phase: "failed", workerState: "failed" }), {
			events: [
				event(
					1,
					"failed",
					{
						summary: "The coding turn did not finish: Out of computer hours [code=COMPUTER_HOURS_EXHAUSTED]",
					},
					"executor",
				),
			],
		});
		await settle();
		const notes = [...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent);
		expect(notes).toEqual([
			"The company ran out of computer hours. The workspace is kept; a follow-up continues once hours are added.",
		]);
	});

	it("says a turn that stopped at its login's usage limit, in OpenAI's words for the owner's own plan", async () => {
		const failed = (id: number, extra: Record<string, unknown>) =>
			event(
				id,
				"failed",
				{
					summary:
						"The coding turn did not finish: Native provider bridge request failed (422) [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]",
					...extra,
				},
				"executor",
			);
		const events = [
			failed(1, { usageLimit: true, paidByChatgptPlan: true }),
			failed(2, { usageLimit: true, paidByChatgptPlan: false }),
			failed(3, {}),
		];
		for (const [viewer, first] of [
			[
				"owner",
				"ChatGPT · Usage limit reached. Review your plan or this app's limit in ChatGPT settings. The workspace is kept; a follow-up continues it. Manage usage",
			],
			[
				"other",
				"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up continues it on another of its owner's logins that has room, or once the limit resets.",
			],
		] as const) {
			const { element } = mount(codingSession({ phase: "failed", workerState: "failed" }), { events, viewer });
			await settle();
			const notes = [...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent);
			expect(notes).toEqual([
				first,
				"The model account paying for this session reached its usage limit. The workspace is kept; a follow-up continues it on another of its owner's logins that has room, or once the limit resets.",
				// Without the kernel's word, a spent budget is not taken for a usage limit.
				"Something on Qorpera's side refused one of the session's steps. The workspace is kept; a follow-up continues it.",
			]);
			expect(element.el.querySelector<HTMLAnchorElement>('[data-action="manage-usage"]')?.href ?? null).toBe(
				viewer === "owner" ? "https://chatgpt.com/settings/usage" : null,
			);
			element.dispose?.();
		}
	});

	it("says a turn whose login was removed, offers the owner's other logins and moves the session only on a click", async () => {
		// 3 November 2026: the founder signed out the session's login and its next turn read only "did not finish".
		const failed = event(
			1,
			"failed",
			{
				summary: "This coding session's login was removed (signed out), so its turn could not run.",
				code: "login_removed",
			},
			"executor",
		);
		const logins: CodingSessionLogins = {
			current: { connectionId: id(31), state: "removed" },
			logins: [{ connectionId: id(32), email: "b@example.com", current: false }],
		};
		const removed = codingSession({
			phase: "failed",
			workerState: "failed",
			loginState: "removed",
			reason: "login_removed",
		});
		// Another member reads why and who can act, and is offered nothing.
		const seen = mount(removed, { events: [failed], viewer: "other", logins });
		await settle();
		expect([...seen.element.el.querySelectorAll(".coding-note")].map((note) => note.textContent)).toEqual([
			"This session's login was removed, so its turn could not run. Only Jonas can choose another login for it.",
		]);
		expect(seen.element.el.querySelector(".coding-logins")).toBeNull();
		expect(seen.logins).not.toHaveBeenCalled();
		seen.element.dispose?.();
		// The owner is told what to do, and offered their other login.
		const { element, chooseLogin, logins: listed, state, read } = mount(removed, { events: [failed], logins });
		await settle();
		expect([...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent)).toEqual([
			"This session's login was removed, so its turn could not run. Choose another of your logins for it, then send a message to continue.",
		]);
		expect(listed).toHaveBeenCalledWith(WORKER);
		expect(element.el.querySelector(".coding-logins p")?.textContent).toBe(
			"Continue this session with one of your logins:",
		);
		expect(chooseLogin).not.toHaveBeenCalled();
		// The click moves it; the session read again pays with it, and the offer goes.
		state.session = { ...removed, loginState: "ready", updatedAt: "2026-09-22T10:05:00Z" };
		state.events = [failed, event(2, "step", { loginChosen: true, text: "Moved to another login" }, "member")];
		const reads = read.mock.calls.length;
		button(element.el, "Use b@example.com").click();
		await settle();
		expect(chooseLogin).toHaveBeenCalledWith(WORKER, id(32));
		expect(read.mock.calls.length).toBeGreaterThan(reads);
		expect(element.el.querySelector(".coding-logins")).toBeNull();
		expect([...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent)).toContain(
			"You moved the session to another login",
		);
	});

	it("says when a turn moved the session to another login with room by itself", async () => {
		const failed = event(
			1,
			"failed",
			{ summary: "The login paying for this work reached its usage limit.", usageLimit: true, code: "usage_limit" },
			"executor",
		);
		const moved = event(
			2,
			"step",
			{ loginChosen: true, automatic: true, text: "Moved to another login with room" },
			"kernel",
		);
		const { element } = mount(codingSession({ phase: "running", loginState: "ready" }), { events: [failed, moved] });
		await settle();
		expect([...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent)).toContain(
			"Moved to another login with room",
		);
	});

	it("offers the owner's other logins after a usage limit until the session moves, and says when none can pay", async () => {
		const limited = codingSession({
			phase: "failed",
			workerState: "failed",
			loginState: "ready",
			reason: "usage_limit",
		});
		const failed = event(
			1,
			"failed",
			{ summary: "The login paying for this work reached its usage limit.", usageLimit: true, code: "usage_limit" },
			"executor",
		);
		const { element, logins: listed } = mount(limited, {
			events: [failed],
			logins: {
				current: { connectionId: id(31), state: "ready" },
				logins: [{ connectionId: id(31), current: true }],
			},
		});
		await settle();
		expect(element.el.querySelector(".coding-logins p")?.textContent).toBe(
			"None of your other logins can pay for this session. Sign in with another one in Settings, AI subscriptions.",
		);
		expect(element.el.querySelectorAll(".coding-logins button")).toHaveLength(0);
		// Back from Settings (the window's focus), the offer reads the owner's logins again.
		expect(listed).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(listed).toHaveBeenCalledTimes(2);
		element.dispose?.();
		// A turn refused for its login while the session's state reads ready (its credential at admission) offers
		// them too.
		const refused = mount(
			codingSession({ phase: "failed", workerState: "failed", loginState: "ready", reason: "login_unavailable" }),
			{
				events: [event(1, "failed", { summary: "x", code: "login_unavailable" }, "executor")],
				logins: {
					current: { connectionId: id(31), state: "ready" },
					logins: [{ connectionId: id(32), current: false }],
				},
			},
		);
		await settle();
		expect(button(refused.element.el, "Use Model account 1")).toBeTruthy();
		refused.element.dispose?.();
		// Moved since the limit: nothing is offered; a session that is working is offered nothing either.
		for (const [session, events] of [
			[limited, [failed, event(2, "step", { loginChosen: true }, "member")]],
			[codingSession({ phase: "running", loginState: "removed" }), []],
		] as const) {
			const mounted = mount(session, { events: [...events], logins: { current: {}, logins: [] } });
			await settle();
			expect(mounted.element.el.querySelector(".coding-logins")).toBeNull();
			expect(mounted.logins).not.toHaveBeenCalled();
			mounted.element.dispose?.();
		}
		// The words for each login code; any other code is not a login's.
		expect(codingLoginReason("login_disabled", owner)).toBe(
			"This session's login was turned off by an owner or admin, so its turn could not run. Choose another of your logins for it, then send a message to continue.",
		);
		expect(codingLoginReason("login_needs_sign_in", other)).toBe(
			"This session's login needs a new sign-in, so its turn could not run. Only Jonas can choose another login for it.",
		);
		expect(codingLoginReason("login_not_allowed_away", owner)).toBe(
			"This session's login no longer allows work while its member is away, so its turn could not run. Allow it to work while you're away again in Settings, AI subscriptions, then choose it here, or choose another of your logins; then send a message to continue.",
		);
		expect(codingLoginReason("login_unavailable", owner)).toMatch(
			/^This session's login can't pay for work right now/,
		);
		expect(codingLoginReason("NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED", owner)).toBeUndefined();
		expect(codingLoginReason(undefined, owner)).toBeUndefined();
	});

	it("says a turn that ended without saving its work in plain words, never with the runner's text", async () => {
		const { element } = mount(codingSession({ phase: "failed", workerState: "failed" }), {
			events: [
				event(
					1,
					"failed",
					{
						summary:
							"The coding turn did not finish: Native provider bridge request failed (422) [code=CODING_TURN_ENDED_WITHOUT_SUBMISSION]; durable attempt output requires review",
					},
					"executor",
				),
				event(
					2,
					"failed",
					{ summary: "The coding turn did not finish: something nobody has seen before" },
					"executor",
				),
				event(3, "failed", { reason: "executor-lease-expired" }, "kernel"),
			],
		});
		await settle();
		const notes = [...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent);
		expect(notes).toEqual([
			"The session's last turn ended without saving its work or asking a question. The workspace is kept; a follow-up continues it.",
			"The session stopped because of an internal error. The workspace is kept; a follow-up continues it.",
			"Qorpera lost contact with this session. The workspace is kept; a follow-up starts it again.",
		]);
	});

	it("keeps a draft when the session is left and opened again", async () => {
		const first = mount(codingSession({ phase: "completed", workerState: "succeeded" }));
		await settle();
		const field = first.element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		field.value = "Half a thought";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		first.element.dispose();
		first.element.el.remove();
		const again = mount(codingSession({ phase: "completed", workerState: "succeeded" }));
		await settle();
		const kept = again.element.el.querySelector<HTMLTextAreaElement>(".coding-field-input")!;
		expect(kept.value).toBe("Half a thought");
		expect(again.element.el.querySelector<HTMLButtonElement>(".coding-send")?.disabled).toBe(false);
		kept.value = "";
		kept.dispatchEvent(new Event("input", { bubbles: true }));
	});

	it("reads a long session to its end at once, one page after another", async () => {
		const events = Array.from({ length: 230 }, (_, index) => event(index + 1, "step", { text: `Step ${index + 1}` }));
		const { element, read } = mount(codingSession({ phase: "completed", workerState: "succeeded" }), {
			events,
			page: 200,
		});
		await settle();
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(read.mock.calls.map((call) => call[1])).toEqual([0, 200]);
		// The latest steps are the ones shown; the fold holds the rest.
		expect(element.el.querySelector(".coding-row-fold")?.textContent).toBe("220 earlier steps");
		expect(element.el.querySelector(".coding-row-step:last-child")?.textContent).toBe("Step 230");
	});

	it("times a later turn's footer from that turn's first claim, never from a later one or the session's start", async () => {
		// The first turn's 200 events fill a page; the follow-up's turn was claimed 90 s ago, deferred, and claimed
		// again 30 s ago.
		const events = [
			turnEvent(1, 1, "phase", { phase: "preparing", owner: "executor" }, "2026-09-21T11:53:00Z"),
			turnEvent(2, 1, "phase", { phase: "running" }, "2026-09-21T11:53:20Z"),
			...Array.from({ length: 197 }, (_, index) =>
				turnEvent(index + 3, 1, "step", { text: `Step ${index + 1}` }, "2026-09-21T12:00:00Z", "harness"),
			),
			turnEvent(200, 2, "input", { text: "Also check the footer" }, "2026-09-22T10:02:29Z", "member"),
			turnEvent(201, 2, "phase", { phase: "preparing", owner: "executor" }, "2026-09-22T10:02:30Z"),
			turnEvent(202, 2, "phase", { phase: "preparing", owner: "executor" }, "2026-09-22T10:03:30Z"),
			turnEvent(203, 2, "phase", { phase: "running" }, "2026-09-22T10:03:40Z"),
		];
		// The first page stops before the turn's claim: the footer shows no time until the next page, read at once,
		// brings it. The stream is read from its start, so a later claim never comes before the first.
		const { element, read } = mount(codingSession(RESUMED), { events, page: 200 });
		const status = () => element.el.querySelector(".coding-status-text")?.textContent;
		await settle();
		expect(status()).toBe("Working · Workspace ready");
		await vi.advanceTimersByTimeAsync(0);
		await settle();
		expect(read.mock.calls.map((call) => call[1])).toEqual([0, 200]);
		expect(status()).toBe("Working · 1 min · Workspace ready");
	});

	it("folds only when it hides a few steps, and keeps its edge as new steps arrive", async () => {
		const few = mount(codingSession(), {
			events: Array.from({ length: 12 }, (_, index) => event(index + 1, "step", { text: `Step ${index + 1}` })),
		});
		await settle();
		expect(few.element.el.querySelector(".coding-row-fold")).toBeNull();
		few.element.dispose();
		few.element.el.remove();
		const { element, state } = mount(codingSession(), {
			events: Array.from({ length: 14 }, (_, index) => event(index + 1, "step", { text: `Step ${index + 1}` })),
		});
		await settle();
		expect(element.el.querySelector(".coding-row-fold")?.textContent).toBe("4 earlier steps");
		state.events.push(event(15, "step", { text: "Step 15" }));
		await vi.advanceTimersByTimeAsync(2_500);
		await settle();
		// The new step joins the end; the oldest shown one does not slide under the fold.
		expect(element.el.querySelector(".coding-row-fold")?.textContent).toBe("4 earlier steps");
		expect(element.el.querySelectorAll(".coding-row-step")).toHaveLength(11);
	});

	it("folds older steps into one line and opens them on request", async () => {
		const events = Array.from({ length: 14 }, (_, index) =>
			event(index + 1, "step", { text: `Step ${index + 1}` }, "executor"),
		);
		const { element } = mount(codingSession(), { events });
		await settle();
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
		const { element, read, state } = mount(codingSession());
		await settle();
		element.update(codingSession({ phase: "queued", updatedAt: "2026-09-22T09:59:30Z" }));
		expect(element.session.phase).toBe("running");
		const reads = read.mock.calls.length;
		state.session = codingSession({
			phase: "awaiting_input",
			workerState: "blocked",
			updatedAt: "2026-09-22T10:05:00Z",
		});
		element.update(state.session);
		expect(element.session.phase).toBe("awaiting_input");
		// A new phase from the listing reads the stream at once, not at the next poll.
		await settle();
		expect(read).toHaveBeenCalledTimes(reads + 1);
		expect(element.el.querySelector(".coding-status-text")?.textContent).toBe(
			"Needs you · your answer is recorded in this thread",
		);
	});
});

describe("the sessions' pill above the composer", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});
	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is one session's line: the agent's figure wearing the harness mark, its title, status and Open", () => {
		const motion = stubFigureMotion();
		const open = vi.fn();
		const pill = new CodingPill(open);
		document.body.append(pill.el);
		pill.update(
			[codingSession({ harness: "codex" })],
			() => staff,
			() => owner,
		);
		expect(pill.el.hidden).toBe(false);
		expect(pill.el.querySelector(".coding-pill")?.classList.contains("is-single")).toBe(true);
		// One session has no rows: the summary is its line.
		expect(pill.el.querySelector(".coding-pill-rows")?.childElementCount).toBe(0);
		const summary = pill.el.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		expect(summary.querySelectorAll(".coding-pill-face")).toHaveLength(1);
		expect(summary.querySelector(".coding-pill-face .figure")).not.toBeNull();
		expect(summary.querySelector(".coding-pill-face .coding-badge-codex")).not.toBeNull();
		// The line names the session; the badge carries no title of its own over it.
		expect(summary.querySelector(".coding-badge")?.hasAttribute("title")).toBe(false);
		expect(summary.querySelector(".coding-pill-label")?.textContent).toBe("Fix the delay after send");
		expect(summary.querySelector(".coding-pill-note")?.textContent).toBe(
			"Working · 4 min · running vitest in packages/web · 3 files changed",
		);
		expect(summary.querySelector<HTMLElement>(".coding-pill-note")?.dataset.tone).toBe("working");
		expect(summary.querySelector(".coding-pill-action")?.textContent).toBe("Open");
		expect(summary.dataset.workerId).toBe(WORKER);
		expect(summary.hasAttribute("aria-expanded")).toBe(false);
		expect(summary.getAttribute("aria-label")).toBe(
			"Fix the delay after send · Working · 4 min · running vitest in packages/web · 3 files changed. Open the session",
		);
		expect(motion).toHaveBeenCalledTimes(1);
		expect(motion.mock.calls[0]?.[4]).toMatchObject({ activity: "Working" });
		// A new listing with the same motion keeps the figure (and its motion) as it is.
		pill.update(
			[codingSession({ harness: "codex", lastStep: "npm test", updatedAt: "2026-09-22T10:03:30Z" })],
			() => staff,
			() => owner,
		);
		expect(motion).toHaveBeenCalledTimes(1);
		expect(summary.querySelector(".coding-pill-note")?.textContent).toContain("npm test");
		// A question makes it wait, as an agent waits on the member, and the line asks for the answer.
		pill.update(
			[codingSession({ harness: "codex", phase: "awaiting_input" })],
			() => staff,
			() => owner,
		);
		expect(motion).toHaveBeenCalledTimes(2);
		expect(motion.mock.calls[1]?.[4]).toMatchObject({ activity: "Waiting" });
		expect(summary.querySelector<HTMLElement>(".coding-pill-note")?.dataset.tone).toBe("attention");
		expect(summary.querySelector(".coding-pill-action")?.textContent).toBe("Answer");
		// A click opens the session; it never unfolds.
		summary.click();
		expect(open).toHaveBeenCalledWith(WORKER, summary);
		expect(pill.el.querySelector<HTMLElement>(".coding-pill")?.dataset.open).not.toBe("true");
		// With none going the pill hides.
		pill.update(
			[],
			() => staff,
			() => owner,
		);
		expect(pill.el.hidden).toBe(true);
	});

	it("gathers several sessions under a count, unfolds them into lines and opens each one", () => {
		stubFigureMotion();
		const open = vi.fn();
		const pill = new CodingPill(open);
		document.body.append(pill.el);
		const second = codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:01:00Z" });
		pill.update(
			[codingSession(), second],
			() => staff,
			() => owner,
		);
		const box = pill.el.querySelector<HTMLElement>(".coding-pill")!;
		expect(box.classList.contains("is-single")).toBe(false);
		const summary = pill.el.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		expect(summary.querySelectorAll(".coding-pill-faces .coding-pill-face")).toHaveLength(2);
		expect(summary.querySelector(".coding-pill-label")?.textContent).toBe("2 coding agents");
		expect(summary.querySelector(".coding-pill-note")?.textContent).toBe("Working");
		expect(summary.querySelector(".coding-pill-action")?.textContent).toBe("");
		expect(summary.dataset.workerId).toBeUndefined();
		expect(summary.getAttribute("aria-label")).toBe("2 coding agents · Working");
		// The lines, oldest first, each with its figure, title, status and Open.
		const rows = [...pill.el.querySelectorAll<HTMLButtonElement>(".coding-pill-rows > .coding-pill-row")];
		expect(rows.map((row) => row.dataset.workerId)).toEqual([WORKER, id(902)]);
		expect(rows[0]?.querySelector(".coding-pill-face .coding-badge-claude-code")).not.toBeNull();
		expect(rows[0]?.querySelector(".coding-pill-title")?.textContent).toBe("Fix the delay after send");
		expect(rows[0]?.querySelector(".coding-pill-status")?.textContent).toContain("running vitest");
		expect(rows[0]?.querySelector(".coding-pill-action")?.textContent).toBe("Open");
		expect(rows[1]?.getAttribute("aria-label")).toMatch(/^Second · Working.*\. Open the session$/);
		// The summary unfolds them; Escape folds them and gives focus back to it.
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		summary.click();
		expect(box.dataset.open).toBe("true");
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		rows[1]!.focus();
		rows[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(box.dataset.open).toBe("false");
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(summary);
		// Focus leaving the pill folds it too.
		summary.click();
		expect(box.dataset.open).toBe("true");
		summary.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
		expect(box.dataset.open).toBe("false");
		rows[1]!.click();
		expect(open).toHaveBeenCalledWith(id(902), rows[1]);
		// Who needs an answer is counted on the summary, and the waiting line asks for it.
		const asked = (session: CodingSession) => ({ ...session, phase: "awaiting_input" as const });
		pill.update(
			[asked(codingSession()), second],
			() => staff,
			() => owner,
		);
		expect(summary.querySelector(".coding-pill-note")?.textContent).toBe("1 needs you");
		expect(summary.querySelector<HTMLElement>(".coding-pill-note")?.dataset.tone).toBe("attention");
		expect(rows[0]?.dataset.tone).toBe("attention");
		expect(rows[0]?.querySelector(".coding-pill-action")?.textContent).toBe("Answer");
		pill.update(
			[asked(codingSession()), asked(second)],
			() => staff,
			() => owner,
		);
		expect(summary.querySelector(".coding-pill-note")?.textContent).toBe("2 need you");
		// Down to one, the summary is that session's line again.
		pill.update(
			[second],
			() => staff,
			() => owner,
		);
		expect(pill.el.querySelector(".coding-pill-rows")?.childElementCount).toBe(0);
		expect(summary.querySelector(".coding-pill-label")?.textContent).toBe("Second");
		expect(summary.hasAttribute("aria-expanded")).toBe(false);
		expect(summary.dataset.workerId).toBe(id(902));
	});

	it("folds on the member's word: Escape or the open summary, until the pointer and focus have both left", () => {
		stubFigureMotion();
		const pill = new CodingPill(vi.fn());
		document.body.append(pill.el);
		const second = codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:01:00Z" });
		pill.update(
			[codingSession(), second],
			() => staff,
			() => owner,
		);
		const box = pill.el.querySelector<HTMLElement>(".coding-pill")!;
		const summary = box.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		const pressEscape = (target: HTMLElement) => {
			const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event;
		};
		// The open summary folds it, and stays folded under the pointer and focus.
		summary.click();
		expect(box.dataset.open).toBe("true");
		summary.click();
		expect(box.dataset.open).toBe("false");
		expect(box.dataset.folded).toBe("true");
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		// A click unfolds it again.
		summary.click();
		expect(box.dataset.open).toBe("true");
		expect(box.dataset.folded).toBeUndefined();
		// Escape from a line folds it onto the summary; a second Escape is not the pill's and goes on.
		const row = box.querySelector<HTMLButtonElement>(".coding-pill-row")!;
		row.focus();
		expect(pressEscape(row).defaultPrevented).toBe(true);
		expect(box.dataset.open).toBe("false");
		expect(box.dataset.folded).toBe("true");
		expect(document.activeElement).toBe(summary);
		expect(pressEscape(summary).defaultPrevented).toBe(false);
		// The pointer leaving while focus is still inside keeps the fold; focus leaving (not hovered) ends it.
		box.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
		expect(box.dataset.folded).toBe("true");
		summary.blur();
		expect(box.dataset.folded).toBeUndefined();
		// Unfolded by focus alone (no click), Escape still folds it.
		summary.focus();
		expect(pressEscape(summary).defaultPrevented).toBe(true);
		expect(box.dataset.folded).toBe("true");
		expect(box.dataset.open).toBe("false");
		// Folded by a click with focus elsewhere: a touch leaving keeps it, the mouse leaving ends it.
		summary.blur();
		summary.click();
		summary.click();
		expect(box.dataset.folded).toBe("true");
		box.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "touch" }));
		expect(box.dataset.folded).toBe("true");
		box.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
		expect(box.dataset.folded).toBeUndefined();
		// One session folds the same way, and never opens.
		pill.update(
			[second],
			() => staff,
			() => owner,
		);
		summary.focus();
		expect(pressEscape(summary).defaultPrevented).toBe(true);
		expect(box.dataset.folded).toBe("true");
		expect(box.dataset.open).toBe("false");
		expect(summary.hasAttribute("aria-expanded")).toBe(false);
		expect(document.activeElement).toBe(summary);
		expect(pressEscape(summary).defaultPrevented).toBe(false);
		summary.blur();
		expect(box.dataset.folded).toBeUndefined();
	});

	it("folds a hovered pill on Escape from the composer, and keeps folded lines out of reach", () => {
		stubFigureMotion();
		const lifetime = new AbortController();
		const pill = new CodingPill(vi.fn(), lifetime.signal);
		const composer = document.createElement("textarea");
		document.body.append(composer, pill.el);
		const second = codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:01:00Z" });
		pill.update(
			[codingSession(), second],
			() => staff,
			() => owner,
		);
		const box = pill.el.querySelector<HTMLElement>(".coding-pill")!;
		const rows = box.querySelector<HTMLElement>(".coding-pill-rows")!;
		const summary = box.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		// jsdom matches no :hover; the pointer rests on the pill.
		let hovered = true;
		const matches = box.matches.bind(box);
		vi.spyOn(box, "matches").mockImplementation((selector: string) =>
			selector === ":hover" ? hovered : matches(selector),
		);
		const pressEscape = (target: HTMLElement) => {
			const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			target.dispatchEvent(event);
			return event;
		};
		composer.focus();
		expect(rows.inert).toBeFalsy();
		expect(pressEscape(composer).defaultPrevented).toBe(true);
		expect(box.dataset.folded).toBe("true");
		// Focus stays in the composer; the folded lines can't be reached (Shift+Tab from the summary skips them).
		expect(document.activeElement).toBe(composer);
		expect(rows.inert).toBe(true);
		// Already folded, the next Escape is the composer's own.
		expect(pressEscape(composer).defaultPrevented).toBe(false);
		// The pointer leaving ends the fold and the lines come back.
		hovered = false;
		box.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
		expect(box.dataset.folded).toBeUndefined();
		expect(rows.inert).toBe(false);
		// Not under the pointer, Escape in the composer leaves the pill alone; an Escape handled on the way too.
		expect(pressEscape(composer).defaultPrevented).toBe(false);
		hovered = true;
		composer.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
		pressEscape(composer);
		expect(box.dataset.folded).toBeUndefined();
		// Escape from the summary folds the lines out of reach too, until a click opens them.
		summary.focus();
		pressEscape(summary);
		expect(rows.inert).toBe(true);
		summary.click();
		expect(box.dataset.open).toBe("true");
		expect(rows.inert).toBe(false);
		// The conversation's end takes the document listener with it.
		summary.click();
		hovered = false;
		box.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
		summary.blur();
		lifetime.abort();
		hovered = true;
		composer.focus();
		expect(pressEscape(composer).defaultPrevented).toBe(false);
	});

	it("scrolls past five lines and keeps every session in them", () => {
		stubFigureMotion();
		const style = document.createElement("style");
		style.textContent = conversationCss.replace(/^@import .*;$/gm, "");
		document.head.append(style);
		try {
			const rules = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
			const rows = rules.find((rule) => rule.selectorText === ".coding-pill-rows")?.style;
			expect(rows?.getPropertyValue("max-height")).toMatch(/calc\(5 \* 36px\)|180px/);
			expect(rows?.getPropertyValue("overflow-y")).toBe("auto");
		} finally {
			style.remove();
		}
		const pill = new CodingPill(vi.fn());
		document.body.append(pill.el);
		const sessions = Array.from({ length: 7 }, (_, n) =>
			codingSession({ workerId: id(910 + n), title: `Session ${n + 1}`, createdAt: `2026-09-22T10:0${n}:00Z` }),
		);
		pill.update(
			sessions,
			() => staff,
			() => owner,
		);
		const lines = [...pill.el.querySelectorAll<HTMLElement>(".coding-pill-rows > .coding-pill-row")];
		expect(lines.map((line) => line.dataset.workerId)).toEqual(sessions.map((item) => item.workerId));
		expect(pill.el.querySelector(".coding-pill-label")?.textContent).toBe("7 coding agents");
		// The summary stays outside the scrolling lines.
		expect(pill.el.querySelector(".coding-pill-rows .coding-pill-summary")).toBeNull();
	});

	it("leaves a later turn's time out, rather than show the session's age; a first turn keeps its own", () => {
		stubFigureMotion();
		const pill = new CodingPill(vi.fn());
		document.body.append(pill.el);
		// The listing has no turn start, only the session's.
		pill.update(
			[codingSession(RESUMED)],
			() => staff,
			() => owner,
		);
		const note = () => pill.el.querySelector(".coding-pill-note")?.textContent;
		expect(note()).toBe("Working · Workspace ready");
		pill.update(
			[codingSession()],
			() => staff,
			() => owner,
		);
		expect(note()).toBe("Working · 4 min · running vitest in packages/web · 3 files changed");
	});

	it("asks only the session's owner: another member's question reads as theirs, quietly, with Open", () => {
		stubFigureMotion();
		const pill = new CodingPill(vi.fn());
		document.body.append(pill.el);
		const theirs = codingSession({ phase: "awaiting_input", workerState: "blocked", isOwner: false });
		pill.update(
			[theirs],
			() => staff,
			() => other,
		);
		const summary = pill.el.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		const note = summary.querySelector<HTMLElement>(".coding-pill-note")!;
		expect(note.textContent).toBe(codingSessionStatus(theirs, other).text);
		expect(note.textContent).toMatch(/^Needs Jonas · paused /);
		expect(note.dataset.tone).toBe("idle");
		expect(summary.querySelector(".coding-pill-action")?.textContent).toBe("Open");
		// Among several, theirs is not counted and its line opens quietly; the member's own still asks.
		const mine = codingSession({
			workerId: id(902),
			title: "Mine",
			phase: "awaiting_input",
			workerState: "blocked",
			createdAt: "2026-09-22T10:01:00Z",
		});
		const names = (session: CodingSession) => (session.workerId === WORKER ? other : owner);
		pill.update([theirs, codingSession({ workerId: id(903), title: "Running" })], () => staff, names);
		expect(note.textContent).toBe("Working");
		expect(note.dataset.tone).toBe("working");
		const [their] = pill.el.querySelectorAll<HTMLElement>(".coding-pill-row");
		expect(their?.dataset.tone).toBe("idle");
		expect(their?.querySelector(".coding-pill-status")?.textContent).toMatch(/^Needs Jonas · paused /);
		expect(their?.querySelector(".coding-pill-action")?.textContent).toBe("Open");
		pill.update([theirs, mine], () => staff, names);
		expect(note.textContent).toBe("1 needs you");
		expect(note.dataset.tone).toBe("attention");
		const [, own] = pill.el.querySelectorAll<HTMLElement>(".coding-pill-row");
		expect(own?.dataset.tone).toBe("attention");
		expect(own?.querySelector(".coding-pill-action")?.textContent).toBe("Answer");
		expect(their?.querySelector(".coding-pill-action")?.textContent).toBe("Open");
	});
});
