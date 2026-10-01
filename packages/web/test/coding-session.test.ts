// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodingSession,
	type CodingSessionEvent,
	type CodingSessionRead,
	codingSessionGoing,
	codingSessionTakesInput,
	compareCodingSessions,
	parseCodingSession,
	parseCodingSessionRead,
	parseCodingSessions,
} from "../src/cloud/coding-session.ts";
import {
	CodingSessionElement,
	type CodingSessionNames,
	CodingSessionSlot,
	codingSessionActivity,
	codingSessionLine,
	codingSessionStandby,
	codingSessionStatus,
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

const owner: CodingSessionNames = { agent: "Mark", owner: "you", ownerIsViewer: true };
const other: CodingSessionNames = { agent: "Mark", owner: "Jonas", ownerIsViewer: false };
const NOW = Date.parse("2026-09-22T10:04:00Z");

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
		const names = options.viewer === "other" ? other : owner;
		const element = new CodingSessionElement(session, {
			names: () => names,
			viewerOwns: () => options.viewer !== "other",
			api: { read, answer, delegate, archive },
			signal: disposeAll.signal,
			askAgent: options.askAgent,
		});
		document.body.append(element.el);
		return { element, read, answer, delegate, archive, state };
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
			],
		});
		await settle();
		const notes = [...element.el.querySelectorAll(".coding-note")].map((note) => note.textContent);
		expect(notes).toEqual([
			"The machine went to sleep · 1 command stopped",
			"Mark archived the session",
			"Reopened",
			"The session lost its machine · 35 commands stopped",
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

describe("the session in the header", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW });
	});
	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("is the agent's figure wearing the harness mark, on its own clock, and unfolds the title", () => {
		const motion = stubFigureMotion();
		const open = vi.fn();
		const slot = new CodingSessionSlot(WORKER, open);
		document.body.append(slot.el);
		slot.update(codingSession({ harness: "codex" }), staff, owner);
		expect(slot.el.querySelector(".coding-slot-avatar .figure")).not.toBeNull();
		expect(slot.el.querySelector(".coding-slot-avatar .coding-badge-codex")).not.toBeNull();
		// The button names the session; the badge carries no title of its own over it.
		expect(slot.el.querySelector(".coding-badge")?.hasAttribute("title")).toBe(false);
		expect(slot.el.querySelector(".coding-slot-name")?.textContent).toBe("Fix the delay after send");
		expect(slot.el.title).toBe(
			"Fix the delay after send · Working · 4 min · running vitest in packages/web · 3 files changed",
		);
		expect(slot.el.getAttribute("aria-label")).toBe(
			"Fix the delay after send · Working · 4 min · running vitest in packages/web · 3 files changed. Open the session",
		);
		expect(motion).toHaveBeenCalledTimes(1);
		expect(motion.mock.calls[0]?.[4]).toMatchObject({ activity: "Working", identity: `coding:${WORKER}` });
		// A new listing with the same motion keeps the figure (and its motion) as it is.
		slot.update(
			codingSession({ harness: "codex", lastStep: "npm test", updatedAt: "2026-09-22T10:03:30Z" }),
			staff,
			owner,
		);
		expect(motion).toHaveBeenCalledTimes(1);
		// A question makes it wait, as an agent waits on the member.
		slot.update(codingSession({ harness: "codex", phase: "awaiting_input" }), staff, owner);
		expect(motion).toHaveBeenCalledTimes(2);
		expect(motion.mock.calls[1]?.[4]).toMatchObject({ activity: "Waiting" });
		expect(slot.el.dataset.tone).toBe("attention");
		slot.el.click();
		expect(open).toHaveBeenCalledWith(slot.el);
	});
});
