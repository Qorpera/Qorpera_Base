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
	privacyState: "shared",
	privacyVersion: 0,
	screens: [{ binding, epoch: 0, drainPending: false, driver: "idle", takeoverMemberId: null }],
	viewers: [],
};
const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
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
	return { ...f, stop, computer, fetch };
}
function panel(computer: WebCompanyComputer, signal?: AbortSignal) {
	const value = new ComputerPanel(staff, () => {}, computer, signal);
	document.body.append(value.el);
	cleanup.push(() => value.dispose());
	return value;
}
function action(root: HTMLElement, label: string) {
	const result = [...root.querySelectorAll("button")].find((button) => button.textContent === label);
	if (!result) throw new Error(`Missing ${label}: ${root.textContent}`);
	return result;
}

describe("web runtime member boundary", () => {
	it("clears shared viewing controls and releases its viewer before opening browser management", async () => {
		const f = setup();
		const close = vi.fn(async () => {});
		vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close });
		const p = panel(f.computer);
		await settle();
		await settle();
		action(p.el, "Watch screen 1").click();
		await settle();
		action(p.el, "Manage your browsers").click();
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(p.el.textContent).not.toContain("Watch screen 1");
	});
	it("hides computer permission controls when the catalog does not allow management", async () => {
		const f = setup({ qorpera_member_office_catalog: { ...catalog, canManage: false } });
		const p = panel(f.computer);
		await settle();
		await settle();
		expect(p.el.textContent).not.toContain("Manage computer permissions");
	});
	it("cancels only the observed pending start after an explicit click", async () => {
		const intent = {
			schema: "qorpera.office-start-intent/v1" as const,
			intentId: id(71),
			companyComputerId: scope.companyComputerId,
			computerGeneration: 1,
			state: "requested" as const,
		};
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "provisioning", intent } });
		const startClient = f.computer.client.start(scope);
		const cancel = vi.spyOn(startClient, "cancel").mockResolvedValue({ ...intent, state: "cancelled" });
		vi.spyOn(f.computer.client, "start").mockReturnValue(startClient);
		const p = panel(f.computer);
		await settle();
		await settle();
		expect(cancel).not.toHaveBeenCalled();
		action(p.el, "Cancel pending start").click();
		await settle();
		expect(cancel).toHaveBeenCalledExactlyOnceWith(intent, expect.any(AbortSignal));
	});
	it("starts only on explicit intent and never replays an ambiguous start or cancels it on disposal", async () => {
		const f = setup({ qorpera_runtime_office_start_status: { ...start, officeState: "provisioning" } });
		const startClient = f.computer.client.start(scope);
		const request = vi.spyOn(startClient, "request").mockRejectedValue(new Error("Response lost"));
		const cancel = vi.spyOn(startClient, "cancel");
		vi.spyOn(f.computer.client, "start").mockReturnValue(startClient);
		const p = panel(f.computer);
		await settle();
		await settle();
		expect(request).not.toHaveBeenCalled();
		const startButton = action(p.el, "Start computer");
		startButton.click();
		startButton.click();
		await settle();
		expect(request).toHaveBeenCalledTimes(1);
		action(p.el, "Refresh computer").click();
		await settle();
		await settle();
		expect(request).toHaveBeenCalledTimes(1);
		p.dispose();
		expect(cancel).not.toHaveBeenCalled();
	});
	it("does not offer another agent's screen", async () => {
		const f = setup({
			qorpera_runtime_office_member_status: {
				...status,
				screens: [{ ...status.screens[0], binding: { ...binding, staffAgentId: id(99) } }],
			},
		});
		const p = panel(f.computer);
		await settle();
		await settle();
		expect(p.el.textContent).toContain("This agent has no screen yet");
		expect([...p.el.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Watch"))).toBe(
			false,
		);
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
	it("reads status without starting or connecting, then selects only this agent's screen", async () => {
		const f = setup(),
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		const p = panel(f.computer);
		await settle();
		await settle();
		expect(f.fetch.mock.calls.map((call) => String(call[0]).split("/").at(-1))).toEqual([
			"qorpera_member_office_catalog",
			"qorpera_runtime_office_start_status",
			"qorpera_runtime_office_member_status",
		]);
		expect(open).not.toHaveBeenCalled();
		action(p.el, "Watch screen 1").click();
		await settle();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ binding, canControl: true }));
		p.dispose();
		expect(open.mock.results[0]!.value.close).toHaveBeenCalled();
	});
	it.each(["private", "entering", "leaving"] as const)(
		"does not offer shared viewing during %s",
		async (privacyState) => {
			const f = setup({ qorpera_runtime_office_member_status: { ...status, privacyState } });
			const p = panel(f.computer);
			await settle();
			await settle();
			expect(p.el.textContent).toContain("Shared viewing is unavailable");
			expect([...p.el.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Watch"))).toBe(
				false,
			);
		},
	);
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
		const open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		const p = panel(f.computer, f.stop.signal);
		await settle();
		await settle();
		action(p.el, "Watch screen 1").click();
		await settle();
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
