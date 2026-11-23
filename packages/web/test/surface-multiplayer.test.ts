// @vitest-environment jsdom
import type { SurfaceSession } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLocalSandboxCache } from "../src/app/surfaces-store.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import {
	COMPANY,
	fakeClient,
	MESSAGE_IDS,
	SESSION,
	SURFACE,
	session,
	sessionMessage,
	storeWith,
	workspace,
} from "./surface-fixtures.ts";

const JONAS = "77777777-7777-4777-8777-777777777701";
const SOFIE = "77777777-7777-4777-8777-777777777702";
const NAMES: Record<string, string> = { [JONAS]: "Jonas", [SOFIE]: "Sofie Lund" };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	clearLocalSandboxCache();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function opened(
	shown: SurfaceSession,
	overrides: Parameters<typeof fakeClient>[0] = {},
	alone = false,
	extra: Parameters<typeof storeWith>[1] = {},
) {
	const client = fakeClient({ getSurfaceWorkspace: vi.fn(async () => workspace([shown])), ...overrides });
	const store = storeWith(client, {
		memberName: (userId) => NAMES[userId],
		teammates: () => (alone ? [] : [{ userId: SOFIE, name: "Sofie Lund" }]),
		...extra,
	});
	await store.load();
	await store.openSurface("website");
	const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
	document.body.append(view.el);
	await flush();
	store.openDrawer(SURFACE, SESSION);
	view.update();
	const drawer = view.el.querySelector<HTMLElement>(".surface-drawer")!;
	return { client, store, view, drawer };
}

