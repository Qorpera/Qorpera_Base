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
	const value = new ComputerPanel(staff, () => value.dispose(), computer, signal);
	document.body.append(value.el);
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
		expect(p.el.querySelector(".computer-close, [aria-label='Close computer']")).toBeNull();
		expect(p.el.tabIndex).toBe(-1);
		await settle();
		await settle();
		expect(open).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				binding,
				mount: p.el.querySelector(".computer-panel-body"),
				autofocus: false,
				canControl: true,
			}),
		);
		expect(methods(f)).toEqual([
			"qorpera_member_office_catalog",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
		expect(methods(f).some((method) => START_WRITES.test(`/${method}`))).toBe(false);
		expect(p.el.querySelector<HTMLElement>(".computer-loading")?.hidden).toBe(true);
		expect(p.el.querySelector(".computer-close, [aria-label='Close computer']")).toBeNull();
		open.mock.calls[0]![0].onClosed();
		expect(p.el.isConnected).toBe(false);
	});
	it("keeps unavailable and missing computers inside the popover without starting a runtime", async () => {
		const unavailable = new ComputerPanel(staff, () => {});
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
});

describe("web runtime member boundary", () => {
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
		const input = { binding, mode: "watch" as const, signal: new AbortController().signal };
		const connection = open.mock.calls[0]![0].requestConnection(input);
		await poll();
		await poll();
		await expect(connection).resolves.toBe(held);
		expect(connect).toHaveBeenCalledTimes(3);
		expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ binding, mode: "watch" }));
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
