// @vitest-environment jsdom
import type {
	CompanyComputerMemberStatus,
	CompanyComputerMemberView,
} from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPanel, ComputerPanels } from "../src/app/views/computer.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import { DEFAULT_CLOUD_CONFIG, readCloudConfigOverride, writeCloudConfigOverride } from "../src/cloud/config.ts";
import * as viewer from "../src/ui/computer-viewer.ts";
import { deferred, fixture, id, profileA, settle, staff, userA, userB } from "./fixtures.ts";

const scope = {
	companyId: profileA.profileId,
	environmentId: profileA.environmentId,
	companyComputerId: id(30),
	logicalComputerId: id(31),
};
const binding = {
	...scope,
	computerGeneration: 1,
	screenId: id(32),
	screenGeneration: 1,
	screenOrdinal: 1,
	staffAgentId: staff.id,
};
const catalog = {
	companyId: profileA.profileId,
	environmentId: profileA.environmentId,
	scope,
	canManage: true,
	staff: [{ staffAgentId: staff.id, name: staff.displayName }],
	nextAfter: null,
};
const start = { scope, computerGeneration: 1, officeState: "active", intent: null };
const status: CompanyComputerMemberStatus = {
	scope,
	computerGeneration: 1,
	state: "active",
	maintenance: null,
	privacyState: "shared",
	privacyVersion: 0,
	screens: [{ binding, epoch: 0, drainPending: false, driver: "idle", takeoverMemberId: null }],
	viewers: [],
};
const intent = {
	schema: "qorpera.office-start-intent/v1" as const,
	intentId: id(71),
	companyComputerId: scope.companyComputerId,
	computerGeneration: 1,
	state: "requested" as const,
};
const START_WRITES = /\/(?:qorpera_request_runtime_office_start|qorpera_cancel_runtime_office_start)$/;
const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	document.body.replaceChildren();
});
function setup(overrides: Record<string, unknown> = {}, memberRole: typeof profileA.role = profileA.role) {
	const f = fixture(),
		stop = new AbortController();
	f.cloud.config.officeViewerOrigin = "wss://viewer.example.invalid";
	const replies: Record<string, unknown> = {
		qorpera_member_office_catalog: catalog,
		qorpera_runtime_office_start_status: start,
		qorpera_runtime_office_member_status: status,
		qorpera_open_runtime_office_screen: { state: "open" },
		...overrides,
	};
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const method = String(input).split("/").at(-1)!;
		expect(init?.redirect).toBe("error");
		if (!(method in replies)) throw new Error("Unexpected network request");
		return Response.json(replies[method]);
	});
	vi.stubGlobal("fetch", fetch);
	const computer = new WebCompanyComputer(f.cloud, { ...profileA, role: memberRole }, userA.id, stop.signal, () => {});
	cleanup.push(() => stop.abort());
	return { ...f, stop, computer, fetch, replies };
}
function panel(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = new ComputerPanel(staff, computer, signal);
	value.attach(document.body, () => value.dispose());
	cleanup.push(() => value.dispose());
	return value;
}
/** Allow the automatic open flow to reach its next waiting state. */
async function opened(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = panel(computer, signal);
	await settle();
	await settle();
	await settle();
	return value;
}
function action(root: HTMLElement, label: string) {
	const result = [...root.querySelectorAll("button")].find((button) => button.textContent === label);
	if (!result) throw new Error(`Missing ${label}: ${root.textContent}`);
	return result;
}
function methods(f: ReturnType<typeof setup>) {
	return f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1));
}
function statusLine(p: ComputerPanel) {
	return p.el.querySelector("[role=status]")?.textContent;
}
/** One 3000 ms poll of the open flow. */
async function poll() {
	await vi.advanceTimersByTimeAsync(3000);
	await settle();
}
function spyStart(f: ReturnType<typeof setup>) {
	const startClient = f.computer.client.start(scope);
	vi.spyOn(f.computer.client, "start").mockReturnValue(startClient);
	return startClient;
}
function spyViewer(close = vi.fn(async () => {})) {
	return vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close });
}

