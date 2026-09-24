// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { CompanyController } from "../src/app/company.ts";
import { parseRoute } from "../src/app/router.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { TranscriptMessage } from "../src/cloud/transcript.ts";
import appCss from "../src/styles/app.css?raw";
import conversationCss from "../src/styles/conversation.css?raw";
import tokensCss from "../src/styles/tokens.css?raw";
import { AttachmentTray } from "../src/ui/attachments.ts";
import { fmtTime } from "../src/ui/dom.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
	// jsdom does not implement the native dialog methods; focus containment is
	// verified in Chromium separately.
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
		this.querySelector<HTMLButtonElement>("button")?.focus();
	};
	HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
	URL.createObjectURL = vi.fn(() => "blob:fixture-local-image");
	URL.revokeObjectURL = vi.fn();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
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
function setup(actions: WorkspaceActions = {}) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const view = new ConversationView(company, session.sessionId, actions);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, view };
}
/** A conversation whose messages are already loaded, built before it is placed
 * in the page, with the message pane's scroll metrics under the test's control
 * (jsdom lays nothing out). */
function loadedView() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	const reply: TranscriptMessage = {
		kind: "agent",
		id: id(83),
		sequence: 1,
		text: "Latest answer",
		attachmentCount: 0,
		phase: "final",
		createdAt: timestamp,
		authorUserId: userA.id,
	};
	company
		.conversation(session.sessionId)
		.set({ loading: false, projection: { items: [reply], hiddenCount: 0, lastSequence: 1 } });
	const view = new ConversationView(company, session.sessionId);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const messages = view.el.querySelector<HTMLElement>(".messages")!;
	expect(messages.textContent).toContain("Latest answer");
	const metrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 400 };
	// Like a browser: a write past the end lands at the end.
	Object.defineProperty(messages, "scrollTop", {
		configurable: true,
		get: () => metrics.scrollTop,
		set: (value: number) => {
			metrics.scrollTop = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight));
		},
	});
	Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
	Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
	return { view, messages, metrics };
}
function button(root: ParentNode, label: string): HTMLButtonElement {
	const result = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.getAttribute("aria-label") === label || item.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}
function input(root: ParentNode, label: string, value: string): void {
	const field = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}
function attach(root: ParentNode, files: File[]): void {
	const field = root.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(field, "files", { configurable: true, value: files });
	field.dispatchEvent(new Event("change"));
}

