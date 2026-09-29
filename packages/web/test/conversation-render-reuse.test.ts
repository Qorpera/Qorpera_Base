// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { TranscriptItem, TranscriptMessage } from "../src/cloud/transcript.ts";
import type { HostedProfileMember, HostedSessionEvent } from "../src/cloud/types.ts";
import { conversationTimestampLabel } from "../src/ui/conversation-timestamps.ts";
import { fmtTime } from "../src/ui/dom.ts";
import { ReceivedAttachments } from "../src/ui/received-attachments.ts";
import { event, fixture, id, profileA, session, settle, staff, team, userA, userB } from "./fixtures.ts";

/* A redraw of the thread keeps the element of every item whose content is the same, and brings
 * a changed message up to date in place: the live log reads each message once, when it first
 * appears, instead of the whole transcript on every change. */

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime("2026-09-05T12:00:00Z");
	// Days and times in one zone, whatever the machine's: "today" and "yesterday" below are UTC's.
	localStorage.setItem("qorpera.web.time-zone", "UTC");
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	// jsdom has no native dialog methods.
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

/** One minute apart, so only the first message carries a day separator. */
const at = (minute: number) => new Date(Date.parse("2026-09-05T10:00:00Z") + minute * 60_000).toISOString();
function message(n: number, patch: Partial<TranscriptMessage> = {}): TranscriptMessage {
	return {
		kind: n % 2 ? "agent" : "member",
		id: id(500 + n),
		sequence: n,
		...(n % 2 ? {} : { authorUserId: userA.id }),
		text: n % 2 ? `Answer **${n}**` : `Question ${n}`,
		attachmentCount: 0,
		createdAt: at(n),
		...patch,
	};
}
const members = (nameB: string): HostedProfileMember[] => [
	{ userId: userA.id, email: "a@example.invalid", displayName: "Alice", role: "owner", joinedAt: at(0) },
	{ userId: userB.id, email: "b@example.invalid", displayName: nameB, role: "contributor", joinedAt: at(0) },
];
const question = (patch: Partial<TranscriptItem> = {}): TranscriptItem =>
	({
		kind: "interaction",
		id: id(600),
		sequence: 2,
		actorUserId: userA.id,
		request: {
			surface: "question",
			title: "Which channel should the digest go to?",
			payload: { options: [{ label: "#general", value: "general" }], allowCustom: true },
		},
		createdAt: at(2),
		...patch,
	}) as TranscriptItem;

function setup(
	items: TranscriptItem[],
	options: { agentThread?: boolean; previewAttachment?: (id: string) => Promise<Blob> } = {},
) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team: { ...team, members: members("Bob") },
		staff: [staff, { ...staff, id: id(88), displayName: "Coworker" }],
		sessions: [
			options.agentThread
				? { ...session, staffAgentId: staff.id, executionScope: { roomId: id(77), agentThread: true } }
				: { ...session, staffAgentId: staff.id },
		],
		loading: false,
		mentionsReady: true,
	});
	const store = company.conversation(session.sessionId, false);
	store.set({ loading: false, complete: true, projection: { items, hiddenCount: 0, lastSequence: items.length } });
	const view = new ConversationView(
		company,
		session.sessionId,
		options.previewAttachment ? { previewAttachment: options.previewAttachment } : {},
	);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const log = view.el.querySelector<HTMLElement>('[role="log"]')!;
	const show = async (next: TranscriptItem[], patch: { events?: HostedSessionEvent[] } = {}) => {
		store.set({ ...patch, projection: { items: next, hiddenCount: 0, lastSequence: next.length } });
		await settle();
	};
	const element = (itemId: string) => log.querySelector<HTMLElement>(`[data-message-id="${itemId}"]`);
	const card = (itemId: string) => log.querySelector<HTMLElement>(`[data-interaction-id="${itemId}"]`);
	// The whole thread, in order: a message older than the first one shown stands above the live log.
	const order = () =>
		[...view.el.querySelectorAll<HTMLElement>(".messages [data-message-id]")].map((node) => node.dataset.messageId);
	/** What the live log gains and loses while `change` runs: `added` and `removed` are its own
	 * children (messages, cards, separators); `heard` is the text of anything added deeper. */
	const mutations = async (change: () => Promise<void>) => {
		const added: Node[] = [];
		const removed: Node[] = [];
		const heard: string[] = [];
		const take = (records: MutationRecord[]) => {
			for (const record of records) {
				if (record.target === log) {
					added.push(...record.addedNodes);
					removed.push(...record.removedNodes);
				} else for (const node of record.addedNodes) heard.push(node.textContent ?? "");
				if (record.type === "characterData") heard.push(record.target.textContent ?? "");
			}
		};
		const observer = new MutationObserver(take);
		observer.observe(log, { childList: true, subtree: true, characterData: true });
		await change();
		take(observer.takeRecords());
		observer.disconnect();
		return { added, removed, heard };
	};
	return { company, store, view, log, show, element, card, order, mutations };
}

