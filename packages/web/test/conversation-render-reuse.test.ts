// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { TranscriptItem, TranscriptMessage } from "../src/cloud/transcript.ts";
import { fmtTime } from "../src/ui/dom.ts";
import { ReceivedAttachments } from "../src/ui/received-attachments.ts";
import { fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

/* A redraw of the thread keeps the element of every item whose content is the same:
 * a new message adds one node to the live log instead of rebuilding the transcript. */

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime("2026-09-05T12:00:00Z");
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
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

function setup(items: TranscriptItem[], previewAttachment?: () => Promise<Blob>) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const store = company.conversation(session.sessionId, false);
	store.set({ loading: false, complete: true, projection: { items, hiddenCount: 0, lastSequence: items.length } });
	const view = new ConversationView(company, session.sessionId, previewAttachment ? { previewAttachment } : {});
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const log = view.el.querySelector<HTMLElement>('[role="log"]')!;
	const show = async (next: TranscriptItem[]) => {
		store.set({ projection: { items: next, hiddenCount: 0, lastSequence: next.length } });
		await settle();
	};
	const element = (itemId: string) => log.querySelector<HTMLElement>(`[data-message-id="${itemId}"]`);
	const order = () =>
		[...log.querySelectorAll<HTMLElement>("[data-message-id]")].map((node) => node.dataset.messageId);
	/** Every node the log gains or loses while `change` runs. */
	const mutations = async (change: () => Promise<void>) => {
		const added: Node[] = [];
		const removed: Node[] = [];
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				added.push(...record.addedNodes);
				removed.push(...record.removedNodes);
			}
		});
		observer.observe(log, { childList: true, subtree: true, characterData: true, attributes: true });
		await change();
		for (const record of observer.takeRecords()) {
			added.push(...record.addedNodes);
			removed.push(...record.removedNodes);
		}
		observer.disconnect();
		return { added, removed };
	};
	return { company, store, view, log, show, element, order, mutations };
}