describe("conversation UI boundaries", () => {
	it("uses recorded room speaker names and never substitutes the current staff or sponsor", () => {
		const f = setup();
		f.company.store.set({ sessions: [{ ...session, executionScope: { roomId: id(79) } }] });
		const agent: TranscriptMessage = {
			kind: "agent",
			id: id(80),
			sequence: 1,
			text: "Result",
			attachmentCount: 0,
			phase: "final",
			createdAt: timestamp,
			authorUserId: userA.id,
			staffSpeaker: { runId: id(81), staffAgentId: id(82), staffVersion: 1, displayName: "Historical Bob" },
		};
		const state = f.company.conversation(session.sessionId);
		for (const [speaker, name] of [
			[agent.staffSpeaker, "Historical Bob"],
			[{ runId: id(81), staffAgentId: id(82), staffVersion: 1 }, `Agent ${id(82)}`],
			[undefined, "Agent reply · speaker unavailable"],
		] as const) {
			state.set({ projection: { items: [{ ...agent, staffSpeaker: speaker }], hiddenCount: 0, lastSequence: 1 } });
			f.view.update();
			expect(f.view.el.querySelector(".message-author")?.textContent).toBe(name);
			expect(f.view.el.querySelector(".message")?.getAttribute("aria-label")).toContain(name);
		}
	});
	it("groups agent bubbles within one message while retaining authors, timestamps and delivery state", () => {
		const f = setup();
		f.company.store.set({
			team: {
				...team,
				members: [
					{ userId: userB.id, email: userB.email!, displayName: "Anna", role: "contributor", joinedAt: timestamp },
				],
			},
		});
		const agent: TranscriptMessage = {
			kind: "agent",
			id: id(80),
			sequence: 1,
			text: "First paragraph.\n\nSecond paragraph.",
			attachmentCount: 1,
			phase: "progress",
			createdAt: timestamp,
		};
		const member: TranscriptMessage = {
			kind: "member",
			id: id(81),
			sequence: 2,
			text: "**Literal** member text\n\nAnother paragraph.",
			attachmentCount: 0,
			authorUserId: userB.id,
			createdAt: timestamp,
		};
		const mine: TranscriptMessage = {
			...member,
			id: id(82),
			sequence: 3,
			authorUserId: userA.id,
			pending: "failed",
			failureReason: "Please retry",
		};
		const items = [agent, member, mine];
		f.company.conversation(session.sessionId).set({ projection: { items, hiddenCount: 1, lastSequence: 3 } });
		f.view.update();
		const messages = f.view.el.querySelectorAll<HTMLElement>(".message");
		expect(messages).toHaveLength(3);
		expect(messages[0]?.dataset.messageId).toBe(agent.id);
		expect(messages[0]?.querySelectorAll(".bubble")).toHaveLength(2);
		expect(messages[0]?.getAttribute("aria-label")).toContain(staff.displayName);
		expect(messages[0]?.title).toContain(fmtTime(timestamp));
		expect(messages[0]?.querySelector(".message-caption")?.textContent).toBe("Progress");
		expect(messages[0]?.querySelectorAll(".received-file")).toHaveLength(1);
		expect(messages[0]?.querySelector(".received-file")?.textContent).toContain("Preview unavailable");
		expect(messages[1]?.querySelector(".message-author")?.textContent).toBe("Anna");
		expect(messages[1]?.querySelectorAll(".bubble")).toHaveLength(1);
		expect(messages[1]?.querySelector(".text")?.textContent).toBe(member.text);
		expect(messages[2]?.querySelector(".message-caption")?.textContent).toBe("Failed · Please retry");
		expect(f.view.el.querySelector(".message .avatar, .message .figure, .message .meta")).toBeNull();
		expect(f.company.conversation(session.sessionId).get().projection.items).toBe(items);
		for (const pending of ["queued", "processing"] as const) {
			f.company.conversation(session.sessionId).set({
				projection: { items: [{ ...mine, pending }], hiddenCount: 0, lastSequence: 3 },
			});
			f.view.update();
			expect(f.view.el.querySelector(".message-caption")?.textContent?.toLowerCase()).toBe(pending);
		}
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("closes attachment previews and clears private drafts when the account signs out", async () => {
		const f = fixture(),
			root = document.createElement("div");
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		document.body.append(root);
		dispose = mountApplication(root, f.cloud, f.api);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		input(root, "Message", "Private unsent draft");
		attach(root, [new File(["private"], "private.png", { type: "image/png" })]);
		button(root, "Preview private.png").click();
		f.auth(null);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(document.querySelector("dialog")).toBeNull();
		expect(root.textContent).not.toContain("Private unsent draft");
		expect(URL.revokeObjectURL).toHaveBeenCalled();
		f.auth(userA);
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		expect(root.querySelector(".attachment-chip")).toBeNull();
		expect(root.querySelector<HTMLTextAreaElement>(".composer-input")?.value).toBe("");
	});
	it("opens badge-free details, stays read-only without a write port and keeps focus through refreshes", async () => {
		const f = setup();
		const identity = button(f.view.el, "Open agent details");
		expect(f.view.el.querySelector(".thread-header .badge")).toBeNull();
		identity.focus();
		identity.click();
		const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
		expect(field("Responsibilities").value).toBe(staff.charter);
		expect(field("Agent name").readOnly).toBe(true);
		expect(button(document, "Edit figure").disabled).toBe(true);
		expect(document.querySelector(".agent-inline-field.is-editable")).toBeNull();
		const close = button(document, "Close agent details");
		expect(document.activeElement).toBe(close);
		f.company.store.set({ staff: [{ ...staff, version: 2 }] });
		await settle();
		expect(document.activeElement).toBe(close);
		document.querySelector("dialog")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector("dialog")).toBeNull();
		expect(document.activeElement).toBe(identity);
		expect(f.company.staffById(staff.id)?.displayName).toBe(staff.displayName);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("discards pending metadata saves on disposal and blocks writes after a role downgrade", async () => {
		const pending = deferred<number>(),
			updateAgent = vi.fn((_agent: unknown, _draft: unknown, _signal: AbortSignal) => pending.promise);
		const f = setup({ updateAgent });
		button(f.view.el, "Open agent details").click();
		const name = document.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!;
		name.focus();
		input(document, "Agent name", "Renamed");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(name.readOnly).toBe(true);
		name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(updateAgent).not.toHaveBeenCalled();
		expect(name.value).toBe(staff.displayName);
		f.company.store.set({ team });
		await settle();
		name.focus();
		input(document, "Agent name", "Renamed");
		name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(updateAgent).toHaveBeenCalledTimes(1);
		expect(updateAgent.mock.calls[0]![1]).toMatchObject({ displayName: "Renamed", role: staff.role });
		f.view.dispose();
		expect(updateAgent.mock.calls[0]![2].aborted).toBe(true);
		pending.resolve(staff.version + 1);
		await settle();
		expect(document.querySelector("dialog")).toBeNull();
		expect(f.api.listStaff).not.toHaveBeenCalled();
	});
	it("enables supported image sends, previews locally and retains keyboard send semantics after removal", () => {
		const sendMessage = vi.fn().mockResolvedValue(true);
		const f = setup({ sendMessage });
		input(f.view.el, "Message", "Keep this draft");
		attach(f.view.el, [new File(["local"], "brief.png", { type: "image/png" })]);
		expect(f.company.conversation(session.sessionId).get().attachments).toHaveLength(1);
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		button(f.view.el, "Preview brief.png").click();
		expect(document.querySelector("dialog img")?.getAttribute("src")).toBe("blob:fixture-local-image");
		button(document, "Close file preview").click();
		button(f.view.el, "Remove brief.png").click();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture-local-image");
		expect(button(f.view.el, "Send message").disabled).toBe(false);
		const field = f.view.el.querySelector("textarea")!;
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		expect(sendMessage).not.toHaveBeenCalled();
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
			session.sessionId,
			"Keep this draft",
			expect.any(AbortSignal),
		);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("keeps selected attachment bytes local and blocks text submission until they are removed", async () => {
		const f = fixture(),
			root = document.createElement("div");
		vi.spyOn(f.api, "appendPrompt");
		document.body.append(root);
		// Isolate attachment gating from the model-account selection flow.
		dispose = mountApplication(root, f.cloud, f.api, { nativeSubscription: undefined });
		await settle();
		await vi.advanceTimersByTimeAsync(60);
		input(root, "Message", "Keep this local");
		await settle();
		const send = button(root, "Send message");
		expect(send.disabled).toBe(false);
		attach(root, [new File(["local"], "brief.txt", { type: "text/plain" })]);
		expect(send.disabled).toBe(true);
		send.click();
		root.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(root.querySelector("textarea")!.value).toBe("Keep this local");
		expect(root.querySelector(".attachment-status")?.textContent).toContain("Attachments stay on this device");
		expect(root.textContent).not.toContain("Remove them to send");
		button(root, "Remove brief.txt").click();
		expect(send.disabled).toBe(false);
		expect(root.querySelector("textarea")!.value).toBe("Keep this local");
		expect(f.api.appendPrompt).not.toHaveBeenCalled();
		expect(
			vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).endsWith("/qorpera_list_member_notifications")),
		).toHaveLength(0);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("keeps attachment drafts scoped to their conversation and releases previews on disposal", () => {
		const f = setup();
		attach(f.view.el, [new File(["local"], "private.png", { type: "image/png" })]);
		button(f.view.el, "Preview private.png").click();
		f.view.dispose();
		expect(document.querySelector("dialog")).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalled();
		const other = new ConversationView(f.company, id(90));
		expect(other.el.querySelector(".attachment-tray")?.children).toHaveLength(0);
		other.dispose();
		const restored = new ConversationView(f.company, session.sessionId);
		expect(button(restored.el, "Preview private.png")).toBeDefined();
		restored.dispose();
	});
	function stubResizeObserver() {
		const observers: { callback: () => void; targets: Element[]; disconnected: boolean }[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly #entry: (typeof observers)[number];
				constructor(callback: () => void) {
					this.#entry = { callback, targets: [], disconnected: false };
					observers.push(this.#entry);
				}
				observe(target: Element) {
					this.#entry.targets.push(target);
				}
				disconnect() {
					this.#entry.disconnected = true;
				}
			},
		);
		return observers;
	}

	it("opens a loaded conversation at its latest message and keeps it there while the pane resizes", () => {
		// The view renders before it is placed in the page, so the end of the
		// thread can only be shown once the message pane has a size.
		const observers = stubResizeObserver();
		const { view, messages, metrics } = loadedView();
		const sizes = observers.find((entry) => entry.targets.includes(messages))!;
		expect(sizes.targets).toEqual([messages]);
		document.body.append(view.el);
		metrics.scrollHeight = 2000;
		sizes.callback();
		expect(metrics.scrollTop).toBe(1600);
		// A reader who scrolled up to older messages is left there.
		metrics.scrollTop = 500;
		messages.dispatchEvent(new Event("scroll"));
		metrics.scrollHeight = 2400;
		sizes.callback();
		expect(metrics.scrollTop).toBe(500);
		// Back at the end, a pane that changes size still shows the latest message.
		metrics.scrollTop = 2000;
		messages.dispatchEvent(new Event("scroll"));
		metrics.scrollHeight = 2600;
		sizes.callback();
		expect(metrics.scrollTop).toBe(2200);
		view.dispose();
		expect(sizes.disconnected).toBe(true);
		metrics.scrollTop = 0;
		sizes.callback();
		expect(metrics.scrollTop).toBe(0);
	});

	it("stays pinned when the pin's own scroll event arrives after the pane shrank", () => {
		// The composer or a notice line appears in the same task as the pin, so the
		// pin's scroll event reads a gap it did not cause. Only a real scroll counts.
		const observers = stubResizeObserver();
		const { view, messages, metrics } = loadedView();
		const sizes = observers.find((entry) => entry.targets.includes(messages))!;
		document.body.append(view.el);
		metrics.scrollHeight = 2000;
		sizes.callback();
		expect(metrics.scrollTop).toBe(1600);
		metrics.clientHeight = 340; // a line appeared above the composer
		messages.dispatchEvent(new Event("scroll")); // the pin's event, 60px short now
		sizes.callback();
		expect(metrics.scrollTop).toBe(1660);
		// The guard is spent: the next event at another position is the member's.
		metrics.scrollTop = 1000;
		messages.dispatchEvent(new Event("scroll"));
		metrics.scrollHeight = 2400;
		sizes.callback();
		expect(metrics.scrollTop).toBe(1000);
		// Back at the end; a pin that does not move the thread arms nothing, so a
		// later real scroll that lands on the same position is still the member's.
		metrics.scrollTop = 2060;
		messages.dispatchEvent(new Event("scroll"));
		sizes.callback();
		expect(metrics.scrollTop).toBe(2060);
		metrics.scrollHeight = 2500; // content grew under the reader
		messages.dispatchEvent(new Event("scroll")); // still at 2060: 100px from the end
		metrics.scrollHeight = 2600;
		sizes.callback();
		expect(metrics.scrollTop).toBe(2060);
		view.dispose();
	});
	it("still opens a loaded conversation at its latest message without a size observer", async () => {
		vi.stubGlobal("ResizeObserver", undefined);
		const { view, metrics } = loadedView();
		metrics.scrollHeight = 2000;
		document.body.append(view.el);
		expect(metrics.scrollTop).toBe(0);
		await Promise.resolve();
		expect(metrics.scrollTop).toBe(1600);
	});
	it("keeps the computer popover compact and the conversation usable at every width", () => {
		const f = setup(),
			toggle = button(f.view.el, "Open agent computer");
		toggle.focus();
		toggle.click();
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(document.activeElement).toBe(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(panel.textContent).toContain("Computer access is not available yet.");
		expect(panel.querySelector("header, select, .computer-preview")).toBeNull();
		expect(panel.textContent).not.toContain("Open computer");
		expect(panel.textContent).not.toContain("Routines");
		const composer = f.view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		for (const width of [1280, 600, 375]) {
			vi.stubGlobal("innerWidth", width);
			window.dispatchEvent(new Event("resize"));
			expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
			composer.focus();
			expect(document.activeElement).toBe(composer);
		}
		panel.focus();
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(f.view.el.querySelector(".computer-panel")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
		expect(document.activeElement).toBe(toggle);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("uses the same computer toggle to close and reopen the popover without moving focus", () => {
		const f = setup(),
			toggle = button(f.view.el, "Open agent computer");
		toggle.focus();
		for (let attempt = 0; attempt < 2; attempt++) {
			toggle.click();
			expect(f.view.el.querySelectorAll(".computer-panel")).toHaveLength(1);
			expect(toggle.getAttribute("aria-expanded")).toBe("true");
			expect(document.activeElement).toBe(toggle);
			toggle.click();
			expect(f.view.el.querySelector(".computer-panel")).toBeNull();
			expect(toggle.getAttribute("aria-expanded")).toBe("false");
			expect(document.activeElement).toBe(toggle);
		}
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("closes the popover from its X top right as the toggle does", () => {
		const f = setup(),
			toggle = button(f.view.el, "Open agent computer");
		toggle.focus();
		toggle.click();
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		const close = panel.querySelector<HTMLButtonElement>("button.computer-close")!;
		expect(close.getAttribute("aria-label")).toBe("Close computer");
		expect(close.getAttribute("title")).toBe("Close");
		close.click();
		expect(f.view.el.querySelector(".computer-panel")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
		expect(document.activeElement).toBe(toggle);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("keeps the agent's computer open across the threads a member moves between", () => {
		const panels = new ComputerPanels(),
			f = setup({ computerPanels: panels });
		button(f.view.el, "Open agent computer").click();
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(panel).not.toBeNull();
		// Leaving the thread keeps the panel; it is only out of the page for now.
		f.view.dispose();
		expect(panel.isConnected).toBe(false);
		expect(panels.get(staff.id)?.el).toBe(panel);
		// Another thread without this agent shows nothing of it.
		const other = new ConversationView(f.company, id(90), { computerPanels: panels });
		expect(other.el.querySelector(".computer-panel")).toBeNull();
		other.dispose();
		// Back in the agent's thread the same panel is there, with no click.
		const restored = new ConversationView(f.company, session.sessionId, { computerPanels: panels });
		document.body.append(restored.el);
		expect(restored.el.querySelector(".computer-panel")).toBe(panel);
		expect(button(restored.el, "Open agent computer").getAttribute("aria-expanded")).toBe("true");
		// Closing it there ends it for every thread.
		button(restored.el, "Open agent computer").click();
		expect(restored.el.querySelector(".computer-panel")).toBeNull();
		expect(panels.get(staff.id)).toBeUndefined();
		restored.dispose();
		const again = new ConversationView(f.company, session.sessionId, { computerPanels: panels });
		expect(again.el.querySelector(".computer-panel")).toBeNull();
		again.dispose();
		// The company's shared panel set is left to the company: this view never disposes it.
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});

	it("keeps the open computer through a rename and replaces it only when the thread changes agent", async () => {
		const panels = new ComputerPanels(),
			f = setup({ computerPanels: panels });
		button(f.view.el, "Open agent computer").click();
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		f.company.store.set({ staff: [{ ...staff, displayName: "Renamed" }] });
		await settle();
		expect(f.view.el.querySelector(".computer-panel")).toBe(panel);
		expect(f.view.el.querySelector(".thread-identity h1")?.textContent).toBe("Renamed");
		expect(panels.get(staff.id)?.el).toBe(panel);
		const other = { ...staff, id: id(97), displayName: "Other" };
		f.company.store.set({
			staff: [{ ...staff, displayName: "Renamed" }, other],
			sessions: [{ ...session, staffAgentId: other.id }],
		});
		await settle();
		const replaced = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		expect(replaced).not.toBe(panel);
		expect(panels.get(staff.id)).toBeUndefined();
		expect(panels.get(other.id)?.el).toBe(replaced);
	});

	it("places the company notices right above the composer, inside the conversation", () => {
		const host = document.createElement("div");
		const f = setup({ notificationHost: host });
		expect(host.parentElement).toBe(f.view.el.querySelector(".thread-conversation"));
		// The failed-run line shares the band: notices first, then the run, then the composer.
		const slot = host.nextElementSibling;
		expect(slot?.classList.contains("thread-run-failure")).toBe(true);
		expect(slot?.nextElementSibling).toBe(f.view.el.querySelector("footer.composer"));
	});

	it("places the failed-run line right above the composer without a notification host", () => {
		const f = setup();
		const slot = f.view.el.querySelector<HTMLElement>(".thread-run-failure");
		expect(slot?.parentElement).toBe(f.view.el.querySelector(".thread-conversation"));
		expect(slot?.previousElementSibling?.classList.contains("thread-status")).toBe(true);
		expect(slot?.nextElementSibling).toBe(f.view.el.querySelector("footer.composer"));
	});

	it.each([false, true])("restores notification focus with the computer open (entered: %s)", async (entered) => {
		const host = document.createElement("div");
		document.body.append(host);
		const f = setup({ notificationHost: host });
		button(f.view.el, "Open agent computer").click();
		const panel = f.view.el.querySelector<HTMLElement>(".computer-panel")!;
		// The renderer sets this class when native fullscreen is unavailable.
		panel.classList.toggle("is-entered", entered);
		f.company.store.set({
			activity: [
				{
					runId: id(70),
					staffAgentId: staff.id,
					sourceKind: "room_delivery",
					jobStatus: "failed",
					activity: "needs_attention",
					updatedAt: timestamp,
				},
			],
		});
		await settle();
		const close = button(f.view.el, "Dismiss");
		close.focus();
		close.click();
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(document.activeElement).toBe(entered ? panel : f.view.el.querySelector(".composer-input"));
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBeFalsy();
	});

	it("closes an unresolved run popup immediately without discarding work or reopening on polling", async () => {
		const host = document.createElement("div");
		const sibling = document.createElement("section");
		host.append(sibling);
		document.body.append(host);
		const f = setup({ notificationHost: host });
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError: "Runner lease expired before durable completion",
			unsettledOperations: 1,
		};
		const card = () => document.querySelector<HTMLElement>(".run-failure");
		const discard = vi.spyOn(f.api, "discardFailedRun");
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details } });
		await settle();
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe("Fixture agent did not finish this run");
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe("The run took too long and was stopped.");
		// The cloud's own error text stays out of the card; the reason is in the member's words.
		expect(card()?.textContent).not.toContain(details.lastError);
		expect(card()?.querySelector("details")).toBeNull();
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		// Unsettled operations: nothing may be repeated yet.
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
		// The card sits right above the composer, below the company notices, never inside the thread.
		expect(f.view.el.querySelector(".messages")?.contains(card())).toBe(false);
		expect(host.querySelector(".run-failure")).toBeNull();
		const slot = f.view.el.querySelector<HTMLElement>(".thread-run-failure");
		expect(slot?.contains(card())).toBe(true);
		expect(slot?.previousElementSibling).toBe(host);
		expect(slot?.nextElementSibling?.classList.contains("composer")).toBe(true);
		expect(f.view.el.querySelector(".thread-status .notice-warn")).toBeNull();
		const close = button(f.view.el, "Dismiss");
		close.focus();
		f.company.store.set({ activity: [{ ...run }] });
		await settle();
		expect(button(f.view.el, "Dismiss")).toBe(close);
		expect(document.activeElement).toBe(close);
		close.click();
		expect(card()).toBeNull();
		expect(document.activeElement).toBe(f.view.el.querySelector("textarea"));
		expect(discard).not.toHaveBeenCalled();
		f.company.store.set({
			activity: [{ ...run }],
			recoveries: { [run.runId]: { ...details, unsettledOperations: 0 } },
		});
		await settle();
		expect(card()).toBeNull();
		// Navigation within the same company does not replay a dismissed popup.
		f.view.dispose();
		const reopened = new ConversationView(f.company, session.sessionId, { notificationHost: host });
		document.body.append(reopened.el);
		expect(card()).toBeNull();
		// A different failed run still gets its own dismissible notification.
		f.company.store.set({ activity: [{ ...run, runId: id(71) }] });
		await settle();
		expect(card()).not.toBeNull();
		reopened.dispose();
		expect([...host.children]).toEqual([sibling]);
	});

	it("allows readers to hide run notifications and retains review links without subtext", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError: "Internal provider failure",
			unsettledOperations: 0,
			proposalId: id(71),
		};
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		f.company.store.set({
			team: { ...team, capabilities: { ...team.capabilities, write: false } },
			activity: [run],
			recoveries: { [run.runId]: details },
		});
		await settle();
		expect(card()?.querySelector("a")?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/proposal/${id(71)}`);
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe(
			"Fixture agent stopped with changes to review",
		);
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe("Its changes wait for your decision.");
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
		button(f.view.el, "Dismiss").focus();
		button(f.view.el, "Dismiss").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(card()).toBeNull();
		expect(document.activeElement).toBe(button(f.view.el, "Open agent details"));
		const review = { ...run, runId: id(72), sourceKind: "proposal_review" as const };
		f.company.store.set({ activity: [review] });
		await settle();
		expect(card()?.querySelector(".run-failure-title")?.textContent).toBe("A review did not finish");
		expect(card()?.querySelector('[data-action="retry-run"]')).toBeNull();
		expect(card()?.querySelector("a")?.getAttribute("href")).toBe(`#/c/${profileA.profileId}/file`);
		f.company.store.set({ team: undefined });
		await settle();
		expect(card()).toBeNull();
	});

	it("dismisses durably at once, and the next run then shows with its Stop control", async () => {
		const nextRun = id(73);
		const cancel = vi.fn(async () => "cancelled" as const);
		const f = setup({
			runControl: {
				read: vi.fn(async () => ({
					sessionId: session.sessionId,
					staffAgentId: staff.id,
					run: { runId: nextRun, status: "leased" as const, canCancel: true },
				})),
				cancel,
			},
		});
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const pending = deferred<void>();
		const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockReturnValue(pending.promise);
		const discard = vi.spyOn(f.api, "discardFailedRun");
		// Match the server's priority: the old failure masks the newer leased run until acknowledged.
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([
			{ ...run, runId: nextRun, jobStatus: "leased", activity: "working" },
		]);
		// Details have not arrived yet: dismissing does not wait for them.
		f.company.store.set({ activity: [run], recoveries: {} });
		await settle();
		expect(f.company.agentState(staff.id)).toBe("failed");
		expect(f.view.el.querySelector('[aria-label="Stop"]')).toBeNull();
		const close = button(f.view.el, "Dismiss");
		close.focus();
		close.click();
		close.click();
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(document.activeElement).toBe(f.view.el.querySelector("textarea"));
		// Seen: the run stops standing in for the agent before the cloud has answered.
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(run.runId);
		expect(discard).not.toHaveBeenCalled();
		expect(f.company.agentState(staff.id)).toBe("idle");
		pending.resolve();
		await settle();
		expect(f.company.agentState(staff.id)).toBe("working");
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(button(f.view.el, "Stop").disabled).toBe(false);
		button(f.view.el, "Stop").click();
		await settle();
		expect(cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId, nextRun, expect.any(AbortSignal));
	});

	it("offers Try again in the thread, runs it on the selected account, and reports a refusal in plain words", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError:
				"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)",
			unsettledOperations: 0,
		};
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		const retryButton = () => card()?.querySelector<HTMLButtonElement>('[data-action="retry-run"]') ?? null;
		const sponsor = {
			connectionId: id(80),
			provider: "openai",
			nativeHarness: "codex-cli" as const,
			sponsorBindingId: id(81),
			sponsorVersion: 3,
			computeIdentityId: id(82),
			workerClass: "managed_sandbox" as const,
		};
		f.company.conversation(session.sessionId, false).set({ executionSponsor: sponsor });
		// The cloud keeps reporting the failed run until it is released or dismissed.
		vi.spyOn(f.api, "listStaffActivity").mockResolvedValue([run]);
		vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(details);
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details } });
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"No computer could be started for this run. The problem is on Qorpera's side.",
		);
		let release: (() => void) | undefined;
		const retry = vi.spyOn(f.api, "retryRoomDelivery").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		retryButton()!.focus();
		retryButton()!.click();
		await settle();
		expect(retry).toHaveBeenCalledExactlyOnceWith(run.runId, sponsor.sponsorBindingId, sponsor.sponsorVersion);
		expect(retryButton()?.textContent).toBe("Trying again…");
		expect(retryButton()?.getAttribute("aria-disabled")).toBe("true");
		// A second click while it runs does nothing, and the button keeps focus across the redraw.
		retryButton()!.click();
		expect(retry).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(retryButton());
		release?.();
		await settle();
		// A refusal stays in the card, in the member's words.
		retry.mockRejectedValueOnce(new Error("Only the author of the post can retry it"));
		f.company.store.set({ activity: [{ ...run }], recoveries: { [run.runId]: details } });
		await settle();
		retryButton()!.click();
		await settle();
		expect(card()?.querySelector(".run-failure-error")?.textContent).toBe(
			"Only the person who wrote the message can try it again.",
		);
		expect(retryButton()?.textContent).toBe("Try again");
		// Only an operator pauses a company now; there is nothing for the member to resume.
		retry.mockRejectedValueOnce(new Error("Company execution is paused"));
		retryButton()!.click();
		await settle();
		expect(card()?.querySelector(".run-failure-error")?.textContent).toBe(
			"Agents are paused for a moment while Qorpera updates. Try again shortly.",
		);
	});

	it("stops offering Try again for room posts when the deployed cloud cannot do it, and keeps it for session turns", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "room_delivery" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError: "Runner lease expired before durable completion",
			unsettledOperations: 0,
		};
		const retryButton = () => f.view.el.querySelector<HTMLButtonElement>('.run-failure [data-action="retry-run"]');
		f.company.conversation(session.sessionId, false).set({
			executionSponsor: {
				connectionId: id(80),
				provider: "openai",
				nativeHarness: "codex-cli",
				sponsorBindingId: id(81),
				sponsorVersion: 1,
				computeIdentityId: id(82),
				workerClass: "managed_sandbox",
			},
		});
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details } });
		await settle();
		vi.spyOn(f.api, "listStaffActivity").mockResolvedValue([run]);
		vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(details);
		vi.spyOn(f.api, "retryRoomDelivery").mockRejectedValue(
			new CloudRpcError("qorpera_retry_room_delivery", { message: "not found", code: "PGRST202" }, 404),
		);
		retryButton()!.click();
		await settle();
		f.company.store.set({ activity: [{ ...run }], recoveries: { [run.runId]: details } });
		await settle();
		expect(retryButton()).toBeNull();
		expect(f.view.el.querySelector(".run-failure-error")?.textContent).toBe(
			"Trying again is not available yet. Send the message again instead.",
		);
		expect(button(f.view.el, "Dismiss")).toBeTruthy();
		const turn = { ...run, runId: id(71), sourceKind: "session_turn" as const };
		const turnRetry = vi.spyOn(f.api, "retryFailedRun").mockResolvedValue();
		f.company.store.set({
			activity: [turn],
			recoveries: { [turn.runId]: { ...details, runId: turn.runId, sourceKind: turn.sourceKind } },
		});
		await settle();
		retryButton()!.click();
		await settle();
		expect(turnRetry).toHaveBeenCalledExactlyOnceWith(turn.runId);
	});

	it("offers Dismiss only for a refused run, and Try again for an interrupted one", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const details = (lastError: string) => ({
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			lastError,
			unsettledOperations: 0,
		});
		const card = () => f.view.el.querySelector<HTMLElement>(".run-failure");
		f.company.store.set({ activity: [run], recoveries: { [run.runId]: details("You have hit your usage limit.") } });
		await settle();
		expect(card()?.querySelector(".run-failure-reason")?.textContent).toBe(
			"Your model account has reached its usage limit.",
		);
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual(["Dismiss"]);
		f.company.store.set({
			activity: [run],
			recoveries: { [run.runId]: details("Runner lease expired before durable completion") },
		});
		await settle();
		expect([...(card()?.querySelectorAll("button") ?? [])].map((item) => item.textContent)).toEqual([
			"Try again",
			"Dismiss",
		]);
		// The card is one quiet line, like a company notice: no big mark, no rule.
		expect(card()?.querySelector(".run-failure-mark")).toBeNull();
		expect(card()?.querySelector(".run-failure-rule")).toBeNull();
	});

	it("keeps a dismissed failure dismissed when it is displaced and returns", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockResolvedValue(undefined);
		// The cloud's next read reports a newer failure, which gets its own card.
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([{ ...run, runId: id(71) }]);
		f.company.store.set({ activity: [run] });
		await settle();
		button(f.view.el, "Dismiss").click();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(run.runId);
		await settle();
		expect(f.view.el.querySelector(".run-failure")).not.toBeNull();
		// The dismissed run comes back from a stale read: it stays dismissed, once.
		f.company.store.set({
			activity: [run],
			recoveries: {
				[run.runId]: {
					runId: run.runId,
					sourceKind: run.sourceKind,
					jobStatus: run.jobStatus,
					unsettledOperations: 0,
				},
			},
		});
		await settle();
		expect(f.view.el.querySelector(".run-failure")).toBeNull();
		expect(acknowledge).toHaveBeenCalledTimes(1);
		expect(f.company.agentState(staff.id)).toBe("idle");
	});

	it("keeps a dismissal across navigation, and shows the card again after a lost cloud reply", async () => {
		const f = setup();
		const run = {
			runId: id(70),
			staffAgentId: staff.id,
			sourceKind: "session_turn" as const,
			jobStatus: "failed" as const,
			activity: "needs_attention" as const,
			updatedAt: timestamp,
		};
		const recovery = {
			runId: run.runId,
			sourceKind: run.sourceKind,
			jobStatus: run.jobStatus,
			unsettledOperations: 0,
		};
		const pending = deferred<void>();
		const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockReturnValueOnce(pending.promise);
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([run]);
		vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(recovery);
		f.company.store.set({ activity: [run] });
		await settle();
		button(f.view.el, "Dismiss").click();
		f.view.dispose();
		f.view.el.remove();
		const reopened = new ConversationView(f.company, session.sessionId);
		document.body.append(reopened.el);
		dispose = () => {
			reopened.dispose();
			f.company.stop();
		};
		f.company.store.set({ recoveries: { [run.runId]: recovery } });
		await settle();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(run.runId);
		expect(reopened.el.querySelector(".run-failure")).toBeNull();
		// Nothing reached the cloud: the failure is not settled, so the card returns
		// in the current view and can be dismissed again.
		pending.reject(new Error("Connection lost"));
		await settle();
		expect(reopened.el.querySelector(".run-failure-title")?.textContent).toBe(
			"Fixture agent did not finish this run",
		);
		expect(f.company.agentState(staff.id)).toBe("failed");
		acknowledge.mockResolvedValue(undefined);
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([]);
		button(reopened.el, "Dismiss").click();
		await settle();
		expect(acknowledge).toHaveBeenCalledTimes(2);
		expect(reopened.el.querySelector(".run-failure")).toBeNull();
		expect(f.company.agentState(staff.id)).toBe("idle");
	});

	it.each(["reader", "unsettled", "proposal", "review", "closed", "stopped"] as const)(
		"keeps dismissal local when recovery arrives after %s changes",
		async (kind) => {
			const f = setup();
			const run = {
				runId: id(70),
				staffAgentId: staff.id,
				sourceKind: kind === "review" ? ("proposal_review" as const) : ("session_turn" as const),
				jobStatus: "failed" as const,
				activity: "needs_attention" as const,
				updatedAt: timestamp,
			};
			const discard = vi.spyOn(f.api, "discardFailedRun");
			f.company.store.set({ activity: [run] });
			await settle();
			const close = button(f.view.el, "Dismiss");
			if (kind === "reader")
				f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
			close.click();
			if (kind === "closed")
				f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id, status: "closed" }] });
			if (kind === "stopped") f.company.stop();
			f.company.store.set({
				recoveries: {
					[run.runId]: {
						runId: run.runId,
						sourceKind: run.sourceKind,
						jobStatus: run.jobStatus,
						unsettledOperations: kind === "unsettled" ? 1 : 0,
						proposalId: kind === "proposal" ? id(74) : undefined,
					},
				},
			});
			await settle();
			expect(discard).not.toHaveBeenCalled();
			expect(f.view.el.querySelector(".run-failure")).toBeNull();
		},
	);
});