describe("thread redraws keep unchanged messages", () => {
	it("keeps every unchanged message's element when a message arrives", async () => {
		const items = [message(1), message(2), message(3)];
		const thread = setup(items);
		const before = items.map((item) => thread.element(item.id));
		expect(before.every(Boolean)).toBe(true);
		await thread.show([...items, message(4)]);
		for (const [index, item] of items.entries()) expect(thread.element(item.id)).toBe(before[index]);
		expect(thread.element(message(4).id)?.textContent).toContain("Question 4");
		expect(thread.order()).toEqual([1, 2, 3, 4].map((n) => message(n).id));
	});

	it("gives the live log only the new message, and nothing on a redraw that changes nothing", async () => {
		const items = [message(1), message(2), message(3)];
		const thread = setup(items);
		const next = [...items, message(4)];
		const arrival = await thread.mutations(() => thread.show(next));
		expect(arrival).toEqual({ added: [thread.element(message(4).id)], removed: [], heard: [] });
		// A fresh read of the same transcript (new objects, same content) leaves the log alone.
		const again = await thread.mutations(() => thread.show(next.map((item) => ({ ...item }))));
		expect(again).toEqual({ added: [], removed: [], heard: [] });
		// So does a company change that does not touch the thread.
		const unrelated = await thread.mutations(async () => {
			thread.company.store.set({ here: [] });
			await settle();
		});
		expect(unrelated).toEqual({ added: [], removed: [], heard: [] });
	});

	it("brings a changed message up to date in place: waiting to failed, and edited text", async () => {
		const waiting = message(2, { pending: "queued", sequence: Number.MAX_SAFE_INTEGER });
		const items = [message(1), waiting, message(3)];
		const thread = setup(items);
		const first = thread.element(message(1).id);
		const third = thread.element(message(3).id)!;
		const queued = thread.element(waiting.id)!;
		expect(queued.textContent).toContain("Queued");
		const failed = { ...waiting, pending: "failed" as const, failureReason: "The agent is paused" };
		const change = await thread.mutations(() => thread.show([message(1), failed, message(3)]));
		// The same element: the log hears the new caption, not the message again.
		expect(thread.element(waiting.id)).toBe(queued);
		expect(queued.classList.contains("pending-failed")).toBe(true);
		expect(queued.querySelector(".message-caption")?.textContent).toBe("Failed · The agent is paused");
		expect(change.added).toEqual([]);
		expect(change.removed).toEqual([]);
		expect(change.heard.join(" ")).toBe("Failed · The agent is paused");
		// The agent rewrites its message (same id): only its text is drawn again.
		const edit = await thread.mutations(() =>
			thread.show([message(1), failed, message(3, { text: "Answer **3**, revised" })]),
		);
		expect(thread.element(message(3).id)).toBe(third);
		expect(third.textContent).toContain("Answer 3, revised");
		expect(edit.added).toEqual([]);
		expect(edit.heard.join(" ")).toContain("Answer 3, revised");
		expect(thread.element(message(1).id)).toBe(first);
	});

	it("reads the member's own message once as it goes from sent to waiting to taken to the transcript", async () => {
		const thread = setup([message(1)]);
		const change = await thread.mutations(async () => {
			const own = { clientInputId: id(700), text: "Hello there", createdAt: at(3), authorUserId: userA.id };
			thread.store.set({ optimistic: [own] });
			await settle();
			// The cloud took it: its input id is known, then the listing brings the waiting input.
			thread.store.set({ optimistic: [{ ...own, inputId: id(701) }] });
			await settle();
			const waiting = message(2, {
				id: id(701),
				sequence: Number.MAX_SAFE_INTEGER,
				text: "Hello there",
				createdAt: at(3),
				pending: "queued",
			});
			thread.store.set({ optimistic: [] });
			await thread.show([message(1), waiting]);
			await thread.show([message(1), { ...waiting, pending: "processing" }]);
			// The transcript's message for an input carries the input's id.
			await thread.show([message(1), message(2, { id: id(701), text: "Hello there", createdAt: at(3) })]);
		});
		const own = thread.element(id(701))!;
		expect(change.added).toEqual([own]);
		expect(change.removed).toEqual([]);
		expect(change.heard).toEqual(["Processing"]);
		expect(own.className).toBe("message from-member mine");
		expect(own.querySelector(".message-caption")).toBeNull();
		expect(thread.order()).toEqual([message(1).id, id(701)]);
	});

	it("follows a message to the transcript's id when its event names the input, files included", async () => {
		const asked: string[] = [];
		const thread = setup([message(1)], {
			previewAttachment: async (messageId) => {
				asked.push(messageId);
				return new Blob(["x"], { type: "image/png" });
			},
		});
		const file = { kind: "image" as const, name: "Photo.png", mediaType: "image/png", bytes: 10 };
		const waiting = message(2, {
			id: id(701),
			sequence: Number.MAX_SAFE_INTEGER,
			pending: "queued",
			attachmentCount: 1,
			attachments: [file],
		});
		await thread.show([message(1), waiting]);
		const shown = thread.element(id(701))!;
		const files = shown.querySelector(".received-attachments");
		const sent = message(2, { id: id(702), attachmentCount: 1, attachments: [file] });
		const change = await thread.mutations(() =>
			thread.show([message(1), sent], { events: [{ ...event(2), eventId: id(702), sessionInputId: id(701) }] }),
		);
		expect(thread.element(id(702))).toBe(shown);
		expect(shown.querySelector(".received-attachments")).toBe(files);
		expect(change.added).toEqual([]);
		shown.querySelector<HTMLButtonElement>(".received-file")!.click();
		await settle();
		expect(asked).toEqual([id(702)]);
	});

	it("keeps the order right when messages come in before, between and after the ones shown", async () => {
		const items = [message(2), message(4), message(6)];
		const thread = setup(items);
		const kept = items.map((item) => thread.element(item.id));
		const next = [message(1), message(2), message(3), message(4), message(5), message(6), message(7)];
		await thread.show(next);
		expect(thread.order()).toEqual(next.map((item) => item.id));
		expect(items.map((item) => thread.element(item.id))).toEqual(kept);
		// One leaves, the rest stay in place.
		await thread.show(next.filter((item) => item.id !== message(4).id));
		expect(thread.order()).toEqual(next.filter((item) => item.id !== message(4).id).map((item) => item.id));
		expect(thread.element(message(2).id)).toBe(kept[0]);
		expect(thread.element(message(6).id)).toBe(kept[2]);
	});

	it("keeps each day separator with its item, and a new one joins the log just before its message", async () => {
		const items = [message(1), message(2)];
		const thread = setup(items);
		const separators = () => [...thread.log.querySelectorAll("time.conversation-timestamp")];
		const first = separators();
		expect(first).toHaveLength(1);
		expect(first[0]?.nextElementSibling).toBe(thread.element(message(1).id));
		// Ten minutes later: the new message gets its own separator; the old one stays as it was.
		const later = message(3, { createdAt: at(12) });
		const change = await thread.mutations(() => thread.show([...items, later]));
		const now = separators();
		expect(now).toHaveLength(2);
		expect(now[0]).toBe(first[0]);
		expect(change).toEqual({ added: [now[1], thread.element(later.id)], removed: [], heard: [] });
		expect(now[1]?.textContent).toBe(conversationTimestampLabel(new Date(at(12))));
		expect(now[1]?.textContent).toMatch(/^Today /);
		// A card drawn anew (its question answered) keeps the separator it stood under.
		const card = question({ createdAt: at(30) });
		await thread.show([...items, later, card]);
		const cardSeparator = thread.card(id(600))!.previousElementSibling;
		expect(cardSeparator?.matches("time.conversation-timestamp")).toBe(true);
		thread.store.set({
			interactionAnswers: {
				[id(600)]: {
					outcome: "answered",
					answer: { values: ["general"] },
					answeredBy: userA.id,
					answeredAt: at(31),
					pending: true,
				},
			},
		});
		await settle();
		expect(thread.card(id(600))!.previousElementSibling).toBe(cardSeparator);
	});

	it("reads an answered card again only when it changes from question to answer", async () => {
		const thread = setup([message(1), question()]);
		const waiting = thread.card(id(600))!;
		const answer = {
			outcome: "answered" as const,
			answer: { values: ["general"] },
			answeredBy: userA.id,
			answeredAt: at(3),
		};
		const answering = await thread.mutations(async () => {
			thread.store.set({ interactionAnswers: { [id(600)]: { ...answer, pending: true } } });
			await settle();
		});
		const answered = thread.card(id(600))!;
		expect(answered).not.toBe(waiting);
		expect(answering.added).toEqual([answered]);
		expect(answered.textContent).toContain("Sending");
		// Its input id arrives, then the transcript's answer: the same card, only the words that changed.
		const settling = await thread.mutations(async () => {
			thread.store.set({ interactionAnswers: { [id(600)]: { ...answer, pending: true, inputId: id(610) } } });
			await settle();
			thread.store.set({ interactionAnswers: undefined });
			await thread.show([message(1), question({ answer: { ...answer, answeredAt: at(4) } })]);
		});
		expect(thread.card(id(600))).toBe(answered);
		expect(answered.textContent).not.toContain("Sending");
		expect(answered.querySelector(".interaction-attribution")?.textContent).toBe(`You · ${fmtTime(at(4))}`);
		expect(settling.added).toEqual([]);
		expect(settling.removed).toEqual([]);
	});

	it("keeps received files and an open preview through new messages and its own changes", async () => {
		const disposed = vi.spyOn(ReceivedAttachments.prototype, "dispose");
		const withFile = message(2, {
			attachmentCount: 1,
			attachments: [{ kind: "image", name: "Photo.png", mediaType: "image/png", bytes: 10 }],
		});
		const thread = setup([message(1), withFile], {
			previewAttachment: async () => new Blob(["x"], { type: "image/png" }),
		});
		const files = thread.element(withFile.id)!.querySelector(".received-attachments");
		expect(files?.textContent).toContain("Photo.png");
		thread.element(withFile.id)!.querySelector<HTMLButtonElement>(".received-file")!.click();
		await settle();
		expect(document.querySelector<HTMLDialogElement>(".file-preview-dialog")?.open).toBe(true);
		await thread.show([message(1), withFile, message(3)]);
		await thread.show([message(1), { ...withFile, pending: "failed" }, message(3)]);
		expect(thread.element(withFile.id)!.querySelector(".received-attachments")).toBe(files);
		expect(document.querySelector<HTMLDialogElement>(".file-preview-dialog")?.open).toBe(true);
		expect(disposed).not.toHaveBeenCalled();
		await thread.show([message(1), message(3)]);
		expect(disposed).toHaveBeenCalledOnce();
		// The view's own end lets the rest go.
		await thread.show([message(1), withFile, message(3)]);
		dispose?.();
		dispose = undefined;
		expect(disposed).toHaveBeenCalledTimes(2);
	});

	it("keeps a card the member is answering, with what they typed and the keyboard, through a new message", async () => {
		const thread = setup([message(1), question()]);
		const shown = thread.card(id(600))!;
		const field = shown.querySelector<HTMLInputElement>("input.interaction-field")!;
		field.focus();
		field.value = "#design";
		await thread.show([message(1), question(), message(3)]);
		expect(thread.card(id(600))).toBe(shown);
		expect(field.value).toBe("#design");
		expect(document.activeElement).toBe(field);
	});

	it("after midnight keeps every item and reads only the times that now name a day", async () => {
		const old = message(1, { createdAt: "2026-09-01T10:00:00Z" });
		const thread = setup([old, question(), message(3)]);
		const kept = [thread.element(old.id)!, thread.card(id(600))!, thread.element(message(3).id)!];
		const oldLabel = kept[0]!.getAttribute("aria-label");
		const field = kept[1]!.querySelector<HTMLInputElement>("input.interaction-field")!;
		field.focus();
		field.value = "#design";
		vi.setSystemTime("2026-09-06T00:05:00Z");
		const change = await thread.mutations(async () => {
			thread.company.store.set({ here: [] });
			await settle();
		});
		expect(change.added).toEqual([]);
		expect(change.removed).toEqual([]);
		expect([thread.element(old.id), thread.card(id(600)), thread.element(message(3).id)]).toEqual(kept);
		// Older days read as they did; yesterday's messages and cards now name their day.
		expect(kept[0]!.getAttribute("aria-label")).toBe(oldLabel);
		expect(kept[2]!.getAttribute("aria-label")).toBe(`Fixture agent · ${fmtTime(at(3))}`);
		expect(kept[2]!.getAttribute("aria-label")).toContain("Sep 5");
		expect(kept[1]!.querySelector(".interaction-from")?.textContent).toBe(`Fixture agent · ${fmtTime(at(2))}`);
		expect(field.value).toBe("#design");
		expect(document.activeElement).toBe(field);
	});

	it("an answered card that replaced itself stands in the log once", async () => {
		const thread = setup([message(1), question()]);
		vi.spyOn(thread.company, "answerInteraction").mockResolvedValue(undefined);
		thread.card(id(600))!.querySelector<HTMLButtonElement>(".interaction-options button")!.click();
		await settle();
		expect(thread.log.querySelectorAll(`[data-interaction-id="${id(600)}"]`)).toHaveLength(1);
		await thread.show([message(1), question(), message(3)]);
		expect(thread.log.querySelectorAll(`[data-interaction-id="${id(600)}"]`)).toHaveLength(1);
	});

	it("draws each copy of a repeated id, and one leaving keeps the other", async () => {
		const repeated = message(1);
		const thread = setup([repeated, { ...repeated }, message(2)]);
		expect(thread.log.querySelectorAll(`[data-message-id="${repeated.id}"]`)).toHaveLength(2);
		await thread.show([repeated, message(2)]);
		expect(thread.log.querySelectorAll(`[data-message-id="${repeated.id}"]`)).toHaveLength(1);
	});
});

