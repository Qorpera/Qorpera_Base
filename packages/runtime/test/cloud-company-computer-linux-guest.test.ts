import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import { companyComputerFailureDiagnostic } from "@qorpera/runtime/cloud-company-computer-diagnostics";
import { CloudCompanyComputerEffectControl } from "@qorpera/runtime/cloud-company-computer-effect-control";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import { CompanyComputerLinuxCommands } from "@qorpera/runtime/cloud-company-computer-linux-commands";
import { CompanyComputerLinuxGuest } from "@qorpera/runtime/cloud-company-computer-linux-guest";
import { CompanyComputerRegistryUnansweredError } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { CompanyComputerScreenLifecyclePublisher } from "@qorpera/runtime/cloud-company-computer-screen-lifecycle";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerOperation,
	computerScope,
} from "./fixtures/company-computer.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";
import { screenReceipt, screenStartup } from "./fixtures/screen-lifecycle.ts";

const physical = vi.hoisted(() => ({
	prepare: vi.fn(),
	launch: vi.fn(),
	close: vi.fn(),
	connect: vi.fn(),
	privateStart: vi.fn(),
	drain: vi.fn(),
	browserRequest: vi.fn(),
	browserLaunch: vi.fn(),
}));
vi.mock("../src/cloud-company-computer-desktop.ts", () => ({
	prepareCompanyComputerScreenWallpaper: physical.prepare,
}));
vi.mock("../src/cloud-company-computer-linux-desktop.ts", () => ({
	CompanyComputerLinuxDesktopLauncher: class {
		launch = physical.launch;
		close = physical.close;
		drain = physical.drain;
		connectRfb = physical.connect;
		takeBrowserRequest = physical.browserRequest;
		xSocket() {
			return "/run/office-screens/fixture/X1";
		}
	},
}));
vi.mock("../src/cloud-company-computer-linux-browser.ts", () => ({
	createCompanyComputerLinuxBrowserLaunch:
		(options: unknown) =>
		(...args: unknown[]) =>
			physical.browserLaunch(...args, options),
}));
vi.mock("../src/cloud-company-computer-linux-private-surface.ts", () => ({
	startCompanyComputerLinuxPrivateSurface: physical.privateStart,
}));
const runs: CloudNativeToolRun[] = [];
const guests: CompanyComputerLinuxGuest[] = [];
const displays: { stop: ReturnType<typeof vi.fn>; exited: ReturnType<typeof computerDeferred<void>> }[] = [];
const privateCloses: ReturnType<typeof vi.fn>[] = [];
const browsers: {
	context: { pages(): never[] };
	close: ReturnType<typeof vi.fn>;
	end(): void;
	ended(): boolean;
}[] = [];
const temporary: string[] = [];
/** The browser window as CDP reports it; a test minimises it. */
const windows = {
	pages: [] as never[],
	state: "maximized",
	send: vi.fn(async (method: string, args?: { bounds?: { windowState?: string } }) => {
		if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: { windowState: windows.state } };
		if (args?.bounds?.windowState) windows.state = args.bounds.windowState;
		return {};
	}),
};
beforeEach(() => {
	windows.pages = [];
	windows.state = "maximized";
	browsers.length = 0;
	vi.clearAllMocks();
	displays.length = 0;
	privateCloses.length = 0;
	physical.prepare.mockResolvedValue({});
	physical.close.mockResolvedValue(undefined);
	physical.drain.mockResolvedValue(undefined);
	physical.launch.mockImplementation(async (_binding, signal: AbortSignal) => {
		signal.throwIfAborted();
		const exited = computerDeferred<void>();
		const stop = vi.fn(async () => exited.resolve());
		displays.push({ stop, exited });
		return { ready: Promise.resolve(), exited: exited.promise, stop };
	});
	physical.connect.mockImplementation(async () => new Socket());
	// Reset, not only cleared: a queued "once" request must never leak into the next test.
	physical.browserRequest.mockReset();
	physical.browserRequest.mockResolvedValue(false);
	physical.browserLaunch.mockImplementation(
		async (
			_directory: string,
			input: { signal: AbortSignal; grant: unknown; binding: unknown },
			options: { access: { assertGranted(grant: unknown, binding: unknown, signal: AbortSignal): Promise<void> } },
		) => {
			input.signal.throwIfAborted();
			const listeners: (() => void)[] = [];
			const context = {
				pages: () => windows.pages,
				newCDPSession: async () => ({ send: windows.send, detach: async () => undefined }),
				on: (_event: string, listener: () => void) => listeners.push(listener),
				cookies: async () => [],
				addCookies: async () => undefined,
			};
			let over = false;
			const end = (): void => {
				over = true;
				clearInterval(relay);
				for (const listener of listeners.splice(0)) listener();
			};
			// The one physical behaviour this double keeps: like the real egress relay,
			// it asks the launch's authority every second and ends the browser on a refusal.
			const relay = setInterval(() => {
				void options.access.assertGranted(input.grant, input.binding, new AbortController().signal).catch(end);
			}, 1000);
			const close = vi.fn(async () => end());
			browsers.push({ context, close, end, ended: () => over });
			return { context, close };
		},
	);
	physical.privateStart.mockImplementation(async (options) => {
		await options.assertDrained(options.challenge, options.signal);
		options.signal.throwIfAborted();
		const closed = computerDeferred<void>();
		const close = vi.fn(async () => closed.resolve());
		privateCloses.push(close);
		return {
			close,
			closed: closed.promise,
			connect: vi.fn(async () => ({ socket: new Socket(), remainder: Buffer.alloc(0) })),
		};
	});
});
afterEach(async () => {
	vi.useRealTimers();
	await Promise.allSettled(guests.splice(0).map((guest) => guest.close()));
	for (const run of runs.splice(0)) run.close();
	for (const browser of browsers.splice(0)) browser.end();
	for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});