describe("automatic computer popover", () => {
	it("shows loading immediately and opens the agent screen without a second action", async () => {
		const f = setup(),
			open = spyViewer(),
			p = panel(f.computer);
		expect(p.el.querySelector(".computer-loading")).not.toBeNull();
		expect(p.el.querySelector(".computer-loading-spinner")).not.toBeNull();
		expect(p.el.querySelector("header, select, .computer-preview, .figure")).toBeNull();
		expect(p.el.textContent).not.toContain("Open computer");
		// The X top right is there from the start: a preview stuck on "Connecting…" can be put away too.
		expect(p.el.querySelector("button.computer-close[aria-label='Close computer']")).not.toBeNull();
		expect(p.el.tabIndex).toBe(0);
		await settle();
		await settle();
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				binding,
				mount: p.el.querySelector(".computer-panel-body"),
				autofocus: false,
				canControl: true,
				sharedControl: true,
			}),
		);
		expect(methods(f)).toEqual([
			"qorpera_member_office_catalog",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
		expect(methods(f).some((method) => START_WRITES.test(`/${method}`))).toBe(false);
		expect(p.el.querySelector<HTMLElement>(".computer-loading")?.hidden).toBe(true);
		open.mock.calls[0]![0].onClosed();
		expect(p.el.isConnected).toBe(false);
	});
	it("forgets a press's pointer focus when a thread detaches the panel", () => {
		const f = setup(),
			p = panel(f.computer);
		document.body.append(p.el);
		// jsdom has no pointer capture; the drag code takes it on every press.
		p.el.setPointerCapture = vi.fn();
		p.el.hasPointerCapture = vi.fn(() => false);
		p.el.releasePointerCapture = vi.fn();
		p.el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
		expect(document.activeElement).toBe(p.el);
		expect(p.el.classList.contains("is-pointer-focus")).toBe(true);
		// Removal takes focus without a focusout in every browser; the mark must not outlive the thread.
		p.detach();
		expect(p.el.classList.contains("is-pointer-focus")).toBe(false);
	});
	it("closes for good from the X top right, and not before a thread holds it", async () => {
		const f = setup(),
			open = spyViewer(),
			p = panel(f.computer);
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		const close = vi.fn();
		p.detach();
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		expect(close).not.toHaveBeenCalled();
		const body = document.createElement("div");
		document.body.append(body);
		p.attach(body, close);
		p.el.querySelector<HTMLButtonElement>(".computer-close")!.click();
		expect(close).toHaveBeenCalledOnce();
		body.remove();
	});
	it("keeps unavailable and missing computers inside the popover without starting a runtime", async () => {
		const unavailable = new ComputerPanel(staff);
		cleanup.push(() => unavailable.dispose());
		expect(statusLine(unavailable)).toBe("Computer access is not available yet.");
		const f = setup({ qorpera_member_office_catalog: { ...catalog, scope: null } });
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("This company has no computer yet.");
		expect(methods(f)).toEqual(["qorpera_member_office_catalog"]);
		expect(p.el.textContent).not.toContain("Open computer");
	});
	it("offers retry after a failed read and opens automatically after retry succeeds", async () => {
		const f = setup(),
			open = spyViewer();
		delete f.replies.qorpera_runtime_office_start_status;
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
		const retry = action(p.el, "Try again");
		expect(retry.hidden).toBe(false);
		expect(open).not.toHaveBeenCalled();
		f.replies.qorpera_runtime_office_start_status = start;
		retry.focus();
		retry.click();
		expect(document.activeElement).toBe(p.el);
		retry.click();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("does not interrupt typing when delayed discovery completes", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberStatus>(),
			open = spyViewer();
		const views = f.computer.views(scope);
		vi.spyOn(views, "status").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		await opened(f.computer);
		const composer = document.createElement("textarea");
		document.body.append(composer);
		composer.focus();
		composer.value = "Keep writing while the screen opens";
		composer.setSelectionRange(5, 12);
		pending.resolve(status);
		await settle();
		await settle();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ autofocus: false }));
		expect(document.activeElement).toBe(composer);
		expect(composer.selectionStart).toBe(5);
		expect(composer.selectionEnd).toBe(12);
	});
	it("closing with Escape cancels polling without cancelling the runtime", async () => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "maintenance" } });
		const startClient = spyStart(f),
			cancel = vi.spyOn(startClient, "cancel");
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("The computer is restarting. It comes back on its own.");
		p.focus();
		expect(document.activeElement).toBe(p.el);
		p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(p.el.isConnected).toBe(false);
		const requests = methods(f);
		await poll();
		await poll();
		expect(methods(f)).toEqual(requests);
		expect(cancel).not.toHaveBeenCalled();
	});
	it("captures fallback Escape before the remote canvas while forwarding other keys", async () => {
		const f = setup(),
			close = vi.fn(async () => {}),
			open = spyViewer(close),
			p = await opened(f.computer);
		const options = open.mock.calls[0]![0];
		expect(options.onExpandedChange).toBeTypeOf("function");
		const back = document.createElement("button");
		back.className = "screen-viewer-back";
		const returnToPreview = vi.fn(() => options.onExpandedChange?.(false));
		back.addEventListener("click", returnToPreview);
		const screen = document.createElement("canvas");
		const remoteKey = vi.fn((event: KeyboardEvent) => {
			// noVNC consumes keyboard input at the canvas instead of letting it bubble.
			event.preventDefault();
			event.stopPropagation();
		});
		screen.addEventListener("keydown", remoteKey);
		p.el.querySelector(".computer-panel-body")!.append(back, screen);
		options.onExpandedChange?.(true);
		expect(p.el.classList.contains("is-entered")).toBe(true);
		const typing = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
		screen.dispatchEvent(typing);
		expect(remoteKey).toHaveBeenCalledExactlyOnceWith(typing);
		expect(returnToPreview).not.toHaveBeenCalled();
		const dismiss = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		screen.dispatchEvent(dismiss);
		expect(dismiss.defaultPrevented).toBe(true);
		expect(remoteKey).toHaveBeenCalledTimes(1);
		expect(returnToPreview).toHaveBeenCalledOnce();
		expect(p.el.classList.contains("is-entered")).toBe(false);
		expect(p.el.isConnected).toBe(true);
		expect(close).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledTimes(1);
	});
	it("lets Escape leave fullscreen before a later Escape closes the computer", async () => {
		const f = setup(),
			close = vi.fn(async () => {}),
			open = spyViewer(close),
			p = await opened(f.computer);
		const screen = document.createElement("canvas");
		const remoteKey = vi.fn((event: KeyboardEvent) => event.stopPropagation());
		screen.addEventListener("keydown", remoteKey);
		p.el.querySelector(".computer-panel-body")!.append(screen);
		let fullscreenElement: Element | null = screen;
		const original = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
		Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
		try {
			const fullscreenEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			screen.dispatchEvent(fullscreenEscape);
			expect(fullscreenEscape.defaultPrevented).toBe(false);
			expect(remoteKey).toHaveBeenCalledExactlyOnceWith(fullscreenEscape);
			expect(p.el.isConnected).toBe(true);
			expect(open).toHaveBeenCalledTimes(1);
			expect(close).not.toHaveBeenCalled();
			fullscreenElement = null;
			const dismiss = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			screen.dispatchEvent(dismiss);
			await settle();
			expect(dismiss.defaultPrevented).toBe(true);
			expect(remoteKey).toHaveBeenCalledTimes(1);
			expect(p.el.isConnected).toBe(false);
			expect(close).toHaveBeenCalledOnce();
		} finally {
			if (original) Object.defineProperty(document, "fullscreenElement", original);
			else Reflect.deleteProperty(document, "fullscreenElement");
		}
	});
	it("makes covered conversation controls inert only while entered and restores them on Back or disposal", async () => {
		const f = setup(),
			open = spyViewer(),
			p = await opened(f.computer);
		const thread = document.createElement("section"),
			conversation = document.createElement("div"),
			header = document.createElement("header"),
			messages = document.createElement("div"),
			status = document.createElement("div"),
			composer = document.createElement("footer");
		conversation.className = "thread-conversation";
		header.className = "thread-header";
		composer.className = "composer";
		header.inert = false;
		messages.inert = false;
		status.inert = true;
		composer.inert = false;
		composer.append(document.createElement("textarea"));
		conversation.append(header, messages, status, composer);
		thread.append(conversation, p.el);
		document.body.append(thread);
		const options = open.mock.calls[0]![0];
		expect(composer.inert).toBe(false);
		options.onExpandedChange?.(true);
		expect(header.inert).toBe(false);
		expect(messages.inert).toBe(true);
		expect(composer.inert).toBe(true);
		options.onExpandedChange?.(true);
		options.onExpandedChange?.(false);
		expect(messages.inert).toBe(false);
		expect(composer.inert).toBe(false);
		expect(status.inert).toBe(true);
		options.onExpandedChange?.(true);
		p.dispose();
		expect(header.inert).toBe(false);
		expect(messages.inert).toBe(false);
		expect(composer.inert).toBe(false);
		expect(status.inert).toBe(true);
	});
	it("removes keyboard dismissal when the panel is disposed", async () => {
		const f = setup(),
			close = vi.fn(),
			p = new ComputerPanel(staff, f.computer);
		p.attach(document.body, close);
		p.dispose();
		const dismiss = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		p.el.dispatchEvent(dismiss);
		expect(dismiss.defaultPrevented).toBe(false);
		expect(close).not.toHaveBeenCalled();
	});
	it("keeps the screen connected while the member is in another thread and shows it again on return", async () => {
		const f = setup(),
			closeViewer = vi.fn(async () => {}),
			open = spyViewer(closeViewer),
			panels = new ComputerPanels(f.computer, f.stop.signal),
			first = document.createElement("div"),
			second = document.createElement("div");
		document.body.append(first, second);
		const p = panels.open(staff)!;
		const closeFirst = vi.fn();
		p.attach(first, closeFirst);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		expect(p.el.parentElement).toBe(first);
		const requests = f.fetch.mock.calls.length;
		// Leaving the thread hands the panel back; nothing is released, and it will not slide in again.
		expect(p.el.style.animation).toBe("");
		p.detach();
		expect(p.attached).toBe(false);
		expect(p.el.style.animation).toBe("none");
		expect(closeViewer).not.toHaveBeenCalled();
		expect(panels.get(staff.id)).toBe(p);
		await poll();
		expect(f.fetch.mock.calls.length).toBe(requests);
		// The next thread of this agent gets the same panel, same viewer: no new open flow.
		expect(panels.open(staff)).toBe(p);
		const closeSecond = vi.fn();
		p.attach(second, closeSecond);
		expect(p.el.parentElement).toBe(second);
		expect(open).toHaveBeenCalledOnce();
		expect(f.fetch.mock.calls.length).toBe(requests);
		expect(closeSecond).not.toHaveBeenCalled();
		// Closing through the registry ends the connection and forgets the panel.
		panels.close(staff.id);
		expect(closeViewer).toHaveBeenCalledOnce();
		expect(p.el.isConnected).toBe(false);
		expect(panels.get(staff.id)).toBeUndefined();
		const reopened = panels.open(staff);
		expect(reopened).not.toBe(p);
		panels.dispose();
	});
	it("routes the viewer's own close to the thread showing the panel now, not the one that was left", async () => {
		const f = setup(),
			open = spyViewer(),
			panels = new ComputerPanels(f.computer, f.stop.signal),
			p = panels.open(staff)!,
			closeFirst = vi.fn(),
			closeSecond = vi.fn();
		p.attach(document.body, closeFirst);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		p.detach();
		// Closed by the renderer while no thread shows it: nobody is told, nothing breaks.
		const second = document.createElement("div");
		document.body.append(second);
		p.attach(second, closeSecond);
		open.mock.calls[0]![0].onClosed();
		expect(closeFirst).not.toHaveBeenCalled();
		expect(closeSecond).toHaveBeenCalledOnce();
		panels.dispose();
	});
	it("returns an entered screen to a preview when its thread is left, and frees the thread it covered", async () => {
		const f = setup(),
			open = spyViewer(),
			p = await opened(f.computer),
			options = open.mock.calls[0]![0];
		const thread = document.createElement("div");
		thread.className = "thread-conversation";
		const composer = document.createElement("div");
		composer.inert = false;
		thread.append(composer);
		document.body.append(thread);
		options.onExpandedChange?.(true);
		expect(composer.inert).toBe(true);
		expect(p.el.classList.contains("is-entered")).toBe(true);
		p.detach();
		expect(composer.inert).toBe(false);
		expect(p.el.classList.contains("is-entered")).toBe(false);
	});
	it("ends every open computer when the company is left", async () => {
		const f = setup(),
			closeViewer = vi.fn(async () => {}),
			stop = new AbortController(),
			panels = new ComputerPanels(f.computer, stop.signal);
		spyViewer(closeViewer);
		const p = panels.open(staff)!;
		p.attach(document.body, () => panels.close(staff.id));
		await settle();
		await settle();
		await settle();
		p.detach();
		stop.abort();
		expect(closeViewer).toHaveBeenCalledOnce();
		expect(panels.get(staff.id)).toBeUndefined();
		// A registry whose company is gone opens nothing more.
		expect(panels.open(staff)).toBeUndefined();
	});
	it("gives the viewer a rename that lands while it is opening", async () => {
		const f = setup(),
			close = vi.fn(async () => {});
		let p: ComputerPanel | undefined;
		const open = vi.spyOn(viewer, "openComputerViewer").mockImplementation((options) => {
			// The rename lands after the title was handed over and before the heading exists.
			p?.retitle("Renamed");
			const overlay = document.createElement("div");
			overlay.className = "screen-viewer-overlay";
			overlay.setAttribute("aria-label", options.title);
			const heading = document.createElement("span");
			heading.className = "screen-viewer-heading";
			heading.append(document.createElement("span"));
			heading.firstElementChild!.textContent = options.title;
			overlay.append(heading);
			options.mount?.append(overlay);
			return { close };
		});
		p = panel(f.computer);
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		expect(open.mock.calls[0]![0].title).toBe(`${staff.displayName} · Computer`);
		const overlay = p.el.querySelector(".screen-viewer-overlay")!;
		expect(overlay.getAttribute("aria-label")).toBe("Renamed · Computer");
		expect(overlay.querySelector(".screen-viewer-heading > span")?.textContent).toBe("Renamed · Computer");
	});
	it("applies a rename made while no thread showed the panel when it is handed out again", async () => {
		const f = setup(),
			open = spyViewer(),
			panels = new ComputerPanels(f.computer, f.stop.signal),
			p = panels.open(staff)!;
		p.attach(document.body, () => {});
		await settle();
		await settle();
		await settle();
		expect(open).toHaveBeenCalledOnce();
		const overlay = document.createElement("div");
		overlay.className = "screen-viewer-overlay";
		overlay.setAttribute("aria-label", `${staff.displayName} · Computer`);
		p.el.querySelector(".computer-panel-body")!.append(overlay);
		p.detach();
		expect(panels.open({ ...staff, displayName: "Renamed" })).toBe(p);
		expect(overlay.getAttribute("aria-label")).toBe("Renamed · Computer");
		expect(open).toHaveBeenCalledOnce();
		panels.dispose();
	});
	it("follows a rename in place: same viewer, new title", async () => {
		const f = setup(),
			open = spyViewer(),
			p = await opened(f.computer);
		expect(open.mock.calls[0]![0].title).toBe(`${staff.displayName} · Computer`);
		const overlay = document.createElement("div");
		overlay.className = "screen-viewer-overlay";
		overlay.setAttribute("aria-label", `${staff.displayName} · Computer`);
		const heading = document.createElement("span");
		heading.className = "screen-viewer-heading";
		heading.append(document.createElement("span"), document.createElement("small"));
		heading.firstElementChild!.textContent = `${staff.displayName} · Computer`;
		overlay.append(heading);
		p.el.querySelector(".computer-panel-body")!.append(overlay);
		p.retitle("Renamed");
		expect(open).toHaveBeenCalledOnce();
		expect(overlay.getAttribute("aria-label")).toBe("Renamed · Computer");
		expect(heading.firstElementChild!.textContent).toBe("Renamed · Computer");
		expect(heading.lastElementChild!.textContent).toBe("");
	});
});

