// @vitest-environment jsdom
import type {
	CompanyComputerMemberStatus,
	CompanyComputerMemberView,
} from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPanel } from "../src/app/views/computer.ts";
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
const OLD_CONTROLS = [
	"Refresh computer",
	"Manage computer permissions",
	"Manage your browsers",
	"Start computer",
	"Cancel pending start",
];
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
function setup(overrides: Record<string, unknown> = {}) {
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
	const computer = new WebCompanyComputer(f.cloud, profileA, userA.id, stop.signal, () => {});
	cleanup.push(() => stop.abort());
	return { ...f, stop, computer, fetch, replies };
}
function panel(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = new ComputerPanel(staff, () => {}, computer, signal);
	document.body.append(value.el);
	cleanup.push(() => value.dispose());
	return value;
}
/** A panel that has finished its opening reads. */
async function looked(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = panel(computer, signal);
	await settle();
	await settle();
	return value;
}
function action(root: HTMLElement, label: string) {
	const result = [...root.querySelectorAll("button")].find((button) => button.textContent === label);
	if (!result) throw new Error(`Missing ${label}: ${root.textContent}`);
	return result;
}
function labels(root: HTMLElement) {
	return [...root.querySelectorAll("button")].map((button) => button.textContent);
}
function methods(f: ReturnType<typeof setup>) {
	return f.fetch.mock.calls.map(([url]) => String(url).split("/").at(-1));
}
function stage() {
	return document.body.querySelector<HTMLElement>(".computer-stage");
}
function stageText() {
	return stage()?.querySelector("[role=status]")?.textContent;
}
function statusLine(p: ComputerPanel) {
	return p.el.querySelector(".computer-preview > [role=status]")?.textContent;
}
async function openComputer(p: ComputerPanel) {
	action(p.el, "Open computer").click();
	await settle();
	await settle();
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

describe("web runtime member boundary", () => {
	it("releases its shared viewer before opening browser management", async () => {
		const f = setup();
		const released = deferred<void>();
		const close = vi.fn(() => released.promise);
		const open = spyViewer(close);
		const p = await looked(f.computer);
		await openComputer(p);
		expect(open).toHaveBeenCalledTimes(1);
		action(p.el, "Your browsers").click();
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(p.el.querySelector("[aria-label='Your browser profiles']")).toBeNull();
		released.resolve();
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(p.el.querySelector(".computer-details [aria-label='Your browser profiles']")).not.toBeNull();
	});
	it("offers permissions only when the catalog allows management", async () => {
		const member = setup({ qorpera_member_office_catalog: { ...catalog, canManage: false } });
		const p = await looked(member.computer);
		expect(labels(p.el)).not.toContain("Permissions");
		expect(labels(p.el)).toContain("Your browsers");
		expect(p.el.textContent).not.toContain("Manage computer permissions");
		p.dispose();
		const admin = setup();
		const q = await looked(admin.computer);
		action(q.el, "Permissions").click();
		await settle();
		expect(q.el.querySelector(".computer-details [aria-label='Agent computer permissions']")).not.toBeNull();
	});
	it("offers one disabled action when the company has no computer", async () => {
		const f = setup({ qorpera_member_office_catalog: { ...catalog, scope: null } });
		const p = await looked(f.computer);
		expect(statusLine(p)).toBe("This company has no computer yet.");
		expect(action(p.el, "Open computer").disabled).toBe(true);
		expect(labels(p.el)).not.toContain("Permissions");
		expect(labels(p.el)).not.toContain("Your browsers");
		action(p.el, "Open computer").click();
		await settle();
		expect(stage()).toBeNull();
		expect(methods(f)).toEqual(["qorpera_member_office_catalog"]);
	});
	it("says the computer could not be reached when a read fails", async () => {
		const f = setup();
		delete f.replies.qorpera_runtime_office_start_status;
		const p = await looked(f.computer);
		expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
		expect(stage()).toBeNull();
	});
	it.each(["provisioning", "recovering"])(
		"never cancels an existing %s start and sends no second start while one is pending",
		async (officeState) => {
			for (const state of ["requested", "reserved"] as const) {
				const f = setup({
					qorpera_runtime_office_start_status: { ...start, officeState, intent: { ...intent, state } },
				});
				const startClient = spyStart(f);
				const request = vi.spyOn(startClient, "request");
				const cancel = vi.spyOn(startClient, "cancel");
				const p = await looked(f.computer);
				expect(labels(p.el)).not.toContain("Cancel pending start");
				await openComputer(p);
				expect(stageText()).toBe("Starting the computer…");
				await poll();
				await poll();
				expect(stageText()).toBe("Starting the computer…");
				stage()!.querySelector<HTMLButtonElement>("[aria-label='Close computer']")!.click();
				await settle();
				expect(stage()).toBeNull();
				await openComputer(p);
				await poll();
				p.dispose();
				await settle();
				expect(request).not.toHaveBeenCalled();
				expect(cancel).not.toHaveBeenCalled();
				expect(f.fetch.mock.calls.some(([url]) => START_WRITES.test(String(url)))).toBe(false);
			}
		},
	);
	it.each(["provisioning", "recovering"])(
		"starts a %s office only on explicit intent, keeps one identity after an ambiguous start and never cancels on disposal",
		async (officeState) => {
			const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState } });
			const startClient = spyStart(f);
			const request = vi.spyOn(startClient, "request").mockRejectedValue(new Error("Response lost"));
			const cancel = vi.spyOn(startClient, "cancel");
			const p = await looked(f.computer);
			await poll();
			expect(request).not.toHaveBeenCalled();
			const openButton = action(p.el, "Open computer");
			openButton.click();
			openButton.click();
			await settle();
			await settle();
			expect(request).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledWith(1, expect.any(String), expect.any(AbortSignal));
			expect(stage()).toBeNull();
			expect(statusLine(p)).toBe("The computer could not be reached. Try again.");
			await poll();
			expect(request).toHaveBeenCalledTimes(1);
			await openComputer(p);
			expect(request).toHaveBeenCalledTimes(2);
			expect(request.mock.calls[1]![0]).toBe(1);
			expect(request.mock.calls[1]![1]).toBe(request.mock.calls[0]![1]);
			p.dispose();
			await settle();
			expect(cancel).not.toHaveBeenCalled();
		},
	);
	it("sends one start per click flow, waits for the computer and then shows this agent's screen", async () => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" } });
		const startClient = spyStart(f);
		const request = vi.spyOn(startClient, "request").mockResolvedValue(intent);
		const open = spyViewer();
		const p = await looked(f.computer);
		expect(statusLine(p)).toBe("The computer is off.");
		await openComputer(p);
		expect(stage()?.getAttribute("role")).toBe("dialog");
		expect(stage()?.getAttribute("aria-label")).toBe(`${staff.displayName} · Computer`);
		expect(stageText()).toBe("Starting the computer…");
		await poll();
		await poll();
		expect(request).toHaveBeenCalledTimes(1);
		expect(open).not.toHaveBeenCalled();
		expect(methods(f)).not.toContain("qorpera_runtime_office_member_status");
		f.replies.qorpera_runtime_office_start_status = start;
		await poll();
		expect(request).toHaveBeenCalledTimes(1);
		expect(stage()).toBeNull();
		expect(statusLine(p)).toBe("The computer is on.");
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding }));
	});
	it.each([
		["provisioning", true],
		["recovering", true],
		["active", false],
		["maintenance", false],
		["retired", false],
	] as const)("offers one action for %s and starts only when that is allowed", async (officeState, eligibleState) => {
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
				const open = spyViewer();
				const p = await looked(f.computer);
				const offered = labels(p.el);
				for (const old of OLD_CONTROLS) expect(offered).not.toContain(old);
				expect(offered.some((label) => label?.startsWith("Watch"))).toBe(false);
				expect(offered).toContain("Open computer");
				expect(action(p.el, "Open computer").disabled).toBe(false);
				expect(offered.includes("Permissions")).toBe(canManage);
				expect(offered).toContain("Your browsers");
				expect(statusLine(p)).toBe(
					officeState === "active"
						? "The computer is on."
						: officeState === "maintenance"
							? "The computer is restarting and comes back on its own."
							: "The computer is off.",
				);
				expect(methods(f)).toEqual(["qorpera_member_office_catalog", "qorpera_runtime_office_start_status"]);
				await openComputer(p);
				await poll();
				const writes = methods(f).filter((method) => START_WRITES.test(`/${method}`));
				expect(writes).toEqual(
					canManage && eligibleState && intentState === null ? ["qorpera_request_runtime_office_start"] : [],
				);
				if (officeState === "active") {
					expect(stage()).toBeNull();
					expect(open).toHaveBeenCalledTimes(1);
				} else {
					expect(open).not.toHaveBeenCalled();
					expect(stageText()).toBe(
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
					const reads = f.fetch.mock.calls.length;
					await poll();
					expect(f.fetch).toHaveBeenCalledTimes(reads);
				}
				p.dispose();
				expect(stage()).toBeNull();
				f.stop.abort();
				open.mockRestore();
			}
		}
	});
	it("opens a screen for an agent that has none, once, and never shows another agent's screen", async () => {
		const other = { ...status.screens[0]!, binding: { ...binding, staffAgentId: id(99) } };
		const f = setup({ qorpera_runtime_office_member_status: { ...status, screens: [other] } });
		const open = spyViewer();
		const p = await looked(f.computer);
		expect(methods(f)).not.toContain("qorpera_open_runtime_office_screen");
		await openComputer(p);
		await poll();
		await poll();
		const opens = f.fetch.mock.calls.filter(([url]) => String(url).endsWith("qorpera_open_runtime_office_screen"));
		expect(opens).toHaveLength(1);
		expect(JSON.parse(opens[0]![1]!.body as string)).toMatchObject({ p_staff_agent_id: staff.id });
		expect(stageText()).toBe(`Opening ${staff.displayName}'s computer…`);
		expect(open).not.toHaveBeenCalled();
		const mine = (screenOrdinal: number, drainPending = false) => ({
			...status.screens[0]!,
			drainPending,
			binding: { ...binding, screenId: id(32 + screenOrdinal), screenOrdinal },
		});
		f.replies.qorpera_runtime_office_member_status = {
			...status,
			screens: [other, mine(2, true), mine(4), mine(3)],
		};
		await poll();
		expect(stage()).toBeNull();
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ binding: mine(3).binding, title: `${staff.displayName} · Computer` }),
		);
	});
	it.each([
		["SCREEN_CAPACITY_EXHAUSTED", "All screens on this computer are in use. Try again when one is free."],
		[
			"AGENT_HAS_NO_COMPUTER_ACCESS",
			`${staff.displayName} does not have access to the computer yet. An owner or admin can grant it under Permissions.`,
		],
	])("says why a screen cannot be opened (%s) and stops asking", async (reason, text) => {
		const f = setup({
			qorpera_runtime_office_member_status: { ...status, screens: [] },
			qorpera_open_runtime_office_screen: { state: "refused", reason },
		});
		const open = spyViewer();
		const p = await looked(f.computer);
		await openComputer(p);
		await poll();
		expect(stageText()).toBe(text);
		const calls = f.fetch.mock.calls.length;
		await poll();
		await poll();
		expect(f.fetch).toHaveBeenCalledTimes(calls);
		expect(open).not.toHaveBeenCalled();
	});
	it("uses current member credentials and the selected environment for discovery", async () => {
		const f = setup();
		await f.computer.client.catalog(f.stop.signal);
		expect(f.fetch).toHaveBeenCalledTimes(1);
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
	it("refuses a token that finishes refreshing after company teardown", async () => {
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
	it("reads status without starting or connecting, then opens only this agent's screen", async () => {
		const f = setup(),
			open = spyViewer();
		const views = f.computer.views(scope);
		const connect = vi.spyOn(views, "connectScreen").mockRejectedValue(new Error("Not under test"));
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const p = await looked(f.computer);
		await poll();
		await poll();
		expect(methods(f)).toEqual(["qorpera_member_office_catalog", "qorpera_runtime_office_start_status"]);
		expect(statusLine(p)).toBe("The computer is on.");
		expect(open).not.toHaveBeenCalled();
		expect(stage()).toBeNull();
		await openComputer(p);
		expect(methods(f)).toEqual([
			"qorpera_member_office_catalog",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
		expect(stage()).toBeNull();
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ binding, title: `${staff.displayName} · Computer`, canControl: true }),
		);
		expect(connect).not.toHaveBeenCalled();
		const input = { binding, mode: "watch" as const, signal: new AbortController().signal };
		await expect(open.mock.calls[0]![0].requestConnection(input)).rejects.toThrow("Not under test");
		expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding, mode: "watch" }));
		p.dispose();
		expect(open.mock.results[0]!.value.close).toHaveBeenCalled();
	});
	it("opens a viewer without control for a member who cannot manage", async () => {
		const f = setup({ qorpera_member_office_catalog: { ...catalog, canManage: false } }),
			open = spyViewer();
		const p = await looked(f.computer);
		await openComputer(p);
		expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ binding, canControl: false }));
	});
	it.each(["private", "entering", "leaving"] as const)(
		"does not open shared viewing during %s",
		async (privacyState) => {
			const f = setup({ qorpera_runtime_office_member_status: { ...status, privacyState } });
			const open = spyViewer();
			const views = f.computer.views(scope);
			const connect = vi.spyOn(views, "connectScreen");
			vi.spyOn(f.computer, "views").mockReturnValue(views);
			const p = await looked(f.computer);
			await openComputer(p);
			await poll();
			expect(stageText()).toBe("The computer is private right now. Shared viewing returns when that ends.");
			expect(open).not.toHaveBeenCalled();
			expect(connect).not.toHaveBeenCalled();
			f.replies.qorpera_runtime_office_member_status = status;
			await poll();
			expect(stage()).toBeNull();
			expect(open).toHaveBeenCalledTimes(1);
		},
	);
	it("says so when screen viewing is not set up", async () => {
		const f = setup(),
			open = spyViewer();
		const p = await looked(f.computer);
		delete f.cloud.config.officeViewerOrigin;
		await openComputer(p);
		expect(stageText()).toBe("Screen viewing is not set up here.");
		expect(open).not.toHaveBeenCalled();
		expect(methods(f)).not.toContain("qorpera_runtime_office_member_status");
	});
	it.each(["button", "Escape"])("closing the stage by %s stops the flow quietly", async (how) => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "maintenance" } });
		const p = await looked(f.computer);
		await openComputer(p);
		const close = stage()!.querySelector<HTMLButtonElement>("[aria-label='Close computer']")!;
		expect(document.activeElement).toBe(close);
		if (how === "button") close.click();
		else stage()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(stage()).toBeNull();
		expect(statusLine(p)).toBe("The computer is restarting and comes back on its own.");
		const reads = f.fetch.mock.calls.length;
		await poll();
		await poll();
		expect(f.fetch).toHaveBeenCalledTimes(reads);
		await openComputer(p);
		expect(stageText()).toBe("The computer is restarting. It comes back on its own.");
	});
	it("disposing the panel closes the stage and stops polling", async () => {
		const f = setup({ qorpera_runtime_office_member_status: { ...status, screens: [] } });
		const open = spyViewer();
		const p = await looked(f.computer);
		await openComputer(p);
		expect(stage()).not.toBeNull();
		p.dispose();
		await settle();
		expect(stage()).toBeNull();
		const reads = f.fetch.mock.calls.length;
		f.replies.qorpera_runtime_office_member_status = status;
		await poll();
		await poll();
		expect(f.fetch).toHaveBeenCalledTimes(reads);
		expect(open).not.toHaveBeenCalled();
	});
	it("does not render late discovery after the panel closes", async () => {
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
	it("closes a view returned after company teardown", async () => {
		const f = setup(),
			pending = deferred<CompanyComputerMemberView>();
		const views = f.computer.views(scope);
		vi.spyOn(views, "connectScreen").mockReturnValue(pending.promise);
		vi.spyOn(f.computer, "views").mockReturnValue(views);
		const open = spyViewer();
		const p = await looked(f.computer, f.stop.signal);
		await openComputer(p);
		const options = open.mock.calls[0]![0];
		const connecting = options.requestConnection({ binding, mode: "watch", signal: new AbortController().signal });
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
