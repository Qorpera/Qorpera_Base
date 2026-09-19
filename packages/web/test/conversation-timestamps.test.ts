// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { TranscriptItem, TranscriptMessage } from "../src/cloud/transcript.ts";
import {
	conversationTimestampLabel,
	needsConversationTimestamp,
	parseConversationTimestamp,
} from "../src/ui/conversation-timestamps.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, staff, team, userA } from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 20, 12));
	localStorage.clear();
	setLanguagePreference("en");
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	localStorage.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function message(sequence: number, createdAt: string): TranscriptMessage {
	return {
		kind: "member",
		id: id(100 + sequence),
		sequence,
		authorUserId: userA.id,
		text: `Message ${sequence}`,
		attachmentCount: 0,
		createdAt,
	};
}

function setup(items: TranscriptItem[]) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const state = company.conversation(session.sessionId);
	state.set({ projection: { items, hiddenCount: 0, lastSequence: items.length }, loading: false });
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { company, state, view };
}

describe("conversation timestamp grouping", () => {
	it("starts the transcript and separates a five-minute pause, but keeps consecutive replies together", () => {
		const first = new Date(2026, 8, 20, 10);
		expect(needsConversationTimestamp(first)).toBe(true);
		expect(needsConversationTimestamp(new Date(2026, 8, 20, 10, 4, 59), first)).toBe(false);
		expect(needsConversationTimestamp(new Date(2026, 8, 20, 10, 5), first)).toBe(true);
		expect(needsConversationTimestamp(first, first)).toBe(false);
		expect(needsConversationTimestamp(new Date(2026, 8, 20, 9, 50), first)).toBe(false);
	});

	it("separates local calendar days even when messages are only a minute apart", () => {
		expect(needsConversationTimestamp(new Date(2026, 8, 21, 0, 0), new Date(2026, 8, 20, 23, 59))).toBe(true);
		expect(needsConversationTimestamp(new Date(2027, 0, 1), new Date(2026, 11, 31, 23, 59))).toBe(true);
	});

	it("parses timestamp offsets as instants and rejects unavailable dates", () => {
		expect(parseConversationTimestamp("2026-09-20T12:00:00+02:00")?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
		for (const value of ["", "not-a-date", "2026-99-20T10:00:00Z"]) {
			expect(parseConversationTimestamp(value)).toBeUndefined();
		}
	});
});

describe("conversation timestamp labels", () => {
	it("shows today and yesterday in local time, including month and year boundaries", () => {
		const now = new Date(2027, 0, 1, 12);
		expect(conversationTimestampLabel(new Date(2027, 0, 1, 10, 15), now)).toMatch(/Today.*10:15/);
		expect(conversationTimestampLabel(new Date(2026, 11, 31, 10, 15), now)).toMatch(/Yesterday.*10:15/);
		expect(conversationTimestampLabel(new Date(2026, 8, 30, 10, 15), new Date(2026, 9, 1, 12))).toMatch(/Yesterday/);
	});

	it("uses calendar yesterday across daylight-saving changes", () => {
		// These dates exercise the US and European spring clock changes when the
		// suite runs in those zones; the elapsed duration need not be 24 hours.
		for (const [month, day] of [
			[2, 8],
			[2, 29],
			[9, 25],
			[10, 1],
		] as const) {
			const now = new Date(2026, month, day + 1, 0, 30);
			const previousDay = new Date(2026, month, day, 0, 15);
			expect(conversationTimestampLabel(previousDay, now)).toContain("Yesterday");
		}
	});

	it("includes a calendar date for older and future messages and a year when needed", () => {
		const older = conversationTimestampLabel(new Date(2026, 8, 17, 10, 15));
		expect(older).toContain("Thu");
		expect(older).toContain("Sep");
		expect(older).toContain("17");
		expect(older).not.toContain("2026");
		expect(conversationTimestampLabel(new Date(2025, 8, 17, 10, 15))).toContain("2025");
		expect(conversationTimestampLabel(new Date(2026, 8, 21, 10, 15))).not.toMatch(/Today|Yesterday/);
	});

	it("follows the selected presentation language", () => {
		setLanguagePreference("da");
		expect(conversationTimestampLabel(new Date(2026, 8, 20, 16, 15))).toMatch(/I dag.*16[.:]15/);
		expect(conversationTimestampLabel(new Date(2026, 8, 19, 16, 15))).toMatch(/I går.*16[.:]15/);
	});
});

describe("conversation timestamp rendering", () => {
	it("groups visible messages and authorization cards without changing transcript order", () => {
		const dates = [10, 12, 17, 18].map((minute) => new Date(2026, 8, 20, 10, minute).toISOString());
		const items: TranscriptItem[] = [
			message(1, dates[0]!),
			{ ...message(2, dates[1]!), kind: "agent", text: "First paragraph.\n\nSecond paragraph." },
			{
				kind: "authorization_request",
				id: id(200),
				sequence: 3,
				actorUserId: userA.id,
				body: { title: "Approve the change" },
				createdAt: dates[2]!,
			},
			message(4, dates[3]!),
		];
		const f = setup(items);
		const times = [...f.view.el.querySelectorAll<HTMLTimeElement>(".messages > time")];
		expect(times.map((time) => new Date(time.dateTime).toISOString())).toEqual([dates[0], dates[2]]);
		expect(times[1]?.nextElementSibling?.classList.contains("auth-card")).toBe(true);
		expect(f.view.el.querySelectorAll(".message")).toHaveLength(3);
		expect(f.view.el.querySelectorAll(".from-agent .bubble")).toHaveLength(2);
		expect(f.state.get().projection.items).toBe(items);
	});

	it("skips invalid dates and uses an optimistic message's original sending time", () => {
		const createdAt = new Date(2026, 8, 20, 10).toISOString();
		const f = setup([message(1, "invalid")]);
		f.state.set({
			optimistic: [{ clientInputId: id(201), authorUserId: userA.id, text: "Sending", createdAt }],
		});
		f.view.update();
		const times = f.view.el.querySelectorAll<HTMLTimeElement>(".messages > time");
		expect(times).toHaveLength(1);
		expect(new Date(times[0]!.dateTime).toISOString()).toBe(createdAt);
		expect(times[0]?.nextElementSibling?.getAttribute("data-message-id")).toBe(id(201));
		expect(f.view.el.textContent).not.toContain("Invalid Date");
	});

	it("refreshes at midnight without replacing message nodes or changing scroll position", () => {
		vi.setSystemTime(new Date(2026, 8, 20, 23, 59, 30));
		const f = setup([message(1, new Date(2026, 8, 20, 23, 58).toISOString())]);
		const time = f.view.el.querySelector<HTMLTimeElement>(".messages > time")!;
		const article = f.view.el.querySelector("article.message");
		const messages = f.view.el.querySelector<HTMLElement>(".messages")!;
		messages.scrollTop = 120;
		expect(time.textContent).toContain("Today");
		vi.advanceTimersByTime(60_000);
		expect(time.textContent).toContain("Yesterday");
		expect(f.view.el.querySelector(".messages > time")).toBe(time);
		expect(f.view.el.querySelector("article.message")).toBe(article);
		expect(messages.scrollTop).toBe(120);
	});

	it("refreshes on return to the tab and language changes, then stops on disposal", () => {
		const f = setup([message(1, new Date(2026, 8, 20, 10).toISOString())]);
		const time = f.view.el.querySelector<HTMLTimeElement>(".messages > time")!;
		vi.setSystemTime(new Date(2026, 8, 21, 12));
		window.dispatchEvent(new Event("focus"));
		expect(time.textContent).toContain("Yesterday");
		setLanguagePreference("da");
		expect(time.textContent).toContain("I går");
		vi.setSystemTime(new Date(2026, 8, 22, 12));
		document.dispatchEvent(new Event("visibilitychange"));
		expect(time.textContent).not.toContain("I går");
		const beforeDisposal = time.textContent;
		f.view.dispose();
		vi.setSystemTime(new Date(2026, 8, 20, 12));
		vi.advanceTimersByTime(60_000);
		window.dispatchEvent(new Event("focus"));
		setLanguagePreference("en");
		expect(time.textContent).toBe(beforeDisposal);
	});

	it.each(["focus", "visibilitychange", "minute"])(
		"reconciles day separators after a time-zone change on %s without replacing transcript content",
		(trigger) => {
			vi.stubEnv("TZ", "UTC");
			vi.setSystemTime(new Date("2026-09-20T23:00:00Z"));
			const f = setup([
				{ ...message(1, "2026-09-20T21:59:00Z"), attachmentCount: 1 },
				{
					kind: "authorization_request",
					id: id(200),
					sequence: 2,
					actorUserId: userA.id,
					body: { title: "Approve the change" },
					createdAt: "2026-09-20T22:01:00Z",
				},
				message(3, "2026-09-20T22:02:00Z"),
			]);
			const transcript = f.view.el.querySelector<HTMLElement>(".messages")!;
			const originalRows = [...transcript.querySelectorAll(".message, .auth-card")];
			const attachment = transcript.querySelector(".received-attachments");
			const firstTime = transcript.querySelector<HTMLTimeElement>("time")!;
			expect(transcript.querySelectorAll(":scope > time")).toHaveLength(1);
			expect(firstTime.textContent).toMatch(/Today.*9:59/);
			for (const zone of ["Europe/Copenhagen", "UTC"]) {
				vi.stubEnv("TZ", zone);
				if (trigger === "minute") vi.advanceTimersByTime(60_000);
				else if (trigger === "focus") window.dispatchEvent(new Event("focus"));
				else document.dispatchEvent(new Event("visibilitychange"));
				const times = [...transcript.querySelectorAll<HTMLTimeElement>(":scope > time")];
				expect(times).toHaveLength(zone === "UTC" ? 1 : 2);
				expect(times[0]).toBe(firstTime);
				expect(times[0]?.textContent).toMatch(zone === "UTC" ? /Today.*9:59/ : /Yesterday.*11:59/);
				if (zone !== "UTC") {
					expect(times[1]?.textContent).toMatch(/Today.*12:01/);
					expect(times[1]?.dateTime).toBe("2026-09-20T22:01:00.000Z");
					expect(times[1]?.nextElementSibling).toBe(originalRows[1]);
				}
				const currentRows = [...transcript.querySelectorAll(".message, .auth-card")];
				expect(currentRows).toHaveLength(originalRows.length);
				currentRows.forEach((row, index) => {
					expect(row).toBe(originalRows[index]);
				});
				expect(transcript.querySelector(".received-attachments")).toBe(attachment);
			}
		},
	);

	it.each([false, true])("preserves the reading position after a time-zone change (at bottom: %s)", (atBottom) => {
		vi.stubEnv("TZ", "UTC");
		vi.setSystemTime(new Date("2026-09-20T23:00:00Z"));
		const f = setup(
			Array.from({ length: 10 }, (_, index) =>
				message(index + 1, new Date(Date.parse("2026-09-20T21:58:00Z") + index * 60_000).toISOString()),
			),
		);
		const transcript = f.view.el.querySelector<HTMLElement>(".messages")!;
		const rows = [...transcript.querySelectorAll<HTMLElement>(".message")];
		Object.defineProperties(transcript, {
			clientHeight: { value: 200 },
			scrollHeight: {
				get: () => rows.length * 100 + transcript.querySelectorAll(":scope > time").length * 20,
			},
		});
		vi.spyOn(transcript, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 400, 200));
		for (const row of rows) {
			const offset = () => {
				let top = 0;
				for (const sibling of transcript.children) {
					if (sibling === row) break;
					top += sibling.tagName === "TIME" ? 20 : 100;
				}
				return top;
			};
			Object.defineProperty(row, "offsetTop", { get: offset });
			vi.spyOn(row, "getBoundingClientRect").mockImplementation(
				() => new DOMRect(0, offset() - transcript.scrollTop, 400, 100),
			);
		}
		// Emulate the browser's scrollTop clamp as jsdom does not implement layout.
		let scrollTop = 0;
		Object.defineProperty(transcript, "scrollTop", {
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = Math.max(0, Math.min(value, transcript.scrollHeight - transcript.clientHeight));
			},
		});
		transcript.scrollTop = atBottom ? transcript.scrollHeight - transcript.clientHeight : 350;
		transcript.dispatchEvent(new Event("scroll"));
		const anchorTop = rows[3]!.getBoundingClientRect().top;
		for (const zone of ["Europe/Copenhagen", "UTC"]) {
			vi.stubEnv("TZ", zone);
			window.dispatchEvent(new Event("focus"));
			expect(transcript.querySelectorAll(":scope > time")).toHaveLength(zone === "UTC" ? 1 : 2);
			if (atBottom) expect(transcript.scrollTop).toBe(transcript.scrollHeight - transcript.clientHeight);
			else expect(rows[3]!.getBoundingClientRect().top).toBe(anchorTop);
		}
	});
});