describe("kept items follow names", () => {
	it("a member's new name reaches the author of a kept message", async () => {
		const fromB = message(2, { authorUserId: userB.id });
		const thread = setup([message(1), fromB]);
		expect(thread.element(fromB.id)!.querySelector(".message-author")?.textContent).toBe("Bob");
		thread.company.store.set({ team: { ...team, members: members("Robert") } });
		await settle();
		expect(thread.element(fromB.id)!.querySelector(".message-author")?.textContent).toBe("Robert");
	});

	it("a renamed member is no longer set apart under the old name", async () => {
		const withMention = message(2, { text: "Hi @Bob, look" });
		const thread = setup([message(1), withMention], { agentThread: true });
		expect(thread.element(withMention.id)!.querySelector(".mention")?.textContent).toBe("@Bob");
		thread.company.store.set({ team: { ...team, members: members("Bobby") } });
		await settle();
		expect(thread.element(withMention.id)!.querySelector(".mention")).toBeNull();
	});

	it("a coworker's new name reaches its chip, and the agent's the agent's messages", async () => {
		const link: TranscriptItem = {
			kind: "peer_link",
			id: id(640),
			sequence: 2,
			direction: "out",
			counterpartStaffId: id(88),
			pairSessionId: id(641),
			createdAt: at(2),
		};
		const thread = setup([message(1), link]);
		expect(thread.element(link.id)!.textContent).toContain("Coworker");
		thread.company.store.set({
			staff: [
				{ ...staff, displayName: "Nova" },
				{ ...staff, id: id(88), displayName: "Renamed coworker" },
			],
		});
		await settle();
		expect(thread.element(link.id)!.textContent).toContain("Renamed coworker");
		expect(thread.element(message(1).id)!.getAttribute("aria-label")).toContain("Nova");
	});
});