async function fixture(options: { browser?: boolean } = {}) {
	const source = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => source.authority },
		new AbortController().signal,
	);
	runs.push(run);
	const scope = { ...computerScope(), companyId: run.identity.companyId, environmentId: run.identity.environmentId };
	const binding = { ...computerBinding(), ...scope, staffAgentId: run.identity.staffAgentId };
	const lease = {
		...computerLease(),
		binding,
		driver: { kind: "agent" as const, runId: run.identity.runId, staffAgentId: run.identity.staffAgentId },
	};
	const browserGrant = { profileId: computerId(70), grantId: computerId(71), version: 1 };
	const resources = {
		officeGrantId: computerId(80),
		officeGrantVersion: 1,
		officePrivacyVersion: 0,
		...(options.browser
			? {
					browserProfileId: browserGrant.profileId,
					browserGrantId: browserGrant.grantId,
					browserGrantVersion: browserGrant.version,
				}
			: {}),
	};
	const descriptor = {
		state: "available" as const,
		scope,
		capabilities: options.browser ? ["shell" as const, "browser" as const] : ["shell" as const],
		resources,
	};
	// The persistent browser manager checks its real profile root.
	let browserProfilesRoot = "/srv/profiles";
	if (options.browser) {
		browserProfilesRoot = await mkdtemp(join(await realpath(tmpdir()), "qorpera-guest-profiles-"));
		temporary.push(browserProfilesRoot);
	}
	/** What SQL answers for the screen's browser; a test flips it to a refusal. */
	const screenBrowser = { authorized: true, opens: [] as unknown[] };
	const state = { privacy: "shared", version: 0, epoch: 1 };
	const appearance = vi.fn((): unknown => ({ creature: "rocket", templateId: "agent-manager" }));
	const order: string[] = [];
	const call = vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
		order.push(`${method}:${args.p_action ?? "read"}`);
		if (method === "qorpera_check_runtime_office_shared_surface") {
			if (state.privacy !== "shared") throw new Error("private");
			return { state: "authorized", privacyVersion: state.version, epoch: state.epoch, validForMs: 5000 };
		}
		if (method === "qorpera_check_runtime_office_private_surface")
			return { state: "authorized", privacyState: state.privacy, version: state.version, validForMs: 5000 };
		if (method === "qorpera_runtime_office_screen_appearance") return appearance();
		if (method === "qorpera_office_screen_browser_grant") {
			if (!screenBrowser.authorized) throw new Error("Browser authority unavailable");
			if (args.p_opener !== null) screenBrowser.opens.push(args.p_opener);
			return { state: "authorized", grant: browserGrant, validForMs: 5000 };
		}
		if (method === "qorpera_native_office_browser_grant") return { state: "authorized" };
		if (method === "qorpera_native_office_operation") {
			if (args.p_action === "authorize") return { state: "authorized" };
			if (args.p_action === "finish") return { state: "drained" };
			return { state: "admitted", resourceLeaseId: computerId(81), validForMs: 30000 };
		}
		throw new Error(`Unexpected fixture RPC ${method}`);
	});
	const boundary = { assertReady: vi.fn(async () => undefined) };
	const failure = vi.fn();
	const lifecycleCall = vi.fn(async (_method: string, args: Record<string, unknown>) => screenReceipt(args));
	const screenLifecycle = new CompanyComputerScreenLifecyclePublisher(
		{ ...screenStartup(), scope },
		{ call: lifecycleCall },
	);
	const guest = new CompanyComputerLinuxGuest({
		scope,
		computerGeneration: 1,
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot,
		},
		limits: { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
		workbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/srv" },
		privateWorkbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/run/office-private" },
		displayRuntimeRoot: "/run/office-screens",
		browserRuntimeRoot: "/run/office-browser",
		captureRoot: "/run/office-captures",
		registry: { call },
		screenLifecycle,
		boundary,
		screenshots: () => ({
			publish: async () => {
				throw new Error("NO_FIXTURE_CAPTURE");
			},
		}),
		onFailure: failure,
	});
	guests.push(guest);
	const gate = new CompanyComputerScreenActionGate();
	const effects = new CloudCompanyComputerEffectControl({ run, scope, control: { call } });
	const create = () => guest.createSession({ run, descriptor, lease, gate, effects });
	const operation = (action: { kind: string; [key: string]: string | number }) => ({
		...computerOperation(),
		tool: `computer_${action.kind}`,
		arguments: action,
		target: { realm: "company_computer", binding, resources: { ...resources } },
	});
	const effect = () => ({
		identity: run.identity,
		receiptId: randomUUID(),
		idempotencyKey: "a".repeat(64),
		signal: run.signal,
	});
	const challenge: CompanyComputerPrivacyChallenge = {
		scope,
		computerGeneration: 1,
		challengeId: computerId(82),
		version: 1,
		state: "entering",
		memberId: computerId(83),
		profileId: computerId(84),
		profileVersion: 2,
		screenId: binding.screenId,
		drains: [{ state: "draining", drainId: computerId(85), epoch: 2, binding }],
	};
	const privateViewer = (): CompanyComputerViewerGrant => ({
		binding,
		viewerSessionId: computerId(87),
		memberId: challenge.memberId,
		mode: "control",
		privacyVersion: challenge.version,
		screenEpoch: 3,
		validForMs: 30000,
		lease: {
			...lease,
			epoch: 3,
			driver: { kind: "member", memberId: challenge.memberId, sessionId: computerId(87) },
		},
		privateSignIn: {
			challengeId: challenge.challengeId,
			profileId: challenge.profileId,
			profileVersion: challenge.profileVersion,
		},
	});
	return {
		guest,
		create,
		run,
		descriptor,
		resources,
		binding,
		lease,
		gate,
		effects,
		call,
		order,
		boundary,
		state,
		appearance,
		screenBrowser,
		browserGrant,
		sharedViewer: (): CompanyComputerViewerGrant => ({
			binding,
			viewerSessionId: computerId(90),
			memberId: computerId(91),
			mode: "shared",
			privacyVersion: 0,
			screenEpoch: 1,
			validForMs: 30000,
		}),
		failure,
		operation,
		effect,
		challenge,
		privateViewer,
		lifecycleCall,
		events: () => lifecycleCall.mock.calls.map(([, args]) => args.p_event as Record<string, unknown>),
	};
}