describe("web runtime member boundary", () => {
	it("explains read-only access without requesting an idle wake", async () => {
		const f = setup(
			{
				qorpera_member_office_catalog: { ...catalog, canManage: false },
				qorpera_runtime_office_start_status: {
					...start,
					officeState: "maintenance",
					intent,
					maintenance: {
						reason: "idle",
						state: "requested",
						transitionId: id(76),
						requestedAt: "2026-09-19T12:00:00Z",
						resumedAt: null,
						activatedAt: null,
					},
				},
			},
			"viewer",
		);
		const request = vi.spyOn(spyStart(f), "request");
		const open = spyViewer();
		const p = await opened(f.computer);
		await poll();
		expect(statusLine(p)).toBe(
			"You have read-only access. A company member with write access can wake the computer.",
		);
		expect(request).not.toHaveBeenCalled();
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ canControl: false }));
	});
	it.each([false, true])("wakes idle before screen discovery (screen request raced=%s)", async (duringScreenOpen) => {
		const f = setup();
		const startClient = spyStart(f);
		const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
		const views = f.computer.views(scope);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const enterIdle = () => {
			f.replies.qorpera_runtime_office_start_status = {
				...start,
				officeState: "maintenance",
				intent,
				maintenance: {
					reason: "idle",
					state: "requested",
					transitionId: id(77),
					requestedAt: "2026-09-19T12:00:00Z",
					resumedAt: null,
					activatedAt: null,
				},
			};
			f.replies.qorpera_runtime_office_member_status = { ...status, state: "maintenance", screens: [] };
		};
		if (duringScreenOpen) {
			f.replies.qorpera_runtime_office_member_status = { ...status, screens: [] };
			vi.spyOn(views, "openScreen").mockImplementationOnce(async () => {
				enterIdle();
				return { state: "refused", reason: "COMPUTER_NOT_ACTIVE" };
			});
		} else
			vi.spyOn(views, "status").mockImplementationOnce(async () => {
				enterIdle();
				return { ...status, state: "maintenance", screens: [] };
			});
		const open = spyViewer();
		const p = await opened(f.computer);
		await poll();
		expect(request).toHaveBeenCalledOnce();
		expect(statusLine(p)).toBe("Starting the computer…");
		f.replies.qorpera_runtime_office_start_status = start;
		f.replies.qorpera_runtime_office_member_status = status;
		await poll();
		await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding, sharedControl: true }));
	});
	it.each([false, true])(
		"automatically wakes idle maintenance when the panel opens (manager=%s)",
		async (canManage) => {
			const maintenance = {
				reason: "idle",
				state: "requested",
				transitionId: id(73),
				requestedAt: "2026-09-19T12:00:00Z",
				resumedAt: null,
				activatedAt: null,
			};
			const f = setup({
				qorpera_member_office_catalog: { ...catalog, canManage },
				qorpera_runtime_office_start_status: { ...start, officeState: "maintenance", maintenance, intent },
			});
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
			const open = spyViewer();
			const p = await opened(f.computer);
			await poll();
			expect(request).toHaveBeenCalledOnce();
			expect(statusLine(p)).toBe("Starting the computer…");
			await poll();
			expect(request).toHaveBeenCalledOnce();
			f.replies.qorpera_runtime_office_start_status = start;
			await poll();
			expect(open).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ sharedControl: true, canControl: canManage }),
			);
		},
	);
	it("wakes an office that idles between discovery and viewer connection", async () => {
		const f = setup();
		const startClient = spyStart(f);
		const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
		const views = f.computer.views(scope);
		const held = { connectionId: id(85), close: vi.fn(async () => {}) } as never;
		const connect = vi
			.spyOn(views, "connectScreen")
			.mockRejectedValueOnce(new Error("Office entered idle maintenance"))
			.mockResolvedValue(held);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const open = spyViewer();
		await opened(f.computer);
		f.replies.qorpera_runtime_office_start_status = {
			...start,
			officeState: "maintenance",
			intent,
			maintenance: {
				reason: "idle",
				state: "requested",
				transitionId: id(74),
				requestedAt: "2026-09-19T12:00:00Z",
				resumedAt: null,
				activatedAt: null,
			},
		};
		const connection = open.mock.calls[0]![0].requestConnection({ binding, mode: "shared", signal: f.stop.signal });
		await settle();
		for (let i = 0; i < 10; i++) await poll();
		expect(request).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledOnce();
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		await poll();
		await expect(connection).resolves.toBe(held);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it.each(["provisioning", "recovering"])("does not duplicate an existing %s start", async (officeState) => {
		for (const state of ["requested", "reserved"] as const) {
			const f = setup({
				qorpera_runtime_office_start_status: { ...start, officeState, intent: { ...intent, state } },
			});
			const startClient = spyStart(f),
				request = vi.spyOn(startClient, "request"),
				cancel = vi.spyOn(startClient, "cancel");
			const p = await opened(f.computer);
			expect(statusLine(p)).toBe("Starting the computer…");
			await poll();
			await poll();
			p.dispose();
			await settle();
			expect(request).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
		}
	});
	it.each(["provisioning", "recovering"])(
		"reuses one start identity after an ambiguous %s request",
		async (officeState) => {
			const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState } });
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockRejectedValue(new Error("Response lost"));
			const cancel = vi.spyOn(startClient, "cancel");
			const p = await opened(f.computer);
			expect(request).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledWith(1, expect.any(String), expect.any(AbortSignal));
			expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
			await poll();
			expect(request).toHaveBeenCalledTimes(1);
			const retry = action(p.el, "Try again");
			retry.click();
			retry.click();
			await settle();
			await settle();
			expect(request).toHaveBeenCalledTimes(2);
			expect(request.mock.calls[1]![1]).toBe(request.mock.calls[0]![1]);
			p.dispose();
			await settle();
			expect(cancel).not.toHaveBeenCalled();
		},
	);
	it("starts once, waits for an active runtime, then connects this agent's screen", async () => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" } });
		const request = vi.spyOn(spyStart(f), "request").mockResolvedValue(intent),
			open = spyViewer();
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Starting the computer…");
		await poll();
		await poll();
		expect(request).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		expect(request).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding }));
	});
	it.each([
		["provisioning", true],
		["recovering", true],
		["active", false],
		["maintenance", false],
		["retired", false],
	] as const)(
		"starts a %s runtime only when member capability and current intent allow it",
		async (officeState, eligibleState) => {
			for (const canManage of [true, false]) {
				for (const intentState of [null, "requested", "reserved", "cancelled"] as const) {
					const f = setup({
						qorpera_member_office_catalog: { ...catalog, canManage },
						qorpera_runtime_office_start_status: {
							...start,
							officeState,
							intent: intentState === null ? null : { ...intent, state: intentState },
						},
						qorpera_request_runtime_office_start: intent,
					});
					const open = spyViewer(),
						p = await opened(f.computer);
					await poll();
					const writes = methods(f).filter((method) => START_WRITES.test(`/${method}`));
					expect(writes).toEqual(
						canManage && eligibleState && intentState === null ? ["qorpera_request_runtime_office_start"] : [],
					);
					if (officeState === "active") {
						expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ canControl: canManage }));
					} else {
						expect(open).not.toHaveBeenCalled();
						expect(statusLine(p)).toBe(
							officeState === "maintenance"
								? "The computer is restarting. It comes back on its own."
								: officeState === "retired"
									? "This computer has been retired."
									: canManage
										? "Starting the computer…"
										: "The computer is off. An owner or admin can start it.",
						);
					}
					if (officeState === "retired") {
						const requests = methods(f);
						await poll();
						expect(methods(f)).toEqual(requests);
					}
					p.dispose();
					f.stop.abort();
					open.mockRestore();
				}
			}
		},
	);
	it("opens a missing screen once and only selects this agent's first available screen", async () => {
		const other = { ...status.screens[0]!, binding: { ...binding, staffAgentId: id(99) } };
		const f = setup({ qorpera_runtime_office_member_status: { ...status, screens: [other] } }),
			open = spyViewer();
		await opened(f.computer);
		await poll();
		await poll();
		const opens = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("qorpera_open_runtime_office_screen"));
		expect(opens).toHaveLength(1);
		expect(JSON.parse(opens[0]![1]!.body as string)).toMatchObject({ p_staff_agent_id: staff.id });
		expect(open).not.toHaveBeenCalled();
		const mine = (screenOrdinal: number, drainPending = false) => ({
			...status.screens[0]!,
			drainPending,
			binding: { ...binding, screenId: id(32 + screenOrdinal), screenOrdinal },
		});
		f.replies.qorpera_runtime_office_member_status = { ...status, screens: [other, mine(2, true), mine(4), mine(3)] };
		await poll();
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding: mine(3).binding }));
	});
	it.each([
		["SCREEN_CAPACITY_EXHAUSTED", "All screens on this computer are in use. Try again when one is free."],
		["AGENT_HAS_NO_COMPUTER_ACCESS", `${staff.displayName} does not have access to the computer.`],
	])("shows the %s refusal without repeatedly requesting access", async (reason, text) => {
		const f = setup({
				qorpera_runtime_office_member_status: { ...status, screens: [] },
				qorpera_open_runtime_office_screen: { state: "refused", reason },
			}),
			open = spyViewer(),
			p = await opened(f.computer);
		expect(statusLine(p)).toBe(text);
		const requests = methods(f);
		await poll();
		await poll();
		expect(methods(f)).toEqual(requests);
		expect(open).not.toHaveBeenCalled();
	});
	it.each(["private", "entering", "leaving"] as const)(
		"waits while privacy is %s before shared viewing",
		async (privacyState) => {
			const f = setup({ qorpera_runtime_office_member_status: { ...status, privacyState } }),
				open = spyViewer();
			const views = f.computer.views(scope),
				connect = vi.spyOn(views, "connectScreen");
			vi.spyOn(f.computer, "views").mockReturnValue(views);
			const p = await opened(f.computer);
			await poll();
			expect(statusLine(p)).toBe("The computer is private right now. Shared viewing returns when that ends.");
			expect(open).not.toHaveBeenCalled();
			expect(connect).not.toHaveBeenCalled();
			f.replies.qorpera_runtime_office_member_status = status;
			await poll();
			expect(open).toHaveBeenCalledTimes(1);
		},
	);
	it("reports missing viewer configuration before screen discovery", async () => {
		const f = setup(),
			open = spyViewer();
		delete f.cloud.config.officeViewerOrigin;
		const p = await opened(f.computer);
		expect(statusLine(p)).toBe("Screen viewing is not set up here.");
		expect(open).not.toHaveBeenCalled();
		expect(methods(f)).not.toContain("qorpera_runtime_office_member_status");
	});
	it("retries connection admission and stops retrying when the viewer closes", async () => {
		const f = setup(),
			open = spyViewer();
		const views = f.computer.views(scope),
			connect = vi.spyOn(views, "connectScreen");
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const p = await opened(f.computer);
		const held = { connectionId: "held", close: vi.fn(async () => {}) } as unknown as CompanyComputerMemberView;
		connect
			.mockRejectedValueOnce(new Error("Starting"))
			.mockRejectedValueOnce(new Error("Starting"))
			.mockResolvedValue(held);
		const input = { binding, mode: "shared" as const, signal: new AbortController().signal };
		const connection = open.mock.calls[0]![0].requestConnection(input);
		await poll();
		await poll();
		await expect(connection).resolves.toBe(held);
		expect(connect).toHaveBeenCalledTimes(3);
		expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ binding, mode: "shared" }));
		const closing = new AbortController();
		connect.mockReset();
		connect.mockRejectedValue(new Error("Starting"));
		const stopped = open.mock.calls[0]![0].requestConnection({ ...input, signal: closing.signal });
		const refused = expect(stopped).rejects.toThrow();
		await settle();
		closing.abort();
		await refused;
		expect(connect).toHaveBeenCalledTimes(1);
		p.dispose();
		expect(open.mock.results[0]!.value.close).toHaveBeenCalled();
	});
	it("drops delayed screen discovery after the popover closes", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberStatus>(),
			open = spyViewer();
		const views = f.computer.views(scope);
		vi.spyOn(views, "status").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const p = await opened(f.computer);
		p.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		pending.resolve(status);
		await settle();
		await poll();
		expect(open).not.toHaveBeenCalled();
		expect(p.el.isConnected).toBe(false);
	});
	it("does not render discovery that arrives after disposal", async () => {
		const f = setup(),
			pending = deferred<Response>();
		f.fetch.mockReturnValueOnce(pending.promise);
		const p = panel(f.computer);
		await settle();
		p.dispose();
		pending.resolve(Response.json(catalog));
		await settle();
		await settle();
		expect(p.el.textContent).toBe("");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("releases a connection returned after company teardown", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberView>(),
			open = spyViewer();
		const views = f.computer.views(scope);
		vi.spyOn(views, "connectScreen").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		await opened(f.computer, f.stop.signal);
		const connecting = open.mock.calls[0]![0].requestConnection({
			binding,
			mode: "watch",
			signal: new AbortController().signal,
		});
		const close = vi.fn(async () => {});
		f.stop.abort();
		pending.resolve({
			connectionId: id(44),
			binding,
			mode: "watch",
			close,
			channel: {
				readyState: 1,
				protocol: "",
				binaryType: "arraybuffer",
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send() {},
				close() {},
			},
		});
		await expect(connecting).rejects.toThrow();
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("uses current member credentials and selected environment", async () => {
		const f = setup();
		await f.computer.client.catalog(f.stop.signal);
		const request = f.fetch.mock.calls[0]![1]!;
		expect(JSON.parse(request.body as string)).toEqual({ p_environment_id: profileA.environmentId, p_after: null });
		expect(new Headers(request.headers).get("authorization")).toBe("Bearer fixture-token");
	});
	it("does not send another account's token", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.computer.client.catalog(f.stop.signal)).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("refuses credentials refreshed after company teardown", async () => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession();
		const pending = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(pending.promise);
		const request = f.computer.client.catalog(new AbortController().signal);
		f.stop.abort();
		pending.resolve(original);
		await expect(request).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("does not infer a viewer endpoint from the object gateway", () => {
		const f = setup();
		delete f.cloud.config.officeViewerOrigin;
		expect(() => f.computer.views(scope)).toThrow("not configured");
	});
});

describe("trusted viewer configuration", () => {
	it.each([
		"ws://viewer.invalid",
		"wss://user:password@viewer.invalid",
		"wss://viewer.invalid/path",
		"wss://viewer.invalid/?ticket=secret",
		"wss://viewer.invalid/#secret",
	])("rejects %s", (officeViewerOrigin) => {
		writeCloudConfigOverride({ ...DEFAULT_CLOUD_CONFIG, officeViewerOrigin });
		expect(readCloudConfigOverride()).toBeUndefined();
	});
	it("preserves a configured secure origin", () => {
		writeCloudConfigOverride({ ...DEFAULT_CLOUD_CONFIG, officeViewerOrigin: "wss://viewer.invalid/" });
		expect(readCloudConfigOverride()?.officeViewerOrigin).toBe("wss://viewer.invalid");
	});
});