describe("local attachment validation", () => {
	it("rejects empty/oversized files and renders SVG as an inert document", () => {
		const change = vi.fn();
		const tray = new AttachmentTray([], change);
		dispose = () => tray.dispose();
		tray.add([new File([], "empty"), new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge")]);
		expect(tray.count).toBe(0);
		tray.add([new File(['<svg onload="alert(1)"/>'], "untrusted.svg", { type: "image/svg+xml" })]);
		expect(tray.count).toBe(1);
		expect(tray.el.querySelector("img")).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
	it("caps the selection and does not mutate an incoming draft array", () => {
		const files = [new File(["x"], "original")],
			tray = new AttachmentTray(files, () => {});
		dispose = () => tray.dispose();
		button(tray.el, "Remove original").click();
		expect(files).toHaveLength(1);
		tray.add(Array.from({ length: 9 }, (_, index) => new File(["x"], `file-${index}`)));
		expect(tray.count).toBe(8);
		expect(tray.status.textContent).toContain("up to 8 files");
	});
});

describe("safe formatted messages", () => {
	it("splits paragraphs while keeping blank lines inside lists, quotes and code intact", () => {
		const bubbles = markdownBubbles(
			"First.\n\nSecond.\n\n- one\n\n  continuation\n\n- two\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\n> Quote\n>\n> Another paragraph\n\nLast.",
		);
		expect(bubbles).toHaveLength(6);
		expect(bubbles[0]?.textContent).toBe("First.");
		expect(bubbles[1]?.textContent).toBe("Second.");
		expect(bubbles[2]?.querySelectorAll("li")).toHaveLength(2);
		expect(bubbles[2]?.textContent).toContain("continuation");
		expect(bubbles[3]?.querySelector("pre code")?.textContent).toBe("const x = 1;\n\nconst y = 2;");
		expect(bubbles[4]?.querySelectorAll("blockquote p")).toHaveLength(2);
		expect(bubbles[5]?.textContent).toBe("Last.");
	});
	it("keeps introductions with lists and tables and resolves references across bubbles", () => {
		const bubbles = markdownBubbles(
			"See [brief][plan].\n\nTasks:\n\n- one\n- two\n\nStatus:\n\n| Item | State |\n| --- | --- |\n| Brief | Ready |\n\n[plan]: https://example.invalid/brief",
		);
		expect(bubbles).toHaveLength(3);
		expect(bubbles[0]?.querySelector("a")?.href).toBe("https://example.invalid/brief");
		expect(bubbles[1]?.querySelector("p")?.textContent).toBe("Tasks:");
		expect(bubbles[1]?.querySelectorAll("li")).toHaveLength(2);
		expect(bubbles[2]?.querySelector("p")?.textContent).toBe("Status:");
		expect(bubbles[2]?.querySelectorAll("td")).toHaveLength(2);
	});
	it("preserves public progress and file summaries and keeps unsafe markup inert after grouping", () => {
		const bubbles = markdownBubbles(
			"Working on that now.\n\nFiles changed:\n\n- brief.md\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert%281%29)\n\n![Track](https://example.invalid/image.png)",
		);
		expect(bubbles.map((bubble) => bubble.textContent).join("\n")).toContain("Working on that now.");
		expect(bubbles.map((bubble) => bubble.textContent).join("\n")).toContain("brief.md");
		for (const bubble of bubbles) expect(bubble.querySelector("img, script, iframe")).toBeNull();
		expect(bubbles.flatMap((bubble) => [...bubble.querySelectorAll("a")]).map((link) => link.protocol)).toEqual([
			"https:",
		]);
	});
	it("decodes text entities without activating encoded markup or destinations", () => {
		const rendered = markdown("A &amp; B &copy; &lt;img src=x&gt; `&amp;` [Unsafe](jav&#x61;script:alert%281%29)");
		expect(rendered.textContent).toBe("A & B © <img src=x> &amp; Unsafe");
		expect(rendered.querySelector("img, a")).toBeNull();
	});
	it("renders structure while leaving raw HTML, dangerous links and remote images inert", () => {
		const rendered = markdown(
			"# Heading\n\n**Strong** and `code`\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\n<script>alert(1)</script>\n```\n\n[Good](https://example.invalid) [Bad](javascript:alert%281%29)\n\n![Track](https://example.invalid/track.png)\n\n<img src=x onerror=alert(1)>",
		);
		expect(rendered.querySelector("h2")?.textContent).toBe("Heading");
		expect(rendered.querySelector("strong")?.textContent).toBe("Strong");
		expect(rendered.querySelectorAll("li")).toHaveLength(2);
		expect(rendered.querySelectorAll("td")).toHaveLength(2);
		expect(rendered.querySelector("pre code")?.textContent).toBe("<script>alert(1)</script>");
		expect(rendered.querySelector("img, script, iframe, svg")).toBeNull();
		expect([...rendered.querySelectorAll("a")].map((link) => link.protocol)).toEqual(["https:", "https:"]);
		expect(rendered.textContent).toContain("<img src=x onerror=alert(1)>");
	});
});

describe("new conversation and agent setup", () => {
	function setupNew(actions: WorkspaceActions = {}, agents = [staff]) {
		const f = fixture(),
			company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ staff: agents, sessions: [session], loading: false });
		const view = new NewConversationView(company, actions, () => {});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		return { ...f, company, view, search: recipients(view.el) };
	}
	function recipients(root: ParentNode): HTMLInputElement {
		return root.querySelector<HTMLInputElement>('[aria-label="Search conversation recipients"]')!;
	}
	function choice(root: ParentNode, key: string): HTMLElement {
		const result = root.querySelector<HTMLElement>(`[role="option"][data-choice="${key}"]`);
		if (!result) throw new Error(`Missing choice: ${key}`);
		return result;
	}
	function choices(root: ParentNode): string[] {
		return [...root.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.dataset.choice!);
	}
	function press(target: HTMLElement, key: string): KeyboardEvent {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		return event;
	}
	it("hangs one list from the To: field: new agent, new group chat, then the agents", async () => {
		const f = setupNew();
		await settle();
		f.search.focus();
		expect(f.search.getAttribute("role")).toBe("combobox");
		expect(f.search.getAttribute("aria-expanded")).toBe("true");
		expect(f.view.el.querySelector<HTMLElement>(".recipient-menu")!.hidden).toBe(false);
		expect(choices(f.view.el)).toEqual(["create", "group", staff.id]);
		expect(choice(f.view.el, staff.id).textContent).toContain("Fixture agent");
		// The old screen's heading, cards and Open/Cancel footer are gone.
		expect(f.view.el.querySelector("h1, .recipient-card, .recipient-footer")).toBeNull();
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.search.getAttribute("aria-expanded")).toBe("false");
		expect(f.view.el.querySelector<HTMLElement>(".recipient-menu")!.hidden).toBe(true);
		f.search.click();
		expect(f.search.getAttribute("aria-expanded")).toBe("true");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("adds agents and the Co-Founder to recipients without navigating", async () => {
		const other = { ...staff, id: id(92), displayName: "Second agent", role: "Research" },
			cofounder = { ...staff, id: id(93), displayName: "Co-Founder", templateId: "co-founder" };
		const f = setupNew({}, [cofounder, staff, other]);
		await settle();
		f.search.focus();
		const originalHash = location.hash;
		choice(f.view.el, other.id).click();
		choice(f.view.el, cofounder.id).click();
		expect(location.hash).toBe(originalHash);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		input(f.view.el, "Search conversation recipients", "fixture");
		expect(choices(f.view.el)).toEqual(["create", "group", staff.id]);
		// Typing highlights the first match, so Enter adds it.
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, staff.id).id);
		expect(press(f.search, "Enter").defaultPrevented).toBe(true);
		expect(location.hash).toBe(originalHash);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(3);
		// Rows show no titles, so a title alone never matches.
		input(f.view.el, "Search conversation recipients", "research");
		expect(choices(f.view.el)).toEqual(["create", "group"]);
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("counts a double-click once, since rows and chips move under the pointer", async () => {
		const other = { ...staff, id: id(92), displayName: "Second agent" };
		const f = setupNew({}, [staff, other]);
		await settle();
		const click = (target: HTMLElement, detail: number) =>
			target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
		click(choice(f.view.el, "group"), 1);
		// The first agent now sits where New group chat was; the second click lands on it.
		expect(choices(f.view.el)).toEqual(["create", staff.id, other.id]);
		click(choice(f.view.el, staff.id), 2);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(0);
		for (const agent of [staff, other]) click(choice(f.view.el, agent.id), 1);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		click(f.view.el.querySelector<HTMLElement>(".recipient-chip")!, 1);
		click(f.view.el.querySelector<HTMLElement>(".recipient-chip")!, 2);
		expect([...f.view.el.querySelectorAll(".recipient-chip")].map((chip) => chip.textContent)).toEqual([
			"Second agent",
		]);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("moves through the list with the arrow keys and closes it with Escape", async () => {
		const f = setupNew();
		f.company.store.set({ team });
		await settle();
		f.search.focus();
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		press(f.search, "ArrowDown");
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, "create").id);
		expect(choice(f.view.el, "create").classList.contains("active")).toBe(true);
		press(f.search, "ArrowUp");
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, staff.id).id);
		expect(choice(f.view.el, "create").hasAttribute("aria-selected")).toBe(false);
		expect(press(f.search, "Escape").defaultPrevented).toBe(true);
		expect(f.search.getAttribute("aria-expanded")).toBe("false");
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		// With the list already closed, Escape is left to the page.
		expect(press(f.search, "Escape").defaultPrevented).toBe(false);
		press(f.search, "ArrowDown");
		expect(f.search.getAttribute("aria-expanded")).toBe("true");
	});
	it("keeps focus and the caret in the field across refreshes and drops a row that disappears", async () => {
		const f = setupNew();
		await settle();
		f.search.focus();
		for (let step = 0; step < 3; step++) press(f.search, "ArrowDown");
		const row = choice(f.view.el, staff.id);
		expect(f.search.getAttribute("aria-activedescendant")).toBe(row.id);
		f.company.store.set({ activity: [] });
		await settle();
		// Activity refreshes neither rebuild the rows nor move the highlight.
		expect(choice(f.view.el, staff.id)).toBe(row);
		expect(f.search.getAttribute("aria-activedescendant")).toBe(row.id);
		f.company.store.set({ staff: [] });
		await settle();
		expect(document.activeElement).toBe(f.search);
		expect(f.search.hasAttribute("aria-activedescendant")).toBe(false);
		expect(f.view.el.querySelector(".recipient-empty")?.textContent).toBe("No agents yet.");
		f.search.value = "Fixture";
		f.search.dispatchEvent(new Event("input"));
		f.search.setSelectionRange(2, 2);
		f.company.store.set({ staff: [staff] });
		await settle();
		expect(document.activeElement).toBe(f.search);
		expect(f.search.selectionStart).toBe(2);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("waits for permission, names a new agent from the search, and preserves a local setup draft", async () => {
		const f = setupNew();
		expect(parseRoute(`#/c/${profileA.profileId}/new`)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "new",
		});
		expect(choice(f.view.el, "create").getAttribute("aria-disabled")).toBe("true");
		choice(f.view.el, "create").click();
		expect(f.view.el.querySelector("form")).toBeNull();
		f.company.store.set({ team });
		await settle();
		expect(choice(f.view.el, "create").hasAttribute("aria-disabled")).toBe(false);
		input(f.view.el, "Search conversation recipients", "missing");
		expect(choices(f.view.el)).toEqual(["create", "group"]);
		expect(f.view.el.querySelector(".recipient-empty")?.textContent).toBe("No agents match.");
		expect(choice(f.view.el, "create").textContent).toBe("New agent “missing”");
		choice(f.view.el, "create").click();
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("missing");
		input(f.view.el, "Agent name", "Draft agent");
		expect(button(f.view.el, "Create agent").disabled).toBe(true);
		button(f.view.el, "Back").click();
		expect(document.activeElement).toBe(recipients(f.view.el));
		expect(recipients(f.view.el).value).toBe("missing");
		// The member's own name wins over what is typed in the search.
		choice(f.view.el, "create").click();
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("Draft agent");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("sends to the selected group only on the first message and blocks duplicate sends", async () => {
		const pending = deferred<string>(),
			startConversation = vi.fn(() => pending.promise);
		const other = { ...staff, id: id(92), displayName: "Second agent" };
		const f = setupNew({ startConversation }, [staff, other]);
		f.company.store.set({ team });
		await settle();
		input(f.view.el, "Message", "Work together on this");
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		choice(f.view.el, staff.id).click();
		choice(f.view.el, other.id).click();
		expect(startConversation).not.toHaveBeenCalled();
		const message = f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
		message.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		message.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
		expect(startConversation).not.toHaveBeenCalled();
		press(message, "Enter");
		button(f.view.el, "Send message").click();
		expect(startConversation).toHaveBeenCalledExactlyOnceWith(
			[staff.id, other.id],
			"Work together on this",
			expect.any(AbortSignal),
		);
		expect(message.disabled).toBe(true);
		pending.resolve(id(95));
		await settle();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/chat/${id(95)}`);
	});
	it("preserves recipients and text on preparation failure and blocks send after permission loss", async () => {
		const startConversation = vi
			.fn()
			.mockRejectedValue(new Error("Connect a model account to start a conversation."));
		const f = setupNew({ startConversation });
		f.company.store.set({ team });
		await settle();
		choice(f.view.el, staff.id).click();
		input(f.view.el, "Message", "Keep this draft");
		button(f.view.el, "Send message").click();
		await settle();
		expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Keep this draft");
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(1);
		expect(f.view.el.textContent).toContain("Connect a model account");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		await settle();
		expect(button(f.view.el, "Send message").disabled).toBe(true);
		button(f.view.el, "Send message").click();
		expect(startConversation).toHaveBeenCalledTimes(1);
	});
	it("returns a created agent to the recipients and preserves the message through setup and cancel", async () => {
		const created = { ...staff, id: id(92), displayName: "New agent" };
		const createAgent = vi.fn().mockResolvedValue(created.id);
		const f = setupNew({ createAgent });
		f.company.store.set({ team });
		vi.mocked(f.api.listStaff).mockResolvedValue([staff, created]);
		await settle();
		choice(f.view.el, staff.id).click();
		input(f.view.el, "Message", "Our shared task");
		choice(f.view.el, "create").click();
		button(f.view.el, "Cancel").click();
		expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Our shared task");
		choice(f.view.el, "create").click();
		input(f.view.el, "Agent name", "New agent");
		input(f.view.el, "Agent title", "Research");
		const originalHash = location.hash;
		vi.mocked(f.api.listStaff).mockRejectedValueOnce(new Error("Roster unavailable"));
		f.view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		expect(f.view.el.textContent).toContain("The agent was created");
		f.view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(location.hash).toBe(originalHash);
		expect(f.view.el.querySelectorAll(".recipient-chip")).toHaveLength(2);
		expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Our shared task");
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Message");
	});

	it.each(["Back", "Cancel"])(
		"retains a created agent across %s and reopening after a failed roster refresh",
		async (leave) => {
			const created = { ...staff, id: id(92), displayName: "New agent" };
			const createAgent = vi.fn().mockResolvedValue(created.id);
			const f = setupNew({ createAgent });
			f.company.store.set({ team });
			vi.mocked(f.api.listStaff)
				.mockResolvedValue([staff, created])
				.mockRejectedValueOnce(new Error("Roster unavailable"));
			await settle();
			input(f.view.el, "Message", "Keep our task");
			input(f.view.el, "Search conversation recipients", "New agent");
			choice(f.view.el, "create").click();
			input(f.view.el, "Agent title", "Research");
			button(f.view.el, "Create agent").click();
			await settle();
			expect(f.view.el.textContent).toContain("The agent was created");
			button(f.view.el, leave).click();
			input(f.view.el, "Search conversation recipients", "Another agent");
			choice(f.view.el, "create").click();
			expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("New agent");
			expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
			button(f.view.el, "Add created agent").click();
			await settle();
			expect(createAgent).toHaveBeenCalledTimes(1);
			expect(f.view.el.querySelector(`[data-remove-recipient="${created.id}"]`)).not.toBeNull();
			expect(f.view.el.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.value).toBe("Keep our task");
			// Successful recovery clears the identity and draft for the next new agent.
			choice(f.view.el, "create").click();
			expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')?.value).toBe("");
			expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
			expect(button(f.view.el, "Create agent").disabled).toBe(false);
		},
	);

	it("styles the New agent form with rules of its own", async () => {
		const style = document.createElement("style");
		style.textContent = [tokensCss, conversationCss, appCss].join("\n").replace(/^@import .*;$/gm, "");
		document.head.append(style);
		try {
			const f = setupNew();
			f.company.store.set({ team });
			await settle();
			choice(f.view.el, "create").click();
			const fields = f.view.el.querySelector<HTMLFieldSetElement>("form fieldset")!;
			// A cleanup of other editors' styles once left this form with the
			// browser's fieldset box and page-sized labels.
			expect(getComputedStyle(fields).display).toBe("grid");
			expect(getComputedStyle(fields).borderTopWidth).toBe("0px");
			expect(getComputedStyle(fields.querySelector("label")!).fontSize).toBe("12px");
		} finally {
			style.remove();
		}
	});
	it("does not duplicate creation or navigate when an injected creation finishes after disposal", async () => {
		const result = deferred<string>(),
			createAgent = vi.fn(() => result.promise);
		const f = setupNew({ createAgent });
		f.company.store.set({ team });
		await settle();
		choice(f.view.el, "create").click();
		input(f.view.el, "Agent name", "New agent");
		input(f.view.el, "Agent title", "Research");
		for (let index = 0; index < 2; index++)
			f.view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		expect(createAgent).toHaveBeenCalledTimes(1);
		const originalHash = location.hash;
		f.view.dispose();
		result.resolve(id(70));
		await settle();
		expect(location.hash).toBe(originalHash);
		expect(f.api.listStaff).not.toHaveBeenCalled();
	});
});

describe("messages between two agents (contract 14.6)", () => {
	it("shows a chip for a coworker's message and opens the two agents' view-only transcript from it", async () => {
		const f = setup();
		const coworker = { ...staff, id: id(97), displayName: "Helper" };
		f.company.store.set({ staff: [staff, coworker] });
		const pairSessionId = id(98);
		// The thread's own first load finishes before the test supplies its projection.
		await f.company.loadConversation(session.sessionId);
		f.company.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "peer_link",
						id: id(96),
						sequence: 1,
						direction: "in",
						counterpartStaffId: coworker.id,
						pairSessionId,
						createdAt: timestamp,
					},
					{
						kind: "note",
						id: id(95),
						sequence: 2,
						text: "This exchange paused after 6 messages.",
						createdAt: timestamp,
					},
					{
						kind: "peer_link",
						id: id(89),
						sequence: 3,
						direction: "out",
						held: true,
						counterpartStaffId: coworker.id,
						pairSessionId,
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 3,
			},
		});
		f.view.update();
		const chips = f.view.el.querySelectorAll<HTMLButtonElement>(".peer-chip");
		const chip = chips[0]!;
		// Verb, the coworker's figure, then the name: the figure sits between the two spans.
		expect([...chip.querySelectorAll(":scope > span:not(.figure)")].map((span) => span.textContent)).toEqual([
			"Message from",
			"Helper",
		]);
		expect(chip.querySelector(".figure")?.previousElementSibling?.textContent).toBe("Message from");
		expect(chip.getAttribute("aria-label")).toBe("Message from Helper. Open the conversation");
		expect(chips[1]?.getAttribute("aria-label")).toBe("Left a note for Helper. Open the conversation");
		expect(f.view.el.querySelector(".conversation-note")?.textContent).toBe("This exchange paused after 6 messages.");
		expect(f.view.el.querySelector(".pair-transcript")).toBeNull();
		chip.click();
		await settle();
		// The transcript itself (loaded after the panel opened): the coworker's message under its name, nothing to type into.
		f.company.conversation(pairSessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "agent",
						id: id(94),
						sequence: 1,
						text: "Jonas created you and asked me to pass this along: he approves of you. Welcome.",
						attachmentCount: 0,
						phase: "final",
						runId: id(93),
						staffSpeaker: { runId: id(93), staffAgentId: coworker.id, staffVersion: 1, displayName: "Helper" },
						createdAt: timestamp,
					},
					{
						kind: "agent",
						id: id(92),
						sequence: 2,
						text: "FYI: the note is updated.",
						attachmentCount: 0,
						phase: "final",
						runId: id(91),
						held: true,
						staffSpeaker: {
							runId: id(91),
							staffAgentId: staff.id,
							staffVersion: 1,
							displayName: staff.displayName,
						},
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 2,
			},
		});
		await settle();
		const panel = f.view.el.querySelector<HTMLElement>(".pair-transcript")!;
		expect(panel).not.toBeNull();
		expect(panel.querySelector(".pair-header")?.textContent).toBe(`${staff.displayName}⇄Helper`);
		expect(panel.querySelector(".message-author")?.textContent).toBe("Helper");
		// The coworker speaks from the left, this thread's own agent from the right.
		const rows = panel.querySelectorAll<HTMLElement>(".pair-row");
		expect(rows[0]?.classList.contains("pair-row-right")).toBe(false);
		expect(rows[1]?.classList.contains("pair-row-right")).toBe(true);
		expect(rows[1]?.querySelector(".message-author")?.textContent).toBe(staff.displayName);
		expect(panel.textContent).toContain("he approves of you");
		expect(panel.querySelector(".message-caption")?.textContent).toBe("Left for Helper's next turn");
		expect(panel.textContent).toContain("This chat is view-only");
		expect(panel.querySelector("textarea")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(true);
		button(panel, "Close Chat").click();
		expect(f.view.el.querySelector(".pair-transcript")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(false);
		expect(document.activeElement).toBe(chip);
	});
});
