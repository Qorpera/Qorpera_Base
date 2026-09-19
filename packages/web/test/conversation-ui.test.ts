// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { CompanyController } from "../src/app/company.ts";
import { parseRoute } from "../src/app/router.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
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
		expect(field("Agent description").value).toBe(staff.charter);
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
		const pending = deferred<void>(),
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
		pending.resolve();
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
		expect(fetch).not.toHaveBeenCalled();
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
	it("shows unavailable computer controls without RPCs, handles narrow layouts, and restores focus", () => {
		// jsdom lays nothing out: give the thread the width the window and the rail leave it.
		let threadWidth = 900;
		vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
			return this.classList.contains("thread-body") ? threadWidth : 0;
		});
		const f = setup(),
			toggle = button(f.view.el, "Open agent computer");
		toggle.click();
		expect(f.view.el.querySelector(".computer-panel")?.textContent).toContain("Computer unavailable");
		// Routines live in the agent's details now, not beside the computer.
		expect(f.view.el.querySelector(".computer-panel")?.textContent).not.toContain("Routines");
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(false);
		// Without room for the panel beside the conversation, however wide the rail is, the panel covers it.
		threadWidth = 735;
		window.dispatchEvent(new Event("qorpera-rail-resize"));
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(true);
		expect(f.view.el.querySelector(".thread-body")?.classList.contains("computer-covers")).toBe(true);
		button(f.view.el, "Close computer").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(f.view.el.querySelector(".computer-panel")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-conversation")?.inert).toBe(false);
		expect(document.activeElement).toBe(toggle);
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
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
	it("opens an agent's conversation straight from the list, the Co-Founder at home", async () => {
		const other = { ...staff, id: id(92), displayName: "Second agent", role: "Research" },
			cofounder = { ...staff, id: id(93), displayName: "Co-Founder", templateId: "co-founder" };
		const f = setupNew({}, [cofounder, staff, other]);
		await settle();
		f.search.focus();
		choice(f.view.el, other.id).click();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${other.id}`);
		choice(f.view.el, cofounder.id).click();
		expect(location.hash).toBe(`#/c/${profileA.profileId}`);
		input(f.view.el, "Search conversation recipients", "fixture");
		expect(choices(f.view.el)).toEqual(["create", "group", staff.id]);
		// Typing highlights the first match, so Enter opens it.
		expect(f.search.getAttribute("aria-activedescendant")).toBe(choice(f.view.el, staff.id).id);
		expect(press(f.search, "Enter").defaultPrevented).toBe(true);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${staff.id}`);
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
		expect(choices(f.view.el)).toEqual(["start", staff.id, other.id]);
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
		expect(choice(f.view.el, "create").getAttribute("aria-selected")).toBe("true");
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