describe("whole Linux guest ownership (physical adapters mocked here; separate Linux probes execute them)", () => {
	it("keeps the agent working while a shared viewer connects and disconnects", async () => {
		const f = await fixture();
		const session = await f.create();
		const operation = f.operation({ kind: "screen", action: "open" });
		await session.endpoint.perform(operation, f.lease, f.effect());
		// Agent lease churn advances its own epoch; the shared viewer's epoch
		// remains bound to the last physical fence and is checked by its gateway.
		f.state.epoch = 2;
		const viewer = await f.guest.viewer.connect(
			{
				binding: f.binding,
				viewerSessionId: computerId(90),
				memberId: computerId(91),
				mode: "shared",
				privacyVersion: 0,
				screenEpoch: 1,
				validForMs: 30000,
			},
			f.run.signal,
		);
		await session.endpoint.perform(operation, f.lease, f.effect());
		viewer.socket.destroy();
		await session.endpoint.perform(operation, f.lease, f.effect());
		expect(displays[0].stop).not.toHaveBeenCalled();
		expect(physical.launch).toHaveBeenCalledOnce();
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("keeps the desktop, its browser and the agent's session when one authority check gets no answer", async () => {
		const f = await fixture({ browser: true });
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		const original = f.call.getMockImplementation()!;
		let lost = 0;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_check_runtime_office_shared_surface" && lost < 1) {
				lost++;
				throw new CompanyComputerRegistryUnansweredError(new Error("request timed out"));
			}
			return original(method, args);
		});
		await vi.waitFor(() => expect(lost).toBe(1), { timeout: 3000 });
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(displays[0].stop).not.toHaveBeenCalled();
		expect(browsers[0].ended()).toBe(false);
		await session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		expect(physical.launch).toHaveBeenCalledOnce();
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		expect(f.failure).not.toHaveBeenCalled();
	}, 15000);
	it("ends the desktop as authority lost after the whole grace without an answer, or at once on a refusal", async () => {
		vi.useFakeTimers();
		// The grace is measured on the monotonic clock; let it follow the fake one.
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_check_runtime_office_shared_surface")
				throw new CompanyComputerRegistryUnansweredError(new Error("request timed out"));
			return original(method, args);
		});
		await vi.advanceTimersByTimeAsync(28_000);
		expect(displays[0].stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(displays[0].stop).toHaveBeenCalledOnce();
		expect(f.events().find((event) => event.state === "closing")).toMatchObject({ reason: "AUTHORITY_LOST" });
		expect(f.failure).not.toHaveBeenCalled();
		expect(session.ended?.()).toBe(true);

		// A clear refusal needs no grace.
		f.call.mockImplementation(original);
		const next = await f.create();
		await next.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		expect(displays).toHaveLength(2);
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_check_runtime_office_shared_surface")
				throw new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("denied") });
			return original(method, args);
		});
		await vi.advanceTimersByTimeAsync(1_100);
		expect(displays[1].stop).toHaveBeenCalledOnce();
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("admits no new session while a private sign-in is being prepared", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, new AbortController().signal);
		await expect(f.create()).rejects.toThrow("OFFICE_PRIVACY_FENCED");
	});
	it("draws the screen agent's saved avatar, and an office that cannot read it still starts its desktop", async () => {
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		expect(physical.prepare).toHaveBeenCalledOnce();
		expect(physical.prepare.mock.calls[0][0]).toMatchObject({
			binding: f.binding,
			creature: "rocket",
			templateId: "agent-manager",
		});
		await f.guest.stopResources(f.binding, new AbortController().signal);
		// A database without the read (or a malformed answer) leaves both fields
		// unset, so the preparation derives the figure from the agent id.
		f.appearance.mockImplementation(() => ({ creature: "rocket", templateId: "agent-manager", extra: true }));
		await f.guest.viewer.connect(
			{
				binding: f.binding,
				viewerSessionId: computerId(90),
				memberId: computerId(91),
				mode: "shared",
				privacyVersion: 0,
				screenEpoch: 1,
				validForMs: 30000,
			},
			f.run.signal,
		);
		expect(physical.prepare).toHaveBeenCalledTimes(2);
		expect(physical.prepare.mock.calls[1][0].creature).toBeUndefined();
		expect(physical.prepare.mock.calls[1][0].templateId).toBeUndefined();
		expect(physical.launch).toHaveBeenCalledTimes(2);
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("opens no browser when a member arrives, whatever their mode, nor at desktop start: only the dock icon or a run does", async () => {
		const f = await fixture({ browser: true });
		// A watcher, a member with input permission, and a second one: the desktop
		// is shown as it is, and nothing is asked of SQL.
		await f.guest.viewer.connect({ ...f.sharedViewer(), mode: "watch" }, new AbortController().signal);
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		// Two dock polls (500 ms each) pass with nothing asked and nothing launched.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(physical.browserLaunch).not.toHaveBeenCalled();
		expect(f.screenBrowser.opens).toEqual([]);
		expect(f.order.filter((entry) => entry.startsWith("qorpera_office_screen_browser_grant"))).toEqual([]);
		expect(f.failure).not.toHaveBeenCalled();
		// The member's own click at the dock is what opens it.
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		expect(f.screenBrowser.opens).toEqual(["desktop"]);
		// The member closes the browser on purpose: a reconnect does not bring it back.
		browsers[0].end();
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		// Nor does a fresh start of the desktop.
		await f.guest.stopResources(f.binding, new AbortController().signal);
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		expect(f.screenBrowser.opens).toEqual(["desktop"]);
		expect(f.failure).not.toHaveBeenCalled();
	}, 15000);
	it("answers a dock request for a browser that is already open by bringing its minimised window back, without choosing a tab", async () => {
		const f = await fixture({ browser: true });
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		windows.pages = [{} as never];
		// Open and not minimised: only looked at.
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(windows.send).toHaveBeenCalledTimes(1), { timeout: 3000 });
		expect(windows.send.mock.calls[0][0]).toBe("Browser.getWindowForTarget");
		// Minimised: restored through "normal", as CDP requires, and maximised again.
		windows.state = "minimized";
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(windows.state).toBe("maximized"), { timeout: 3000 });
		expect(windows.send.mock.calls.slice(1).map(([method, args]) => [method, args?.bounds?.windowState])).toEqual([
			["Browser.getWindowForTarget", undefined],
			["Browser.setWindowBounds", "normal"],
			["Browser.setWindowBounds", "maximized"],
		]);
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		// A failing window call never fails the request or the desktop.
		windows.send.mockRejectedValueOnce(new Error("target closed"));
		physical.browserRequest.mockResolvedValueOnce(true);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(f.failure).not.toHaveBeenCalled();
		expect(displays[0].stop).not.toHaveBeenCalled();
	});
	it("opens from the dock once SQL allows what it refused before: a refusal is not remembered", async () => {
		const f = await fixture({ browser: true });
		f.screenBrowser.authorized = false;
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		const asked = () => f.order.filter((entry) => entry.startsWith("qorpera_office_screen_browser_grant")).length;
		await vi.waitFor(() => expect(asked()).toBe(1), { timeout: 3000 });
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(asked()).toBe(1);
		expect(physical.browserLaunch).not.toHaveBeenCalled();
		expect(displays[0].stop).not.toHaveBeenCalled();
		// The member's next click, once SQL agrees, opens it.
		f.screenBrowser.authorized = true;
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		expect(f.screenBrowser.opens).toEqual(["desktop"]);
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("opens the screen's browser for a member at the dock with no run, and the agent's next run uses the same window", async () => {
		const f = await fixture({ browser: true });
		// A watcher's connection starts the desktop and opens nothing by itself.
		await f.guest.viewer.connect({ ...f.sharedViewer(), mode: "watch" }, new AbortController().signal);
		expect(physical.browserLaunch).not.toHaveBeenCalled();
		// The dock icon: one empty request file, consumed once by the service.
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		expect(f.screenBrowser.opens).toEqual(["desktop"]);
		expect(physical.browserLaunch.mock.calls[0][1]).toMatchObject({ binding: f.binding, grant: f.browserGrant });
		// No run exists, so no run authority was consulted to open it.
		expect(f.order.some((entry) => entry.startsWith("qorpera_native_office_browser_grant"))).toBe(false);

		const session = await f.create();
		const listed = await session.endpoint.perform(
			f.operation({ kind: "browser", action: "list_tabs" }),
			f.lease,
			f.effect(),
		);
		expect(JSON.stringify(listed)).toContain("tabs");
		// Same Chromium, same context: the run joined it instead of starting its own,
		// and it still proved its own grant under its lease before touching it.
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		expect(f.screenBrowser.opens).toEqual(["desktop"]);
		expect(f.order.some((entry) => entry.startsWith("qorpera_native_office_browser_grant"))).toBe(true);

		// Run end lets go of the browser. SQL (this fixture) still sees a member live on
		// the screen with input permission, so it keeps authorizing the relay's per-second check and
		// the window stays.
		await session.close();
		const checks = () => f.order.filter((entry) => entry.startsWith("qorpera_office_screen_browser_grant")).length;
		const before = checks();
		await vi.waitFor(() => expect(checks()).toBeGreaterThan(before + 1), { timeout: 4000 });
		expect(browsers[0].ended()).toBe(false);
		expect(browsers[0].close).not.toHaveBeenCalled();
		expect(displays[0].stop).not.toHaveBeenCalled();
		const next = await f.create();
		await next.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("closes the screen's browser about a second after the last entitled party is gone, and opens a fresh one for the next run", async () => {
		const f = await fixture({ browser: true });
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		await session.close();
		expect(browsers[0].ended()).toBe(false);
		// No lease, no live input viewer, and SQL's short tolerance is over: the
		// relay's next check is refused and the browser ends. The desktop stays.
		f.screenBrowser.authorized = false;
		await vi.waitFor(() => expect(browsers[0].ended()).toBe(true), { timeout: 4000 });
		expect(displays[0].stop).not.toHaveBeenCalled();
		expect(f.failure).not.toHaveBeenCalled();
		f.screenBrowser.authorized = true;
		const next = await f.create();
		await next.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		// The old process is confirmed gone before the same profile starts again.
		expect(browsers[0].close).toHaveBeenCalledOnce();
		expect(physical.browserLaunch).toHaveBeenCalledTimes(2);
		expect(f.screenBrowser.opens).toEqual(["agent", "agent"]);
	});
	it("starts nothing when SQL refuses the screen's browser, and an agent without its own grant cannot start it either", async () => {
		const f = await fixture({ browser: true });
		f.screenBrowser.authorized = false;
		await f.guest.viewer.connect({ ...f.sharedViewer(), mode: "watch" }, new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() =>
			expect(f.order.filter((entry) => entry.startsWith("qorpera_office_screen_browser_grant"))).toHaveLength(1),
		);
		expect(physical.browserLaunch).not.toHaveBeenCalled();
		// The desktop is untouched by a refused request.
		expect(displays[0].stop).not.toHaveBeenCalled();
		expect(f.failure).not.toHaveBeenCalled();
		f.screenBrowser.authorized = true;
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_native_office_browser_grant") throw new Error("Browser grant unavailable");
			return original(method, args);
		});
		const session = await f.create();
		await expect(
			session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect()),
		).rejects.toThrow();
		expect(physical.browserLaunch).not.toHaveBeenCalled();
		expect(f.screenBrowser.opens).toEqual([]);
	});
	it("reopens after somebody closed the window, and a run whose action failed still closes the browser it drove", async () => {
		const f = await fixture({ browser: true });
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		expect(f.screenBrowser.opens).toEqual(["agent"]);
		browsers[0].end();
		await session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		expect(browsers[0].close).toHaveBeenCalledOnce();
		expect(physical.browserLaunch).toHaveBeenCalledTimes(2);
		// Lost browser authority fails the action. Automation of a failed action must
		// be physically stopped, not merely let go of: that guarantee is unchanged.
		f.screenBrowser.authorized = false;
		await expect(
			session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect()),
		).rejects.toThrow();
		expect(browsers[1].close).toHaveBeenCalledOnce();
	});
	it("leaves a member's dock-opened browser alone when a run that never joined it fails a shell action", async () => {
		const f = await fixture({ browser: true });
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		const run = vi.spyOn(CompanyComputerLinuxCommands.prototype, "run").mockRejectedValue(new Error("shell broke"));
		const session = await f.create();
		const shell = f.operation({ kind: "shell", command: "false", timeoutMs: 1000 });
		// The gate's drainOnFailure runs for every failed action, not only browser ones.
		await expect(session.endpoint.perform(shell, f.lease, f.effect())).rejects.toThrow();
		expect(run).toHaveBeenCalledOnce();
		expect(browsers[0].close).not.toHaveBeenCalled();
		// Once the run has joined the browser, the same shell failure does close it:
		// its automation may be in flight and only a physical close proves it stopped.
		await session.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		await expect(session.endpoint.perform(shell, f.lease, f.effect())).rejects.toThrow();
		expect(browsers[0].close).toHaveBeenCalledOnce();
		// The run let go with that close: a further failure closes nothing the member reopens.
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledTimes(2), { timeout: 3000 });
		await expect(session.endpoint.perform(shell, f.lease, f.effect())).rejects.toThrow();
		expect(browsers[1].close).not.toHaveBeenCalled();
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("closes the screen's browser on the privacy fence and on a screen drain, before the desktop stops", async () => {
		const f = await fixture({ browser: true });
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		const order: string[] = [];
		browsers[0].close.mockImplementation(async () => void order.push("browser"));
		displays[0].stop.mockImplementation(async () => {
			order.push("desktop");
			displays[0].exited.resolve();
		});
		await f.guest.stopResources(f.binding, new AbortController().signal);
		expect(order).toEqual(["browser", "desktop"]);

		// A fresh desktop and browser, then the privacy fence.
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledTimes(2), { timeout: 3000 });
		f.state.privacy = "entering";
		f.state.version = 1;
		await f.guest.privacy.fence(f.challenge, new AbortController().signal);
		await vi.waitFor(() => expect(browsers[1].close).toHaveBeenCalledOnce());
		await f.guest.stopResources(f.binding, new AbortController().signal);
		expect(displays[1].stop).toHaveBeenCalledOnce();
		// No request is honoured behind the fence.
		physical.browserRequest.mockResolvedValue(true);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(physical.browserLaunch).toHaveBeenCalledTimes(2);
	});
	it("reports an unconfirmed browser exit as an unconfirmed drain", async () => {
		const f = await fixture({ browser: true });
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		browsers[0].close.mockRejectedValue(new Error("namespace still running"));
		await expect(f.guest.stopResources(f.binding, new AbortController().signal)).rejects.toThrow(
			"OFFICE_GUEST_DRAIN_UNCONFIRMED",
		);
	});
	it("retains both pulse and physical drain failures in safe fatal diagnostics", async () => {
		vi.useFakeTimers();
		const f = await fixture(),
			session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		f.call.mockRejectedValueOnce(Object.assign(new Error("secret registry URL and token"), { code: "ECONNRESET" }));
		displays[0].stop.mockRejectedValue(Object.assign(new Error("secret process path"), { code: "EACCES" }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.failure).toHaveBeenCalledOnce();
		const diagnostic = companyComputerFailureDiagnostic(f.failure.mock.calls[0][0]);
		expect(diagnostic.codes).toEqual([
			"OFFICE_GUEST_FAILED",
			"OFFICE_SHARED_PULSE_FAILED",
			"SHARED_SURFACE_UNCONFIRMED",
		]);
		expect(diagnostic.categories).toEqual(["transport", "filesystem-permission"]);
		expect(JSON.stringify(diagnostic)).not.toContain("secret");
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
	});
	it("distinguishes an unexpected desktop exit from a failed authority pulse", async () => {
		const f = await fixture(),
			session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		displays[0].exited.resolve();
		await vi.waitFor(() => expect(f.failure).toHaveBeenCalledOnce());
		expect(companyComputerFailureDiagnostic(f.failure.mock.calls[0][0]).codes).toEqual([
			"OFFICE_GUEST_FAILED",
			"OFFICE_DESKTOP_EXITED",
		]);
	});
	it("retries a lost heartbeat without ending a desktop whose authority remains valid", async () => {
		vi.useFakeTimers();
		const f = await fixture(),
			session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		f.lifecycleCall.mockRejectedValueOnce(new Error("lost heartbeat response"));
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.events().at(-1)).toMatchObject({ reason: "SCREEN_HEARTBEAT" });
		expect(displays[0].stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.events()[2]).toEqual(f.events()[3]);
		expect(displays[0].stop).not.toHaveBeenCalled();
		await f.guest.close();
	});
	it("waits for pending launcher cleanup when startup failed before returning a handle", async () => {
		const f = await fixture(),
			reaped = computerDeferred<void>();
		physical.launch.mockRejectedValueOnce(new Error("launcher timeout"));
		physical.drain.mockReturnValue(reaped.promise);
		const session = await f.create();
		const opening = session.endpoint
			.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect())
			.catch((error) => error);
		await vi.waitFor(() => expect(physical.drain).toHaveBeenCalledOnce());
		expect(f.events().some((e) => e.state === "closed")).toBe(false);
		reaped.resolve();
		expect(await opening).toBeInstanceOf(Error);
		expect(f.events().map((e) => e.state)).toEqual(["requested", "failed", "closed"]);
	});
	it("never claims closure after an unconfirmed handle-less launcher drain", async () => {
		const f = await fixture();
		physical.launch.mockRejectedValueOnce(new Error("launcher timeout"));
		physical.drain.mockRejectedValue(new Error("OFFICE_DESKTOP_DRAIN_UNCONFIRMED"));
		const session = await f.create();
		await expect(
			session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect()),
		).rejects.toThrow();
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
		expect(f.events().some((e) => e.state === "closed")).toBe(false);
	});
	it("reports ready only after launcher readiness and closed only after reaping", async () => {
		const f = await fixture(),
			ready = computerDeferred<void>(),
			reaped = computerDeferred<void>();
		const stop = vi.fn(async () => reaped.promise);
		physical.launch.mockImplementationOnce(async () => {
			expect(f.events().map((e) => e.state)).toEqual(["requested"]);
			return { ready: ready.promise, exited: reaped.promise, stop };
		});
		const session = await f.create();
		const opening = session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		await vi.waitFor(() => expect(physical.launch).toHaveBeenCalledOnce());
		expect(f.events().map((e) => e.state)).toEqual(["requested"]);
		ready.resolve();
		await opening;
		const closing = f.guest.close();
		await vi.waitFor(() => expect(stop).toHaveBeenCalled());
		expect(f.events().map((e) => e.state)).toEqual(["requested", "ready", "closing"]);
		reaped.resolve();
		await closing;
		expect(f.events().map((e) => e.state)).toEqual(["requested", "ready", "closing", "closed"]);
	});
	it("reaps the desktop despite a lost closing reply and accepts the recovered receipt", async () => {
		const f = await fixture(),
			session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		f.lifecycleCall.mockRejectedValueOnce(new Error("lost closing response"));
		await expect(f.guest.close()).resolves.toBeUndefined();
		expect(displays[0].stop).toHaveBeenCalled();
		expect(f.events().map((e) => e.state)).toEqual(["requested", "ready", "closing", "closing", "closed"]);
		expect(f.events()[2]).toEqual(f.events()[3]);
	});
	it("attempts physical cleanup but retains uncertainty when the registry remains unavailable", async () => {
		const f = await fixture(),
			session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		f.lifecycleCall.mockRejectedValue(new Error("registry offline"));
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
		expect(displays[0].stop).toHaveBeenCalled();
		expect(f.events().some((e) => e.state === "closed")).toBe(false);
	});
	it("cannot report closure when private readiness reporting and physical cleanup both fail", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		physical.privateStart.mockImplementationOnce(async () => ({
			close: vi.fn(async () => {
				throw new Error("namespace still alive");
			}),
			closed: new Promise(() => {}),
			connect: vi.fn(),
		}));
		f.lifecycleCall.mockImplementation(async (_method, args) => {
			if ((args.p_event as Record<string, unknown>).state === "ready") throw new Error("lost ready");
			return screenReceipt(args);
		});
		await expect(f.guest.privacy.secureSurface(f.challenge, f.run.signal)).rejects.toThrow(
			"PRIVATE_SURFACE_DRAIN_UNCONFIRMED",
		);
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
		expect(f.events().some((e) => e.state === "closed")).toBe(false);
	});
	it("refuses shared work at a registry version it has not been told, and admits it after the baseline", async () => {
		// A reset office: privacy version 16, shared, no retained challenge.
		const f = await fixture();
		f.state.version = 16;
		// The run was admitted at that registry version; only the guest has not been told it yet.
		f.resources.officePrivacyVersion = 16;
		const session = await f.create();
		const operation = f.operation({ kind: "screen", action: "open" });
		// Admission is refused at authorization already: no effect is ever attempted at an untold version.
		await expect(session.endpoint.authorize(operation, f.run.identity, f.lease, f.run.signal)).rejects.toThrow(
			"OFFICE_PRIVACY_FENCED",
		);
		expect(physical.launch).not.toHaveBeenCalled();
		f.guest.privacy.shared?.(16);
		// A lower baseline never replaces a higher one.
		f.guest.privacy.shared?.(3);
		const next = await f.create();
		await next.endpoint.authorize(operation, f.run.identity, f.lease, f.run.signal);
		await expect(next.endpoint.perform(operation, f.lease, f.effect())).resolves.toEqual({
			kind: "json",
			value: { screenId: f.binding.screenId, status: "open" },
		});
		expect(physical.launch).toHaveBeenCalledOnce();
		await f.guest.close();
	});
	it("constructs and authorizes without starting a guest, then opens inside the admitted effect", async () => {
		const f = await fixture();
		const session = await f.create();
		expect(f.call).not.toHaveBeenCalled();
		expect(f.boundary.assertReady).not.toHaveBeenCalled();
		expect(physical.prepare).not.toHaveBeenCalled();
		const operation = f.operation({ kind: "screen", action: "open" });
		await session.endpoint.authorize(operation, f.run.identity, f.lease, f.run.signal);
		expect(physical.launch).not.toHaveBeenCalled();
		physical.prepare.mockImplementation(async () => {
			expect(f.order).toContain("qorpera_native_office_operation:begin");
		});
		await expect(session.endpoint.perform(operation, f.lease, f.effect())).resolves.toEqual({
			kind: "json",
			value: { screenId: f.binding.screenId, status: "open" },
		});
		expect(physical.launch).toHaveBeenCalledOnce();
		await session.close();
		expect(displays[0].stop).not.toHaveBeenCalled();
		expect(f.events().map((e) => e.state)).toEqual(["requested", "ready"]);
		const next = await f.create();
		await next.endpoint.perform(operation, f.lease, f.effect());
		expect(physical.launch).toHaveBeenCalledOnce();
		await f.guest.close();
		expect(displays[0].stop).toHaveBeenCalled();
		expect(f.events().map((e) => e.state)).toEqual(["requested", "ready", "closing", "closed"]);
	});
	it("executes shell through the composed command adapter and leaves desktop power independent of session release", async () => {
		const f = await fixture();
		const run = vi
			.spyOn(CompanyComputerLinuxCommands.prototype, "run")
			.mockResolvedValue({ code: 0, stdout: "from cloud", stderr: "" });
		const session = await f.create();
		const result = await session.endpoint.perform(
			f.operation({ kind: "shell", command: "printf test", timeoutMs: 1000 }),
			f.lease,
			f.effect(),
		);
		expect(result).toEqual({ kind: "json", value: { code: 0, stdout: "from cloud", stderr: "" } });
		expect(run).toHaveBeenCalledOnce();
		await session.close();
		expect(displays[0].stop).not.toHaveBeenCalled();
	});
	it("fences a late startup before private entry and waits for every physical drain", async () => {
		const f = await fixture();
		const pending = computerDeferred<void>();
		physical.prepare.mockReturnValue(pending.promise);
		const session = await f.create();
		const action = session.endpoint
			.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect())
			.catch((error: unknown) => error);
		await vi.waitFor(() => expect(physical.prepare).toHaveBeenCalledOnce());
		f.state.privacy = "entering";
		f.state.version = 1;
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		await expect(f.guest.privacy.secureSurface(f.challenge, f.run.signal)).rejects.toThrow(
			"OFFICE_PHYSICAL_DRAIN_REQUIRED",
		);
		const drain = f.guest.stopResources(f.binding, f.run.signal);
		pending.resolve();
		expect(await action).toBeInstanceOf(Error);
		await drain;
		await f.guest.privacy.secureSurface(f.challenge, f.run.signal);
		expect(physical.privateStart).toHaveBeenCalledOnce();
		expect(displays).toHaveLength(0);
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("keeps repeated private fences idempotent and resumes shared work only after exit acknowledgement", async () => {
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		f.state.privacy = "entering";
		f.state.version = 1;
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		await f.guest.stopResources(f.binding, f.run.signal);
		await f.guest.privacy.secureSurface(f.challenge, f.run.signal);
		await f.guest.privacy.fence(structuredClone(f.challenge), f.run.signal);
		expect(privateCloses[0]).not.toHaveBeenCalled();
		const leave = { ...f.challenge, state: "leaving" as const, version: 2, challengeId: computerId(86) };
		f.state.privacy = "leaving";
		f.state.version = 2;
		await f.guest.privacy.fence(leave, f.run.signal);
		await f.guest.privacy.secureSurface(leave, f.run.signal);
		expect(privateCloses[0]).toHaveBeenCalledOnce();
		f.resources.officePrivacyVersion = 2;
		const next = await f.create();
		await expect(
			next.endpoint.authorize(
				f.operation({ kind: "screen", action: "open" }),
				f.run.identity,
				f.lease,
				f.run.signal,
			),
		).rejects.toThrow();
		f.state.privacy = "shared";
		await next.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		expect(physical.launch).toHaveBeenCalledTimes(2);
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("retains failed desktop drain and cannot prepare a private surface or claim whole cleanup", async () => {
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		displays[0].stop.mockRejectedValue(new Error("physical exit unknown"));
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		await expect(f.guest.stopResources(f.binding, f.run.signal)).rejects.toThrow("physical exit unknown");
		await expect(f.guest.privacy.secureSurface(f.challenge, f.run.signal)).rejects.toThrow(
			"OFFICE_PHYSICAL_DRAIN_REQUIRED",
		);
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
		expect(physical.privateStart).not.toHaveBeenCalled();
	});
	it.each(["member", "privacy", "challenge", "profile", "profileVersion", "screen"])(
		"rejects a changed private %s before starting a recovered sign-in surface",
		async (changed) => {
			const f = await fixture();
			await f.guest.privacy.fence(f.challenge, f.run.signal);
			const grant = structuredClone(f.privateViewer());
			if (changed === "member") {
				grant.memberId = computerId(88);
				grant.lease = {
					...grant.lease!,
					driver: { kind: "member", memberId: grant.memberId, sessionId: grant.viewerSessionId },
				};
			} else if (changed === "privacy") grant.privacyVersion++;
			else if (changed === "challenge") grant.privateSignIn!.challengeId = computerId(88);
			else if (changed === "profile") grant.privateSignIn!.profileId = computerId(88);
			else if (changed === "profileVersion") grant.privateSignIn!.profileVersion++;
			else {
				grant.binding = { ...grant.binding, screenGeneration: grant.binding.screenGeneration + 1 };
				grant.lease = { ...grant.lease!, binding: { ...grant.binding } };
			}
			await expect(f.guest.viewer.connect(grant, f.run.signal)).rejects.toThrow();
			expect(physical.privateStart).not.toHaveBeenCalled();
		},
	);
	it("keeps a recovered private surface alive after its viewer disconnects, until physical drain", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		const viewer = new AbortController();
		const first = await f.guest.viewer.connect(f.privateViewer(), viewer.signal);
		const options = physical.privateStart.mock.calls[0][0];
		first.socket.destroy();
		viewer.abort();
		expect(options.signal.aborted).toBe(false);
		const next = await f.guest.viewer.connect(f.privateViewer(), f.run.signal);
		next.socket.destroy();
		expect(physical.privateStart).toHaveBeenCalledOnce();
		await f.guest.stopResources(f.binding, f.run.signal);
		expect(options.signal.aborted).toBe(true);
		expect(privateCloses[0]).toHaveBeenCalledOnce();
	});
	it("ends only the private surface when its authority renewal is refused, then admits a fresh surface", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		const first = await f.guest.viewer.connect(f.privateViewer(), f.run.signal);
		first.socket.destroy();
		const options = physical.privateStart.mock.calls[0][0];
		// The real surface tears itself down before reporting; the fixture closes explicitly.
		await (await physical.privateStart.mock.results[0].value).close();
		options.onFailure(new Error("PRIVATE_SURFACE_AUTHORITY_UNCONFIRMED"));
		await vi.waitFor(() => expect(f.events().at(-1)).toMatchObject({ reason: "DESKTOP_EXITED" }));
		expect(f.failure).not.toHaveBeenCalled();
		const next = await vi.waitFor(async () => f.guest.viewer.connect(f.privateViewer(), f.run.signal));
		next.socket.destroy();
		expect(physical.privateStart).toHaveBeenCalledTimes(2);
		expect(f.failure).not.toHaveBeenCalled();
		await f.guest.close();
	});
	it("keeps an unconfirmed private teardown fatal for the guest", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		const first = await f.guest.viewer.connect(f.privateViewer(), f.run.signal);
		first.socket.destroy();
		const options = physical.privateStart.mock.calls[0][0];
		options.onFailure(new Error("PRIVATE_SURFACE_DRAIN_UNCONFIRMED"));
		await vi.waitFor(() => expect(f.failure).toHaveBeenCalledOnce());
		expect(companyComputerFailureDiagnostic(f.failure.mock.calls[0][0]).codes).toEqual([
			"OFFICE_GUEST_FAILED",
			"PRIVATE_SURFACE_DRAIN_UNCONFIRMED",
		]);
	});
	it("owns cancellation while a private surface is still starting and awaits its late cleanup", async () => {
		const f = await fixture();
		const pending = computerDeferred<void>();
		physical.privateStart.mockImplementationOnce(async (options) => {
			await pending.promise;
			options.signal.throwIfAborted();
			throw new Error("fixture must have cancelled startup");
		});
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		const viewer = new AbortController();
		const connecting = f.guest.viewer.connect(f.privateViewer(), viewer.signal).catch((error: unknown) => error);
		await vi.waitFor(() => expect(physical.privateStart).toHaveBeenCalledOnce());
		viewer.abort();
		expect(physical.privateStart.mock.calls[0][0].signal.aborted).toBe(true);
		let drained = false;
		const drain = f.guest.stopResources(f.binding, f.run.signal).then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		pending.resolve();
		expect(await connecting).toBeInstanceOf(Error);
		await drain;
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("retains private cleanup failure even when the adapter uses an unfamiliar error", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		await f.guest.privacy.secureSurface(f.challenge, f.run.signal);
		privateCloses[0].mockRejectedValue(new Error("namespace still running"));
		await expect(f.guest.stopResources(f.binding, f.run.signal)).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
	});
	it("refuses stale computer drains before touching the private surface", async () => {
		const f = await fixture();
		await f.guest.privacy.fence(f.challenge, f.run.signal);
		await f.guest.privacy.secureSurface(f.challenge, f.run.signal);
		await expect(f.guest.stopResources({ ...f.binding, computerGeneration: 2 }, f.run.signal)).rejects.toThrow(
			"OFFICE_GENERATION_MISMATCH",
		);
		expect(privateCloses[0]).not.toHaveBeenCalled();
	});
	it("rejects stale privacy and a different native gate before admitting another session", async () => {
		const f = await fixture();
		await f.create();
		await expect(
			f.guest.createSession({
				run: f.run,
				descriptor: f.descriptor,
				lease: f.lease,
				effects: f.effects,
				gate: new CompanyComputerScreenActionGate(),
			}),
		).rejects.toThrow("OFFICE_GATE_CHANGED");
		await f.guest.privacy.fence({ ...f.challenge, version: 2 }, f.run.signal);
		await expect(f.guest.privacy.fence(f.challenge, f.run.signal)).rejects.toThrow("OFFICE_PRIVACY_CHANGED");
	});
});
