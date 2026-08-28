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
	"rememberRoom",
	"wireAvatarRadios",
];
const handlers = source.statements.filter(
	(node) => isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
);
if (handlers.length !== names.length) throw new Error("Avatar renderer fixture is incomplete");

function harness() {
	const flags = { needsYou: false, focused: true, visible: true };
	const bubble = {
		dataset: { replyTime: "123", replyPreview: "All done", roomMessageId: "reply-1" },
		getBoundingClientRect: () => ({ top: flags.visible ? 20 : 110, bottom: flags.visible ? 50 : 140, height: 30 }),
	};
	const elements = {
		staffModal: { hidden: true },
		messages: { querySelectorAll: () => [bubble], getBoundingClientRect: () => ({ top: 0, bottom: 100 }) },
	};
	const context = createContext({
		window: {},
		currentView: "chat",
		currentRoomId: null,
		currentStaffId: "agent-a",
		currentSession: "session-a",
		avatarActionPhase: "",
		pendingToolLines: [],
		roomActivity: new Map(),
		hostedStaffActivity: new Map(),
		remoteStaffActivity: new Map(),
		pendingSessionQueueByStaff: new Map(),
		recentRoomWrites: new Map(),
		state: { rooms: [] },
		document: { hidden: false, hasFocus: () => flags.focused, activeElement: null },
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
	runInContext(
		`
		const receipts = window.QORPERA_AVATAR_STATE.readReceipts({ getItem: () => null, setItem: () => {} }, 'test');
		const staffReceipts = () => receipts;
		${handlers.map((node) => node.getText(source)).join("\n")}
	`,
		context,
	);
	return { flags, bubble, elements, context, run: (code: string): unknown => runInContext(code, context) };
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