describe("two people in one interface session", () => {
	it("puts the face of the member whose turn runs on the session's figure, only while it works or asks", async () => {
		const running = session([], { state: "running", createdByUserId: JONAS, turnRequestedByUserId: SOFIE });
		const { store, view, drawer } = await opened(running);
		const face = drawer.querySelector<HTMLElement>(".surface-drawer-head .surface-crew > .surface-crew-turn")!;
		expect(face.textContent).toBe("SL");
		expect(face.title).toBe("Sofie's turn");
		expect(view.el.querySelector(".surface-bar-agent .surface-crew-turn")?.textContent).toBe("SL");
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		rail.update("website");
		expect(rail.el.querySelector(".rail-surface-crew .surface-crew-turn")?.textContent).toBe("SL");

		expect(store.turnHolder({ ...running, state: "needs_input" })?.userId).toBe(SOFIE);
		expect(store.turnHolder({ ...running, state: "ready" })).toBeUndefined();
		expect(store.turnHolder({ ...running, turnRequestedByUserId: null })).toBeUndefined();
		view.dispose();
		store.dispose();

		const alone = await opened(running, {}, true);
		expect(alone.drawer.querySelector(".surface-crew-turn")).toBeNull();
		alone.view.dispose();
		alone.store.dispose();
	});

	it("shows each member's face by their messages, a note as a quiet note to its teammate, and lets anyone answer", async () => {
		const asked = session([], {
			state: "needs_input",
			turnRequestedByUserId: JONAS,
			question: { text: "Round the yearly plan too?", options: ["Whole kroner", "Keep two decimals"] },
			messages: [
				sessionMessage(MESSAGE_IDS[0]!, "member", "Make the prices whole kroner.", { authorUserId: JONAS }),
				sessionMessage(MESSAGE_IDS[1]!, "note", "@Jonas does the price look right?", {
					authorUserId: SOFIE,
					noteTo: [JONAS],
				}),
			],
		});
		const replySurfaceSession = vi.fn(async () =>
			session([], {
				...asked,
				state: "queued",
				question: null,
				turnRequestedByUserId: SOFIE,
				messages: [
					...asked.messages,
					sessionMessage(MESSAGE_IDS[2]!, "member", "Whole kroner", { authorUserId: SOFIE }),
				],
			}),
		);
		const { store, view, drawer } = await opened(asked, { replySurfaceSession });
		const groups = [...drawer.querySelectorAll<HTMLElement>(".surface-message-group.is-member")];
		expect(groups.map((group) => group.querySelector(".surface-message-face")?.textContent)).toEqual(["J", "SL"]);
		const note = groups[1]!.querySelector<HTMLElement>(".surface-message.is-note")!;
		expect(note.title).toContain("Note to Jonas");
		expect(note.querySelector(".surface-note-to .person-avatar")?.textContent).toBe("J");

		drawer.querySelector<HTMLButtonElement>('[data-act="answer"][data-answer="Whole kroner"]')!.click();
		await flush();
		view.update();
		expect(replySurfaceSession).toHaveBeenCalledWith(SESSION, "Whole kroner");
		const answer = [...drawer.querySelectorAll<HTMLElement>(".surface-message-group.is-member")].at(-1)!;
		expect(answer.querySelector(".surface-message-author")?.textContent).toBe("Sofie Lund");
		expect(answer.querySelector(".surface-message-face")?.textContent).toBe("SL");
		view.dispose();
		store.dispose();
	});

	it("turns a message that starts with a teammate into a note, picked from the '@' list, and never a reply", async () => {
		const ready = session([], { turnRequestedByUserId: JONAS });
		const noteSurfaceSession = vi.fn(async (_id: string, text: string, to: readonly string[]) =>
			session([], {
				...ready,
				messages: [sessionMessage(MESSAGE_IDS[0]!, "note", text, { authorUserId: JONAS, noteTo: [...to] })],
			}),
		);
		const replySurfaceSession = vi.fn();
		const { store, view, drawer } = await opened(ready, { noteSurfaceSession, replySurfaceSession });
		const input = drawer.querySelector<HTMLInputElement>(".surface-drawer-input")!;
		input.focus();
		input.value = "@so";
		input.setSelectionRange(3, 3);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const picker = drawer.querySelector<HTMLElement>(".mention-picker")!;
		expect(picker.hidden).toBe(false);
		expect(picker.querySelector(".mention-name")?.textContent).toBe("Sofie Lund");
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(input.value).toBe("@Sofie Lund ");
		expect(picker.hidden).toBe(true);

		input.value = "@Sofie Lund is this right?";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(drawer.querySelector(".surface-drawer-foot")?.classList.contains("is-note")).toBe(true);
		expect(drawer.querySelector<HTMLElement>(".surface-attach")?.hidden).toBe(true);
		drawer.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await flush();
		expect(noteSurfaceSession).toHaveBeenCalledWith(SESSION, "@Sofie Lund is this right?", [SOFIE]);
		expect(replySurfaceSession).not.toHaveBeenCalled();
		view.update();
		expect(drawer.querySelector(".surface-message.is-note")?.textContent).toContain("@Sofie Lund is this right?");
		view.dispose();
		store.dispose();
	});

	it("sends a message with images as a reply even when it starts with a teammate, since notes carry no images", async () => {
		const ready = session([], { turnRequestedByUserId: JONAS });
		const image = { sha256: "a".repeat(64), bytes: 5, mediaType: "image/png" };
		const noteSurfaceSession = vi.fn();
		const replySurfaceSession = vi.fn(async () => ready);
		const { store, view, drawer } = await opened(
			ready,
			{
				noteSurfaceSession,
				replySurfaceSession,
				surfaceSessionImages: vi.fn(async () => ({ sessionId: SESSION, messages: [] })),
			},
			false,
			{ uploadImage: vi.fn(async () => image) },
		);
		const input = drawer.querySelector<HTMLInputElement>(".surface-drawer-input")!;
		input.value = "@Sofie Lund is this right?";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const attach = drawer.querySelector<HTMLElement>(".surface-attach")!;
		expect(attach.hidden).toBe(true);
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { files: [new File(["image"], "shot.png", { type: "image/png" })] },
		});
		drawer.querySelector("form")!.dispatchEvent(paste);
		await flush();
		expect(attach.hidden).toBe(false);
		expect(drawer.querySelector(".surface-drawer-foot")?.classList.contains("is-note")).toBe(false);
		drawer.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await flush();
		await flush();
		expect(noteSurfaceSession).not.toHaveBeenCalled();
		expect(replySurfaceSession).toHaveBeenCalledWith(SESSION, "@Sofie Lund is this right?", true, {
			clientInputId: expect.any(String),
			images: [image],
		});
		view.dispose();
		store.dispose();
	});

	it("shows the member whose login is full the usage card, and everyone else their face in amber", async () => {
		const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
		const waiting = session([], {
			state: "queued",
			createdByUserId: JONAS,
			turnRequestedByUserId: SOFIE,
			messages: [
				sessionMessage(MESSAGE_IDS[0]!, "member", "Can the prices be bold on mobile too?", { authorUserId: SOFIE }),
			],
			waitingOnUsage: { userId: SOFIE, until, continueWith: null },
		});
		const jonas = await opened(waiting, {}, false, { selfUserId: JONAS });
		const face = jonas.drawer.querySelector<HTMLElement>(".surface-drawer-head .surface-crew > .surface-crew-turn")!;
		expect(face.textContent).toBe("SL");
		expect(face.classList.contains("is-waiting")).toBe(true);
		expect(face.title).toBe("Waiting for Sofie's usage to reset");
		expect(jonas.view.el.querySelector(".surface-bar-agent .surface-crew-turn.is-waiting")).not.toBeNull();
		const rail = new SurfaceRail(jonas.store, COMPANY, new AbortController().signal);
		rail.update("website");
		expect(rail.el.querySelector(".rail-surface-crew .surface-crew-turn.is-waiting")?.textContent).toBe("SL");
		expect(jonas.drawer.querySelector(".surface-message-group.is-waiting .surface-message-face")?.textContent).toBe(
			"SL",
		);
		expect(jonas.drawer.querySelector<HTMLElement>(".surface-drawer-usage")!.hidden).toBe(true);
		expect(jonas.drawer.querySelector(".usage-wall")).toBeNull();
		expect(jonas.drawer.querySelector(".surface-drawer-working")).toBeNull();
		jonas.view.dispose();
		jonas.store.dispose();

		const sofie = await opened(waiting, {}, false, { selfUserId: SOFIE });
		const card = sofie.drawer.querySelector<HTMLElement>(".surface-drawer-usage .usage-wall")!;
		expect(card.querySelector(".usage-wall-title")?.textContent).toMatch(/^Out of usage until /);
		expect(card.querySelector(".usage-wall-sub")?.textContent).toBe("Your turn goes on by itself when it resets.");
		expect(card.querySelector("button")).toBeNull();
		sofie.view.dispose();
		sofie.store.dispose();

		const continued = { ...waiting, waitingOnUsage: null };
		const continueSurfaceSession = vi.fn(async () => continued);
		const other = await opened(
			{ ...waiting, waitingOnUsage: { userId: SOFIE, until: null, continueWith: { account: "sofie@lund.dk" } } },
			{ continueSurfaceSession },
			false,
			{ selfUserId: SOFIE },
		);
		const wall = other.drawer.querySelector<HTMLElement>(".surface-drawer-usage .usage-wall")!;
		expect(wall.querySelector(".usage-wall-title")?.textContent).toBe("Out of usage");
		expect(wall.querySelector(".usage-wall-sub")?.textContent).toBe("Keep going with sofie@lund.dk");
		wall.querySelector<HTMLButtonElement>("button")!.click();
		await flush();
		other.view.update();
		expect(continueSurfaceSession).toHaveBeenCalledWith(SESSION);
		expect(other.drawer.querySelector<HTMLElement>(".surface-drawer-usage")!.hidden).toBe(true);
		expect(other.drawer.querySelector(".surface-crew-turn.is-waiting")).toBeNull();
		other.view.dispose();
		other.store.dispose();
	});

	it("marks the interface and the session for the teammate a note names until they open it", async () => {
		const markSurfaceNotesSeen = vi.fn(async () => undefined);
		const client = fakeClient({
			unseenSurfaceNotes: vi.fn(async () => [{ surfaceId: SURFACE, sessionId: SESSION, count: 1 }]),
			markSurfaceNotesSeen,
		});
		const store = storeWith(client, { memberName: (userId) => NAMES[userId], teammates: () => [] });
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		rail.update(undefined);
		expect(
			rail.el.querySelector('.rail-surface[data-surface-slug="website"] .surface-tile > .rail-mention'),
		).not.toBeNull();
		expect(rail.el.querySelector(".rail-surface .visually-hidden")?.textContent).toContain(
			"A teammate left you a note",
		);

		await store.openSurface("website");
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();
		expect(view.el.querySelector(".surface-bar-agent .surface-bar-agent-count.is-note")?.textContent).toBe("@");
		store.openDrawer(SURFACE, SESSION);
		view.update();
		expect(markSurfaceNotesSeen).toHaveBeenCalledWith(SESSION);
		expect(store.unseenNotesOn(SURFACE)).toBe(0);
		rail.update("website");
		expect(rail.el.querySelector(".rail-mention")).toBeNull();
		view.dispose();
		store.dispose();
	});
});
