import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget } from "typescript";
import { describe, expect, it } from "vitest";

const renderer = readFileSync(new URL("../userland/renderer.js", import.meta.url), "utf8");
const source = createSourceFile("renderer.js", renderer, ScriptTarget.ESNext, true, ScriptKind.JS);
const names = [
	"markVisibleConversationRead",
	"staffSidebarState",
	"staffActiveState",
	"staffActivity",
	"staffMotionState",
	"renderSidebarStatus",
	"syncAvatarReadState",
	"closeSettings",
	"rememberRoom",
	"wireAvatarRadios",
];
const handlers = source.statements.filter(
	(node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
);
if (handlers.length !== names.length) throw new Error("Avatar renderer fixture is incomplete");

// Preserve the distinction between text nodes and element children: the
// sidebar reuses a plain-text preview node when it switches to animated text.
class StatusElement {
	childNodes: (StatusElement | { textContent: string })[] = [];
	dataset: Record<string, string> = {};
	attributes = new Map<string, string>();
	classList = new Set<string>();
	className = "";
	style = { setProperty() {} };

	get children(): StatusElement[] {
		return this.childNodes.filter((node): node is StatusElement => node instanceof StatusElement);
	}
	get firstElementChild(): StatusElement | null {
		return this.children[0] ?? null;
	}
	get lastElementChild(): StatusElement | null {
		return this.children.at(-1) ?? null;
	}
	get textContent(): string {
		return this.childNodes.map((node) => node.textContent).join("");
	}
	set textContent(value: string) {
		this.childNodes = value ? [{ textContent: value }] : [];
	}
	append(...nodes: (StatusElement | { textContent: string })[]) {
		this.childNodes.push(...nodes);
	}
	replaceChildren(...nodes: (StatusElement | { textContent: string })[]) {
		this.childNodes = nodes;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
}

function harness() {
	const flags = { needsYou: false, focused: true, visible: true, modalVisible: false };
	const frames: Array<() => void> = [];
	const listeners = new Map<string, () => void>();
	const bubble = {
		dataset: { replyTime: "123", replyPreview: "All done", roomMessageId: "reply-1" },
		getBoundingClientRect: () => ({ top: flags.visible ? 20 : 110, bottom: flags.visible ? 50 : 140, height: 30 }),
	};
	const elements = {
		staffModal: { hidden: true },
		messages: { querySelectorAll: () => [bubble], getBoundingClientRect: () => ({ top: 0, bottom: 100 }) },
		input: { offsetParent: {}, focus() {} },
		settingsView: {
			inert: false,
			contains: () => false,
			classList: {
				remove() {
					flags.modalVisible = false;
				},
			},
			setAttribute() {},
		},
	};
	const context = createContext({
		window: { qorpera: { setSettingsOverlayActive() {} } },
		HTMLElement: StatusElement,
		settingsRenderVersion: 0,
		settingsReturnFocus: null,
		currentView: "chat",
		currentRoomId: null,
		currentStaffId: "agent-a",
		currentSession: "session-a",
		agentSettingsOpen: false,
		agentSettingsFullscreen: false,
		avatarReadFrame: null,
		requestAnimationFrame: (callback: () => void) => frames.push(callback),
		avatarActionPhase: "",
		pendingToolLines: [],
		roomActivity: new Map(),
		hostedStaffActivity: new Map(),
		remoteStaffActivity: new Map(),
		pendingSessionQueueByStaff: new Map(),
		recentRoomWrites: new Map(),
		state: { rooms: [] },
		document: {
			hidden: false,
			hasFocus: () => flags.focused,
			activeElement: null,
			addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
			querySelectorAll: (selector: string) => {
				expect(selector).toBe('[aria-modal="true"]');
				return [{ getClientRects: () => (flags.modalVisible ? [{ width: 600, height: 400 }] : []) }];
			},
			createElement: () => new StatusElement(),
			createTextNode: (textContent: string) => ({ textContent }),
		},
		$: (id: keyof typeof elements) => elements[id],
		flags,
		currentRoom: () => null,
		currentStaff: () => ({ id: "agent-a" }),
		staffId: (staff: { id: string }) => staff.id,
		staffRuntime: () => null,
		staffNeedsAttention: () => flags.needsYou,
		currentCloudSessionRunState: () => null,
		staffLastReply: () => ({
			file: "session-a",
			lastAssistantMessage: { id: "reply-1", timestamp: 123, text: "All done" },
		}),
		staffLastMessage: () => ({ text: "All done" }),
	});
	runInContext(readFileSync(new URL("../userland/avatars/avatar-state.js", import.meta.url), "utf8"), context);
	runInContext(readFileSync(new URL("../userland/avatars/status-text.js", import.meta.url), "utf8"), context);
	runInContext(
		`
		const receipts = window.QORPERA_AVATAR_STATE.readReceipts({ getItem: () => null, setItem: () => {} }, 'test');
		const staffReceipts = () => receipts;
		${handlers.map((node) => node.getText(source)).join("\n")}
	`,
		context,
	);
	context.syncVisibleStaffAvatars = () => runInContext("markVisibleConversationRead()", context);
	const focusBinding = source.statements.find(
		(node) => node.getText(source) === 'document.addEventListener("focusin", syncAvatarReadState);',
	);
	if (focusBinding) runInContext(focusBinding.getText(source), context);
	return {
		flags,
		frames,
		listeners,
		bubble,
		elements,
		context,
		run: (code: string): unknown => runInContext(code, context),
	};
}

describe("production avatar and sidebar integration", () => {
	it("does not clear New on data arrival, hidden windows, or offscreen replies", () => {
		const { run, flags, bubble, elements, context } = harness();
		const unread = () => run("staffSidebarState(currentStaff()).text");
		expect(unread()).toBe("New");
		flags.focused = false;
		run("markVisibleConversationRead()");
		expect(unread()).toBe("New");
		flags.focused = true;
		flags.visible = false;
		run("markVisibleConversationRead()");
		expect(unread()).toBe("New");
		flags.visible = true;
		context.document.hidden = true;
		run("markVisibleConversationRead()");
		expect(unread()).toBe("New");
		context.document.hidden = false;
		elements.staffModal.hidden = false;
		run("markVisibleConversationRead()");
		expect(unread()).toBe("New");
		elements.staffModal.hidden = true;
		bubble.dataset.replyPreview = "A previous result";
		run("markVisibleConversationRead()");
		expect(unread()).toBe("New");
		bubble.dataset.replyPreview = "All done";
		context.currentSession = "different-session";
		run("markVisibleConversationRead()");
		expect(unread()).toBe("New");
		context.currentSession = "session-a";
		run("markVisibleConversationRead()");
		expect(unread()).toBe("All done");
		flags.needsYou = true;
		expect(unread()).toBe("Needs you");
	});

	it.each(["direct chat", "room"])("keeps %s replies unread behind a modal until it closes", (kind) => {
		const { run, flags, frames, listeners } = harness();
		const receipt = kind === "room" ? ["room:room-a", "reply-1"] : ["agent-a", "session-a:reply-1"];
		if (kind === "room") {
			run("currentRoomId = 'room-a'; currentRoom = () => ({id:'room-a', lastStaffMessage:{id:'reply-1'}})");
		}
		const unread = () => run(`receipts.unread(${JSON.stringify(receipt[0])}, ${JSON.stringify(receipt[1])})`);
		flags.modalVisible = true;
		run("markVisibleConversationRead()");
		expect(unread()).toBe(true);
		// Closing the modal queues a visibility recheck; coalesced focus events
		// must not wait for another backend update to acknowledge the reply.
		flags.modalVisible = false;
		expect(listeners.has("focusin")).toBe(true);
		listeners.get("focusin")?.();
		listeners.get("focusin")?.();
		expect(frames).toHaveLength(1);
		frames.shift()?.();
		expect(unread()).toBe(false);
	});

	it("rechecks visible replies when Settings closes without another backend update", () => {
		const { run, flags, frames, elements } = harness();
		flags.modalVisible = true;
		run("markVisibleConversationRead()");
		expect(run("staffSidebarState(currentStaff()).text")).toBe("New");
		run("closeSettings()");
		expect(elements.settingsView.inert).toBe(true);
		expect(frames).toHaveLength(1);
		frames.shift()?.();
		expect(run("staffSidebarState(currentStaff()).text")).toBe("All done");
	});

	it("does not acknowledge replies covered by fullscreen agent settings", () => {
		const { run } = harness();
		run("agentSettingsOpen = true; agentSettingsFullscreen = true; markVisibleConversationRead()");
		expect(run("staffSidebarState(currentStaff()).text")).toBe("New");
		run("agentSettingsFullscreen = false; markVisibleConversationRead()");
		expect(run("staffSidebarState(currentStaff()).text")).toBe("All done");
	});

	it.each([
		{ kind: "quiet", text: "The previous reply" },
		{ kind: "new", text: "New" },
		{ kind: "attention", text: "Needs you" },
	])("replaces $kind sidebar text when work starts without rebuilding the row", (previous) => {
		const { run, context } = harness();
		const element = new StatusElement();
		context.subtitle = element;
		context.previous = previous;
		run("renderSidebarStatus(subtitle, previous)");
		expect(element.textContent).toBe(previous.text);
		for (const text of ["Working", "Writing", "Using computer"]) {
			run(`renderSidebarStatus(subtitle, {kind:'working', text:${JSON.stringify(text)}})`);
			expect(element.textContent).toBe(text);
			expect(element.childNodes).toHaveLength(2);
			expect(element.dataset.live).toBe("true");
			expect(element.attributes.get("aria-label")).toBe(text);
		}
		const lead = element.firstElementChild;
		run("renderSidebarStatus(subtitle, {kind:'working', text:'Using computer'})");
		expect(element.firstElementChild).toBe(lead);
		run("renderSidebarStatus(subtitle, {kind:'quiet', text:'Done'})");
		expect(element.textContent).toBe("Done");
		expect(element.children).toHaveLength(0);
		expect(element.dataset.live).toBe("false");
		expect(element.attributes.has("aria-label")).toBe(false);
		run("renderSidebarStatus(subtitle, {kind:'working', text:'Working'})");
		expect(element.textContent).toBe("Working");
	});

	it("preserves room previews when settings return only metadata", () => {
		const { run } = harness();
		expect(
			run(`
			state.rooms = [{id:'room-a', title:'Before', lastStaffMessage:{id:'reply-1'}}];
			rememberRoom({id:'room-a', title:'After'});
			state.rooms[0];
		`),
		).toEqual({ id: "room-a", title: "After", lastStaffMessage: { id: "reply-1" } });
	});

	it("preserves the completion pose through rail and header repainting", () => {
		const { run } = harness();
		expect(run("avatarActionPhase = 'complete'; staffMotionState(currentStaff())")).toBe("complete");
		expect(run("staffSidebarState(currentStaff()); staffMotionState(currentStaff())")).toBe("complete");
		expect(run("avatarActionPhase = ''; staffMotionState(currentStaff())")).toBe("still");
	});

	it("maps tools, typing, and an explicitly stopped cloud run to the shared status", () => {
		const { run } = harness();
		expect(
			run(`
			avatarActionPhase = 'working'; pendingToolLines.push({toolName:'browser_click'});
			staffSidebarState(currentStaff());
		`),
		).toMatchObject({ text: "Using computer", badge: "active", computer: true });
		expect(run(`avatarActionPhase = 'writing'; staffSidebarState(currentStaff());`)).toMatchObject({
			text: "Writing",
			badge: "active",
			computer: false,
		});
		expect(
			run(`
			avatarActionPhase = ''; pendingToolLines = []; hostedStaffActivity.set('agent-a', {activity:'working'});
			currentCloudSessionRunState = () => ({healthy:true,run:null}); staffActiveState(currentStaff());
		`),
		).toBe("");
		expect(
			run(`roomActivity.set('room-a', new Map([['agent-a','web_search']])); staffActivity(currentStaff());`),
		).toMatchObject({ text: "Searching the web", state: "working" });
	});

	it("keeps figure selection keyboard-operable while skipping disabled choices", () => {
		const { run } = harness();
		expect(
			run(`
			let clicks = [];
			const buttons = Array.from({length:7}, (_, index) => ({
				disabled: index === 1, getAttribute: () => index === 0 ? 'true' : 'false',
				focus() { document.activeElement = this; }, click() { clicks.push(index); }
			}));
			const group = {querySelectorAll: () => buttons}; wireAvatarRadios(group);
			buttons[0].focus();
			for (const key of ['ArrowRight', 'End', 'ArrowRight', 'ArrowLeft', 'Home']) group.onkeydown({key, preventDefault() {}});
			({clicks, tabs:buttons.map(button => button.tabIndex)});
		`),
		).toEqual({ clicks: [2, 6, 0, 6, 0], tabs: [0, -1, -1, -1, -1, -1, -1] });
	});

	it("keeps selectors compact, pinned art full-size, and hover captions unboxed and stationary", () => {
		const css = readFileSync(new URL("../userland/avatars/avatar-system.css", import.meta.url), "utf8");
		expect(css).toContain("grid-template-columns: repeat(7, minmax(0, 1fr))");
		expect(css).toContain(
			"#staffNavigation .staff-pinned-grid .staff-pinned-card .staff-avatar { width: 64px; height: 64px; }",
		);
		expect(css).toContain(
			"body.rail-compact #staffNavigation .staff-pinned-grid .staff-pinned-card .staff-avatar { width: 42px; height: 42px; }",
		);
		expect(css).toMatch(/\.agent-thread-activity \{[^}]*background: none;[^}]*box-shadow: none;/s);
		expect(css).toContain("avatar-ink-wave 1400ms");
		const wave = css.slice(css.indexOf("@keyframes avatar-ink-wave"), css.indexOf("@media (prefers-reduced-motion"));
		expect(wave).not.toMatch(/transform|translate|font-size/);
		expect(wave).toContain("text-shadow");
	});
});