describe("thread redraws keep unchanged messages", () => {
	it("keeps every unchanged message's element when a message arrives", async () => {
		const items = [message(1), message(2), message(3)];
		const thread = setup(items);
		const before = items.map((item) => thread.element(item.id));
		expect(before.every(Boolean)).toBe(true);
		await thread.show([...items, message(4)]);
		expect(items.map((item) => thread.element(item.id))).toEqual(before);
		for (const [index, item] of items.entries()) expect(thread.element(item.id)).toBe(before[index]);
		expect(thread.element(message(4).id)?.textContent).toContain("Question 4");
		expect(thread.order()).toEqual([1, 2, 3, 4].map((n) => message(n).id));
	});

	it("gives the live log only the new message, and nothing on a redraw that changes nothing", async () => {
		const items = [message(1), message(2), message(3)];
		const thread = setup(items);
		const next = [...items, message(4)];
		const arrival = await thread.mutations(() => thread.show(next));
		expect(arrival.removed).toEqual([]);
		expect(arrival.added).toEqual([thread.element(message(4).id)]);
		// A fresh read of the same transcript (new objects, same content) leaves the log alone.
		const again = await thread.mutations(() => thread.show(next.map((item) => ({ ...item }))));
		expect(again).toEqual({ added: [], removed: [] });
		// So does a company change that does not touch the thread.
		const unrelated = await thread.mutations(async () => {
			thread.company.store.set({ here: [] });
			await settle();
		});
		expect(unrelated).toEqual({ added: [], removed: [] });
	});

	it("draws a message anew when what it shows changes: waiting to failed, and edited text", async () => {
		const waiting = message(2, { pending: "queued", sequence: Number.MAX_SAFE_INTEGER });
		const items = [message(1), waiting, message(3)];
		const thread = setup(items);
		const first = thread.element(message(1).id);
		const third = thread.element(message(3).id);
		const queued = thread.element(waiting.id)!;
		expect(queued.textContent).toContain("Queued");
		const failed = { ...waiting, pending: "failed" as const, failureReason: "The agent is paused" };
		const change = await thread.mutations(() => thread.show([message(1), failed, message(3)]));
		const redrawn = thread.element(waiting.id)!;
		expect(redrawn).not.toBe(queued);
		expect(redrawn.classList.contains("pending-failed")).toBe(true);
		expect(redrawn.textContent).toContain("Failed · The agent is paused");
		expect(change.removed).toEqual([queued]);
		expect(change.added).toEqual([redrawn]);
		expect(thread.element(message(1).id)).toBe(first);
		expect(thread.element(message(3).id)).toBe(third);
		// The agent rewrites its message in place (same id): only that message is drawn again.
		await thread.show([message(1), failed, message(3, { text: "Answer **3**, revised" })]);
		expect(thread.element(message(3).id)).not.toBe(third);
		expect(thread.element(message(3).id)?.textContent).toContain("Answer 3, revised");
		expect(thread.element(message(1).id)).toBe(first);
		expect(thread.element(waiting.id)).toBe(redrawn);
	});

	it("replaces the member's own waiting message with the sent one and keeps the rest", async () => {
		const items = [message(1), message(2)];
		const thread = setup(items);
		const kept = items.map((item) => thread.element(item.id));
		thread.store.set({
			optimistic: [{ clientInputId: id(700), text: "Sent from here", createdAt: at(3), authorUserId: userA.id }],
		});
		await settle();
		const optimistic = thread.element(id(700))!;
		expect(optimistic.classList.contains("pending-queued")).toBe(true);
		const sent = message(3, { kind: "member", authorUserId: userA.id, text: "Sent from here" });
		const change = await thread.mutations(async () => {
			thread.store.set({ optimistic: [], projection: { items: [...items, sent], hiddenCount: 0, lastSequence: 3 } });
			await settle();
		});
		expect(thread.element(id(700))).toBeNull();
		expect(change.removed).toEqual([optimistic]);
		expect(change.added).toEqual([thread.element(sent.id)]);
		expect(items.map((item) => thread.element(item.id))).toEqual(kept);
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

	it("keeps a day separator with its message, and adds one only where a new message needs it", async () => {
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
		expect(now[1]?.nextElementSibling).toBe(thread.element(later.id));
		expect(change.removed).toEqual([]);
		expect(change.added).toEqual([thread.element(later.id), now[1]]);
	});

	it("keeps received files through new messages, and disposes them when their message goes", async () => {
		const disposed = vi.spyOn(ReceivedAttachments.prototype, "dispose");
		const withFile = message(2, {
			attachmentCount: 1,
			attachments: [{ kind: "file", name: "Offer.pdf", mediaType: "application/pdf", bytes: 10 }],
		});
		const thread = setup([message(1), withFile], async () => new Blob(["x"], { type: "application/pdf" }));
		const files = thread.element(withFile.id)!.querySelector(".received-attachments");
		expect(files?.textContent).toContain("Offer.pdf");
		await thread.show([message(1), withFile, message(3)]);
		expect(thread.element(withFile.id)!.querySelector(".received-attachments")).toBe(files);
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
		const card: TranscriptItem = {
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
		};
		const thread = setup([message(1), card]);
		const shown = thread.log.querySelector<HTMLElement>(`[data-interaction-id="${id(600)}"]`)!;
		const field = shown.querySelector<HTMLInputElement>("input.interaction-field")!;
		field.focus();
		field.value = "#design";
		await thread.show([message(1), card, message(3)]);
		expect(thread.log.querySelector(`[data-interaction-id="${id(600)}"]`)).toBe(shown);
		expect(field.value).toBe("#design");
		expect(document.activeElement).toBe(field);
	});

	it("draws times again once the day has changed", async () => {
		const items = [message(1), message(2)];
		const thread = setup(items);
		const first = thread.element(message(1).id)!;
		expect(first.getAttribute("aria-label")).toBe(`Fixture agent · ${fmtTime(message(1).createdAt)}`);
		const label = first.getAttribute("aria-label");
		vi.setSystemTime("2026-09-06T12:00:00Z");
		await thread.show([...items, message(3)]);
		const redrawn = thread.element(message(1).id)!;
		expect(redrawn.getAttribute("aria-label")).toBe(`Fixture agent · ${fmtTime(message(1).createdAt)}`);
		expect(redrawn.getAttribute("aria-label")).not.toBe(label);
	});
});
