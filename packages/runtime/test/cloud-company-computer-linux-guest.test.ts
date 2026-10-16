import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import { CompanyComputerDesktopFolders } from "@qorpera/runtime/cloud-company-computer-desktop-folder";
import { companyComputerFailureDiagnostic } from "@qorpera/runtime/cloud-company-computer-diagnostics";
import { CloudCompanyComputerEffectControl } from "@qorpera/runtime/cloud-company-computer-effect-control";
import type {
	askCompanyComputerFolderHelper,
	CompanyComputerFolderRequest,
} from "@qorpera/runtime/cloud-company-computer-folder-helper-client";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import { CompanyComputerLinuxCommands } from "@qorpera/runtime/cloud-company-computer-linux-commands";
import { CompanyComputerLinuxGuest } from "@qorpera/runtime/cloud-company-computer-linux-guest";
import {
	COMPANY_COMPUTER_REGISTRY_REQUEST_MAX_BYTES,
	CompanyComputerRegistryUnansweredError,
	HttpCloudCompanyComputerRegistry,
} from "@qorpera/runtime/cloud-company-computer-registry-http";
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
/** Each screen's long-running shell; the real one has its own tests and Linux probe. */
type FixtureShellCommand = { id: string; runId: string; receiptId: string; command: string; startedAt: string };
const shells = vi.hoisted(
	() =>
		[] as {
			namespacePid: number | undefined;
			open: (FixtureShellCommand & { workedAt: string })[];
			ended: (FixtureShellCommand & { reason: string; endedAt: string })[];
			start: ReturnType<typeof vi.fn>;
			result: ReturnType<typeof vi.fn>;
			close: ReturnType<typeof vi.fn>;
			pause: ReturnType<typeof vi.fn>;
			reported: ReturnType<typeof vi.fn>;
		}[],
);
/** The processor time of each shell namespace, and the bytes its commands moved, as /proc would show them. */
const shellTicks = vi.hoisted(() => new Map<number, number>());
const shellBytes = vi.hoisted(() => new Map<number, number>());
vi.mock("../src/cloud-company-computer-linux-shell.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cloud-company-computer-linux-shell.ts")>();
	return {
		companyComputerShellBusy: actual.companyComputerShellBusy,
		readCompanyComputerShellUsage: async (pids: readonly number[]) =>
			new Map(
				pids.map((pid) => [
					pid,
					{ memoryBytes: 0, tasks: 1, cpuTicks: shellTicks.get(pid) ?? 0, ioBytes: shellBytes.get(pid) ?? 0 },
				]),
			),
		createCompanyComputerLinuxShellLauncher: () => async () => {
			throw new Error("NO_FIXTURE_SHELL_NAMESPACE");
		},
		CompanyComputerShellPressureGuard: class {
			close() {}
		},
		CompanyComputerLinuxShell: class {
			namespacePid: number | undefined = undefined;
			open: (FixtureShellCommand & { workedAt: string })[] = [];
			ended: (FixtureShellCommand & { reason: string; endedAt: string })[] = [];
			start = vi.fn(async (input: { command: string; runId: string; key: string }) => {
				this.namespacePid = 4200 + shells.indexOf(this);
				const at = new Date().toISOString();
				this.open.push({
					id: "00000000-0000-4000-8000-0000000000a1",
					runId: input.runId,
					receiptId: input.key,
					command: input.command,
					startedAt: at,
					workedAt: at,
				});
				return { sessionId: "00000000-0000-4000-8000-0000000000a1" };
			});
			result = vi.fn(async (input: { sessionId: string }) => ({
				sessionId: input.sessionId,
				state: "running",
				output: "building\n",
			}));
			close = vi.fn(async () => {
				this.namespacePid = undefined;
				const endedAt = new Date().toISOString();
				this.ended.push(
					...this.open.map(({ workedAt: _workedAt, ...open }) => ({ ...open, reason: "closed", endedAt })),
				);
				this.open = [];
			});
			pause = vi.fn(async () => undefined);
			reported = vi.fn((ids: readonly string[]) => {
				this.ended = this.ended.filter((ended) => !ids.includes(ended.id));
			});
			report = () => ({ open: [...this.open], ended: [...this.ended] });
			known = () => true;
			list = () => ({ commands: [], processes: 0 });
			constructor() {
				shells.push(this);
			}
		},
	};
});
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
	shells.length = 0;
	shellTicks.clear();
	shellBytes.clear();
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
async function fixture(
	options: { browser?: boolean; desktop?: boolean; folderHelper?: typeof askCompanyComputerFolderHelper } = {},
) {
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
		capabilities: [
			"shell" as const,
			...(options.browser ? ["browser" as const] : []),
			...(options.desktop ? ["desktop" as const] : []),
		],
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
		if (method === "qorpera_report_runtime_office_shell_activity")
			return {
				schema: "qorpera.office-shell-activity/v1",
				screens: (args.p_report as { screens: { screenId: string; busy: boolean }[] }).screens
					.filter((screen) => screen.busy)
					.map((screen) => screen.screenId),
				paused: false,
			};
		if (method === "qorpera_native_office_operation") {
			if (args.p_action === "authorize") return { state: "authorized" };
			if (args.p_action === "finish") return { state: "drained" };
			return { state: "admitted", resourceLeaseId: computerId(81), validForMs: 30000 };
		}
		if (method === "qorpera_folder_view_open") {
			const opened = order.filter((entry) => entry.startsWith(method)).length;
			return { schema: "qorpera.folder-view/v1", viewId: computerId(200 + opened), pass: `fixture-pass-${opened}` };
		}
		if (method === "qorpera_folder_view_close") return {};
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
		...(options.folderHelper
			? { folders: new CompanyComputerDesktopFolders({ registry: { call }, ask: options.folderHelper }) }
			: {}),
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
	it("runs a shell command in the screen's own shell and waits for it after the effect, outside the gate", async () => {
		const f = await fixture();
		const session = await f.create();
		const action = { kind: "shell", action: "start", command: "npm run build", waitMs: 5000 };
		const content = await session.endpoint.perform(f.operation(action), f.lease, f.effect());
		expect(content).toEqual({
			kind: "json",
			value: { sessionId: "00000000-0000-4000-8000-0000000000a1", state: "running", output: "building\n" },
		});
		expect(shells).toHaveLength(1);
		expect(shells[0].start).toHaveBeenCalledWith(expect.objectContaining({ command: "npm run build" }));
		expect(shells[0].result).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "00000000-0000-4000-8000-0000000000a1", waitMs: 5000 }),
		);
		// The run ends; its command does not. A later run on the screen reuses the shell.
		await session.close();
		expect(shells[0].close).not.toHaveBeenCalled();
		const next = await f.create();
		await next.endpoint.perform(f.operation(action), f.lease, f.effect());
		expect(shells).toHaveLength(1);
		expect(f.failure).not.toHaveBeenCalled();
	});

	it("reports each shell every 30 seconds: busy by processor time or data moved, its commands, and each end once", async () => {
		// The busy measure divides by the wall-clock time between samples, so the clock moves with the timers.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(
			f.operation({ kind: "shell", action: "start", command: "npm run dev", waitMs: 0 }),
			f.lease,
			f.effect(),
		);
		expect(shells[0].start).toHaveBeenCalledWith(
			expect.objectContaining({ command: "npm run dev", runId: f.run.identity.runId, key: expect.any(String) }),
		);
		// The receipt the platform matches is the start effect's own.
		expect(shells[0].open[0].receiptId).toBe(shells[0].start.mock.calls[0][0].key);
		const pid = shells[0].namespacePid!;
		const reports = () =>
			f.call.mock.calls
				.filter(([method]) => method === "qorpera_report_runtime_office_shell_activity")
				.map(([, args]) => args.p_report as { schema: string; screens: Record<string, unknown>[] });
		const command = {
			id: "00000000-0000-4000-8000-0000000000a1",
			runId: f.run.identity.runId,
			receiptId: expect.any(String),
			command: "npm run dev",
			startedAt: expect.any(String),
		};
		// The first sample of a namespace is never busy; the open command is reported.
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()).toEqual([
			{
				schema: "qorpera.office-shell-report/v1",
				screens: [
					{
						screenId: f.binding.screenId,
						busy: false,
						whole: true,
						open: [{ ...command, workedAt: expect.any(String) }],
						ended: [],
					},
				],
			},
		]);
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_report_runtime_office_shell_activity",
			{
				p_scope: expect.objectContaining({ companyComputerId: f.binding.companyComputerId }),
				p_computer_generation: 1,
				p_report: expect.objectContaining({ schema: "qorpera.office-shell-report/v1" }),
			},
			expect.any(AbortSignal),
		);
		// Ten processor-seconds since the last sample: busy.
		shellTicks.set(pid, 1000);
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()[1].screens[0]).toMatchObject({ busy: true });
		// Waiting again: not busy, still open.
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()[2].screens[0]).toMatchObject({
			busy: false,
			open: [expect.objectContaining({ id: command.id })],
		});
		// A slow download: almost no processor, but a megabyte moved in the sample: busy.
		shellTicks.set(pid, 1001);
		shellBytes.set(pid, 1024 * 1024);
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()[3].screens[0]).toMatchObject({ busy: true });
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()[4].screens[0]).toMatchObject({ busy: false });
		// The command exits: its end is reported once, then nothing is left to say.
		const { workedAt: _exitedWorkedAt, ...exited } = shells[0].open[0];
		shells[0].ended.push({ ...exited, reason: "exited", endedAt: new Date().toISOString() });
		shells[0].open = [];
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()[5].screens).toEqual([
			{
				screenId: f.binding.screenId,
				busy: false,
				whole: true,
				open: [],
				ended: [{ ...command, reason: "exited", endedAt: expect.any(String) }],
			},
		]);
		expect(shells[0].reported).toHaveBeenLastCalledWith([command.id]);
		await vi.advanceTimersByTimeAsync(60000);
		expect(reports()).toHaveLength(6);
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
	});

	it("reports what a screen's shell was running when it closed with the screen, once", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(
			f.operation({ kind: "shell", action: "start", command: "sleep 600", waitMs: 0 }),
			f.lease,
			f.effect(),
		);
		const reports = () =>
			f.call.mock.calls
				.filter(([method]) => method === "qorpera_report_runtime_office_shell_activity")
				.map(([, args]) => (args.p_report as { screens: Record<string, unknown>[] }).screens);
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()).toHaveLength(1);
		await session.close();
		await f.guest.stopResources(f.binding, new AbortController().signal);
		expect(shells[0].close).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(30000);
		expect(reports()[1]).toEqual([
			{
				screenId: f.binding.screenId,
				busy: false,
				whole: true,
				open: [],
				ended: [expect.objectContaining({ command: "sleep 600", reason: "closed" })],
			},
		]);
		await vi.advanceTimersByTimeAsync(60000);
		expect(reports()).toHaveLength(2);
	});

	it("keeps an end it could not report for the next report", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(
			f.operation({ kind: "shell", action: "start", command: "npm test", waitMs: 0 }),
			f.lease,
			f.effect(),
		);
		const { workedAt: _pressedWorkedAt, ...pressed } = shells[0].open[0];
		shells[0].ended.push({ ...pressed, reason: "pressure", endedAt: new Date().toISOString() });
		shells[0].open = [];
		const original = f.call.getMockImplementation()!;
		let refused = 0;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_report_runtime_office_shell_activity" && refused < 1) {
				refused++;
				throw new Error("request timed out");
			}
			return original(method, args);
		});
		await vi.advanceTimersByTimeAsync(30000);
		expect(shells[0].reported).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30000);
		expect(shells[0].reported).toHaveBeenCalledExactlyOnceWith(["00000000-0000-4000-8000-0000000000a1"]);
		expect(shells[0].ended).toEqual([]);
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
	});

	it("lets go of ends the registry keeps refusing, after ten reports, and reports again", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(
			f.operation({ kind: "shell", action: "start", command: "npm test", waitMs: 0 }),
			f.lease,
			f.effect(),
		);
		const { workedAt: _refusedWorkedAt, ...refused } = shells[0].open[0];
		shells[0].ended.push({ ...refused, reason: "exited", endedAt: new Date().toISOString() });
		shells[0].open = [];
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_report_runtime_office_shell_activity")
				throw new Error("Invalid office shell activity");
			return original(method, args);
		});
		await vi.advanceTimersByTimeAsync(9 * 30000);
		expect(shells[0].reported).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30000);
		expect(shells[0].reported).toHaveBeenCalledExactlyOnceWith([refused.id]);
		expect(shells[0].ended).toEqual([]);
		f.call.mockImplementation(original);
		const calls = f.call.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60000);
		// Nothing is left to say: no open command, nothing busy.
		expect(
			f.call.mock.calls.slice(calls).filter(([method]) => method === "qorpera_report_runtime_office_shell_activity"),
		).toEqual([]);
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
	});

	it("fits a full shell into one registry request: ends first, the cut screen not whole, the rest next time", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(
			f.operation({ kind: "shell", action: "start", command: "sleep 600", waitMs: 0 }),
			f.lease,
			f.effect(),
		);
		// 64 commands still open and 64 ended, each 300 four-byte characters: about 180 KB, more than one request holds.
		const long = "🛠".repeat(300);
		const at = (n: number) => new Date(Date.UTC(2026, 9, 4, 12, 0, n)).toISOString();
		const item = (n: number) => ({
			id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
			runId: f.run.identity.runId,
			receiptId: randomUUID(),
			command: long,
			startedAt: at(0),
		});
		shells[0].open = Array.from({ length: 64 }, (_, n) => ({ ...item(n + 1), workedAt: at(n) }));
		shells[0].ended = Array.from({ length: 64 }, (_, n) => ({ ...item(n + 101), reason: "exited", endedAt: at(n) }));
		// The real transport, with its size bound, carries every report.
		const bodies: string[] = [];
		const transport = new HttpCloudCompanyComputerRegistry({
			supabaseUrl: "https://control.example.test",
			serviceRoleKey: "sb_secret_fixture",
			fetch: async (_url, init) => {
				bodies.push(String(init?.body));
				return Response.json({ schema: "qorpera.office-shell-activity/v1", screens: [], paused: false });
			},
		});
		const original = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) =>
			method === "qorpera_report_runtime_office_shell_activity"
				? transport.call(method, args, new AbortController().signal)
				: original(method, args),
		);
		type Sent = { p_report: { screens: { whole: boolean; open: { id: string }[]; ended: { id: string }[] }[] } };
		await vi.advanceTimersByTimeAsync(30000);
		expect(bodies).toHaveLength(1);
		expect(Buffer.byteLength(bodies[0])).toBeLessThanOrEqual(COMPANY_COMPUTER_REGISTRY_REQUEST_MAX_BYTES);
		const first = (JSON.parse(bodies[0]) as Sent).p_report.screens[0];
		// Every end the platform has not heard of goes first; the open commands fill what is left, so the list is cut.
		expect(first.ended).toHaveLength(64);
		expect(first.open.length).toBeGreaterThan(0);
		expect(first.open.length).toBeLessThan(64);
		expect(first.whole).toBe(false);
		// The latest worked first.
		expect(first.open.map((open) => open.id)).toEqual(
			Array.from({ length: first.open.length }, (_, n) => item(64 - n).id),
		);
		expect(shells[0].reported).toHaveBeenCalledExactlyOnceWith(first.ended.map((ended) => ended.id));
		// With the ends delivered, every open command fits: the screen is whole again.
		await vi.advanceTimersByTimeAsync(30000);
		const second = (JSON.parse(bodies[1]) as Sent).p_report.screens[0];
		expect(second.ended).toEqual([]);
		expect(second.open).toHaveLength(64);
		expect(second.whole).toBe(true);
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
	});

	it("stops every shell, with the reason, when a report finds the company paused", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const f = await fixture();
		const session = await f.create();
		await session.endpoint.perform(
			f.operation({ kind: "shell", action: "start", command: "sleep 600", waitMs: 0 }),
			f.lease,
			f.effect(),
		);
		const original = f.call.getMockImplementation()!;
		const answer = { paused: false };
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) =>
			method === "qorpera_report_runtime_office_shell_activity"
				? answer.paused
					? { schema: "qorpera.office-shell-activity/v1", screens: [], paused: true }
					: original(method, args)
				: original(method, args),
		);
		await vi.advanceTimersByTimeAsync(30000);
		expect(shells[0].pause).not.toHaveBeenCalled();
		answer.paused = true;
		await vi.advanceTimersByTimeAsync(30000);
		expect(shells[0].pause).toHaveBeenCalledExactlyOnceWith(
			"Stopped because the company was paused; start the command again when work resumes.",
		);
		// The shell itself stays, so the agent can read why and start again after the pause.
		expect(shells[0].close).not.toHaveBeenCalled();
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
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
	it("keeps the open browser when a new run's join check gets no answer, and joins it on the next action", async () => {
		// Frozen timers keep the browser double's per-second relay check out of the way.
		vi.useFakeTimers();
		const f = await fixture({ browser: true });
		const first = await f.create();
		await first.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		await first.close();
		const original = f.call.getMockImplementation()!;
		let lost = 0;
		f.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_office_screen_browser_grant" && args.p_opener === null && lost < 1) {
				lost++;
				throw new CompanyComputerRegistryUnansweredError(new Error("request timed out"));
			}
			return original(method, args);
		});
		const next = await f.create();
		await expect(
			next.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect()),
		).rejects.toThrow("BROWSER_ACCESS_UNCONFIRMED");
		expect(lost).toBe(1);
		expect(browsers[0].ended()).toBe(false);
		expect(browsers[0].close).not.toHaveBeenCalled();
		await next.endpoint.perform(f.operation({ kind: "browser", action: "list_tabs" }), f.lease, f.effect());
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
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
	it("refuses a whole-screen picture while the member's dock-opened window holds a password, though the run never joined it", async () => {
		const f = await fixture({ browser: true, desktop: true });
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		// The member is typing a password into the window they opened.
		const typed = { values: ["hunter2"] };
		// Its private boxes' values; asked with the private attribute, the text it shows (nothing hidden, E3c-3).
		const frame = {
			isDetached: () => false,
			evaluate: async (_script: unknown, arg?: unknown) => (typeof arg === "string" ? "" : typed.values),
		};
		windows.pages = [{ isClosed: () => false, frames: () => [frame] }] as never[];
		const capture = vi
			.spyOn(CompanyComputerLinuxCommands.prototype, "capturePng")
			.mockRejectedValue(new Error("CAPTURE_REACHED"));
		const session = await f.create();
		const desktop = f.operation({ kind: "screenshot", surface: "desktop" });
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow("PRIVATE_FIELD_ON_SCREEN");
		expect(capture).not.toHaveBeenCalled();
		// The check is about this window, not about joining it: the run still never opened or joined a browser.
		expect(physical.browserLaunch).toHaveBeenCalledOnce();
		expect(f.order.some((entry) => entry.startsWith("qorpera_native_office_browser_grant"))).toBe(false);
		// Once the box is empty the capture goes ahead.
		typed.values = [];
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow("CAPTURE_REACHED");
		expect(capture).toHaveBeenCalledOnce();
		// A window the member closed is not on the screen: its stale pages are not read.
		typed.values = ["hunter2"];
		browsers[0].end();
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow("CAPTURE_REACHED");
		expect(capture).toHaveBeenCalledTimes(2);
		await session.close();
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

/** The folder helper as the screen's mount asks it: each request takes the next answer queued for its op. */
function folderHelper() {
	const asked: CompanyComputerFolderRequest[] = [];
	const queued = new Map<string, unknown[]>();
	const ask = vi.fn(async (request: CompanyComputerFolderRequest) => {
		asked.push(request);
		return queued.get(request.op)?.shift();
	});
	return {
		asked,
		ask: ask as unknown as typeof askCompanyComputerFolderHelper,
		answer: (op: CompanyComputerFolderRequest["op"], ...answers: unknown[]) => {
			queued.set(op, [...(queued.get(op) ?? []), ...answers]);
		},
		ops: () => asked.map((request) => request.op),
	};
}

describe("each desktop's mount of the company folder (helper stand-in; the mount itself has its own tests)", () => {
	it("starts a run's desktop on the run's mount, keeps it while the mount runs, and starts it again on a mount made again", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		const name = `desktop-${f.binding.screenId}`;
		const session = await f.create();
		const open = f.operation({ kind: "screen", action: "open" });
		h.answer("mount", { answer: "mounted" }, { answer: "mounted" });
		await session.endpoint.perform(open, f.lease, f.effect());
		expect(h.asked).toEqual([
			{
				op: "mount",
				name,
				view: { environmentId: f.binding.environmentId, viewId: computerId(201), pass: "fixture-pass-1" },
			},
		]);
		expect(physical.launch).toHaveBeenCalledOnce();
		expect(physical.launch.mock.calls[0][2]).toEqual({ company: { name, epoch: 1 } });
		// The same run on a mount that still runs: the desktop goes on as it is.
		h.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(201), program: "running" }] });
		await session.endpoint.perform(open, f.lease, f.effect());
		expect(physical.launch).toHaveBeenCalledOnce();
		// The mount's program ended: the mount is made again, on a new view, and the desktop starts again on it.
		h.answer("list", { answer: "list", mounts: [{ name, viewId: computerId(201), program: "closed" }] });
		h.answer("unmount", { answer: "closed", unmounted: true });
		await session.endpoint.perform(open, f.lease, f.effect());
		expect(h.ops()).toEqual(["mount", "list", "list", "unmount", "mount"]);
		expect(displays[0].stop).toHaveBeenCalledOnce();
		expect(physical.launch).toHaveBeenCalledTimes(2);
		expect(physical.launch.mock.calls[1][2]).toEqual({ company: { name, epoch: 2 } });
		expect(f.order.filter((entry) => entry.startsWith("qorpera_folder_view"))).toEqual([
			"qorpera_folder_view_open:read",
			"qorpera_folder_view_close:read",
			"qorpera_folder_view_open:read",
		]);
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("gives a run's screen back, with no desktop, when its mount cannot be made", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		const session = await f.create();
		h.answer("mount", { answer: "failed" });
		await expect(
			session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect()),
		).resolves.toEqual({
			kind: "json",
			value: {
				action: "open",
				completed: false,
				refused: { code: "COMPANY_FOLDER_UNAVAILABLE", message: "company folder is unavailable" },
			},
		});
		expect(physical.launch).not.toHaveBeenCalled();
		expect(f.order.filter((entry) => entry.startsWith("qorpera_folder_view"))).toEqual([
			"qorpera_folder_view_open:read",
			"qorpera_folder_view_close:read",
		]);
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("unmounts a mount made after its run's open was cancelled, a minute later with no desktop", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		const session = await f.create();
		const mounting = computerDeferred<unknown>();
		h.answer("mount", mounting.promise);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const cancel = new AbortController();
		const asked = session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, {
			...f.effect(),
			signal: cancel.signal,
		});
		asked.catch(() => undefined);
		await vi.waitFor(() => expect(h.ops()).toEqual(["mount"]));
		cancel.abort(new Error("fixture cancelled the open"));
		await expect(asked).rejects.toThrow();
		// The helper answers after the caller left: nothing starts on that mount, and it goes after a minute.
		mounting.resolve({ answer: "mounted" });
		h.answer("unmount", { answer: "saved", report: { commitId: null, seq: null, paths: [] }, unmounted: true });
		await vi.advanceTimersByTimeAsync(59_000);
		expect(h.ops()).toEqual(["mount"]);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(f.order).toContain("qorpera_folder_view_close:read"));
		expect(h.asked.at(-1)).toEqual({
			op: "unmount",
			name: `desktop-${f.binding.screenId}`,
			final: false,
			timeoutMs: 30000,
		});
		expect(physical.launch).not.toHaveBeenCalled();
	});
	it("moves the mount to the view of a member who takes control, and a shared viewer asks nothing", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		const name = `desktop-${f.binding.screenId}`;
		const session = await f.create();
		h.answer("mount", { answer: "mounted" });
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		expect(h.ops()).toEqual(["mount"]);
		h.answer("switch", { answer: "switched" });
		const viewer = f.sharedViewer();
		await f.guest.viewer.connect(
			{
				...viewer,
				mode: "control",
				lease: {
					...f.lease,
					epoch: 1,
					driver: { kind: "member", memberId: viewer.memberId, sessionId: viewer.viewerSessionId },
				},
			},
			new AbortController().signal,
		);
		expect(h.asked.at(-1)).toEqual({
			op: "switch",
			name,
			view: { environmentId: f.binding.environmentId, viewId: computerId(202), pass: "fixture-pass-2" },
		});
		// The member's view reaches the running desktop through the same mount: nothing starts again.
		expect(physical.launch).toHaveBeenCalledOnce();
		expect(displays[0].stop).not.toHaveBeenCalled();
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("starts a desktop a viewer opened without a mount again on the first run's mount", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		await f.guest.viewer.connect(f.sharedViewer(), new AbortController().signal);
		expect(physical.launch.mock.calls[0][2]).toEqual({ company: undefined });
		const session = await f.create();
		h.answer("mount", { answer: "mounted" });
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		expect(displays[0].stop).toHaveBeenCalledOnce();
		expect(physical.launch.mock.calls[1][2]).toEqual({
			company: { name: `desktop-${f.binding.screenId}`, epoch: 1 },
		});
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("unmounts the screen's mount, and closes its view, once its desktop has stopped", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		const session = await f.create();
		h.answer("mount", { answer: "mounted" });
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		h.answer("unmount", { answer: "saved", report: { commitId: null, seq: null, paths: [] }, unmounted: true });
		await session.close();
		await f.guest.stopResources(f.binding, new AbortController().signal);
		expect(displays[0].stop).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(f.order).toContain("qorpera_folder_view_close:read"));
		expect(h.asked.at(-1)).toEqual({
			op: "unmount",
			name: `desktop-${f.binding.screenId}`,
			final: false,
			timeoutMs: 30000,
		});
	});
	it("answers a drain only once the screen's mount published its last changes and went, after its desktop stopped", async () => {
		const h = folderHelper();
		const f = await fixture({ folderHelper: h.ask });
		const session = await f.create();
		h.answer("mount", { answer: "mounted" });
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		await session.close();
		const unmount = computerDeferred<unknown>();
		h.answer("unmount", unmount.promise);
		let drained = false;
		const stopping = f.guest
			.stopResources(f.binding, new AbortController().signal, { until: performance.now() + 19000 })
			.then(() => {
				drained = true;
			});
		await vi.waitFor(() => expect(h.ops()).toEqual(["mount", "unmount"]));
		expect(displays[0].stop).toHaveBeenCalledOnce();
		expect(h.asked[1]).toMatchObject({ op: "unmount", name: `desktop-${f.binding.screenId}`, final: false });
		expect(drained).toBe(false);
		unmount.resolve({ answer: "saved", report: { commitId: null, seq: null, paths: [] }, unmounted: true });
		await stopping;
		// The view closed before the drain was answered, and no release asked a second boundary.
		expect(f.order.filter((entry) => entry.startsWith("qorpera_folder_view"))).toEqual([
			"qorpera_folder_view_open:read",
			"qorpera_folder_view_close:read",
		]);
		expect(h.ops()).toEqual(["mount", "unmount"]);
	});
	it("holds a desktop screenshot back until the company folder released the desktop's reads, and says why", async () => {
		const h = folderHelper();
		const f = await fixture({ desktop: true, folderHelper: h.ask });
		const session = await f.create();
		h.answer("mount", { answer: "mounted" });
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		const png = Buffer.alloc(33);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.writeUInt32BE(13, 8);
		png.write("IHDR", 12, "ascii");
		png.writeUInt32BE(1920, 16);
		png.writeUInt32BE(1200, 20);
		const capture = vi.spyOn(CompanyComputerLinuxCommands.prototype, "capturePng").mockResolvedValue(png);
		h.answer(
			"boundary",
			{ answer: "refused", report: { commitId: null, seq: null, paths: [], refused: "stopped" } },
			{ answer: "saved", report: { commitId: "commit-1", seq: 1, paths: [] } },
		);
		const desktop = f.operation({ kind: "screenshot", surface: "desktop" });
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).resolves.toEqual({
			kind: "json",
			value: {
				screenId: f.binding.screenId,
				surface: "desktop",
				completed: false,
				heldBack: {
					code: "COMPANY_FOLDER_HELD_BACK",
					message: "the company is paused, so the company folder holds the screenshot back",
				},
			},
		});
		expect(capture).toHaveBeenCalledOnce();
		expect(h.asked.at(-1)).toMatchObject({ op: "boundary", name: `desktop-${f.binding.screenId}`, final: false });
		// Released: the picture goes on to its publish, which this fixture refuses.
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow("NO_FIXTURE_CAPTURE");
		expect(h.ops()).toEqual(["mount", "list", "boundary", "list", "boundary"]);
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
	});
	/** A run's desktop on the screen's mount, whose screenshots the company folder decides on. */
	async function screenshots(h: ReturnType<typeof folderHelper>, browser = false) {
		const f = await fixture({ desktop: true, browser, folderHelper: h.ask });
		const session = await f.create();
		h.answer("mount", { answer: "mounted" });
		await session.endpoint.perform(f.operation({ kind: "screen", action: "open" }), f.lease, f.effect());
		const png = Buffer.alloc(33);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.writeUInt32BE(13, 8);
		png.write("IHDR", 12, "ascii");
		png.writeUInt32BE(1920, 16);
		png.writeUInt32BE(1200, 20);
		vi.spyOn(CompanyComputerLinuxCommands.prototype, "capturePng").mockResolvedValue(png);
		const desktop = f.operation({ kind: "screenshot", surface: "desktop" });
		const heldBack = (message: string) => ({
			kind: "json",
			value: {
				screenId: f.binding.screenId,
				surface: "desktop",
				completed: false,
				heldBack: { code: "COMPANY_FOLDER_HELD_BACK", message },
			},
		});
		return { f, session, desktop, heldBack };
	}
	const refusal = (refused: string) => ({
		answer: "refused",
		report: { commitId: null, seq: null, paths: [], refused },
	});
	it.each([
		["a closed view", { answer: "closed" }],
		["a read no longer readable", refusal("unreadable")],
		["a read log that cannot be shown complete", refusal("unproven")],
	])("stops the desktop before its mount goes after %s, and starts it again on a new mount", async (_case, answer) => {
		const h = folderHelper();
		const { f, session, desktop, heldBack } = await screenshots(h);
		const name = `desktop-${f.binding.screenId}`;
		// What the helper had been asked when the desktop stopped.
		const stopped: string[][] = [];
		displays[0].stop.mockImplementation(async () => {
			stopped.push(h.ops());
			displays[0].exited.resolve();
		});
		h.answer("boundary", answer);
		h.answer("drop", { answer: "dropped" });
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).resolves.toEqual(
			heldBack("the company folder was restarted on this screen; take the screenshot again"),
		);
		// The desktop, with the apps that hold what it read, stopped before the mount went; the session goes on.
		expect(stopped).toEqual([["mount", "list", "boundary"]]);
		expect(h.ops()).toEqual(["mount", "list", "boundary", "drop"]);
		expect(h.asked.at(-1)).toEqual({ op: "drop", name });
		expect(physical.launch).toHaveBeenCalledOnce();
		// The run's next action starts the desktop again, on a mount made again under a new view.
		h.answer("mount", { answer: "mounted" });
		h.answer("boundary", { answer: "saved", report: { commitId: "commit-1", seq: 1, paths: [] } });
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow("NO_FIXTURE_CAPTURE");
		expect(physical.launch).toHaveBeenCalledTimes(2);
		expect(physical.launch.mock.calls[1][2]).toEqual({ company: { name, epoch: 2 } });
		expect(h.ops()).toEqual(["mount", "list", "boundary", "drop", "mount", "boundary"]);
		expect(f.order.filter((entry) => entry.startsWith("qorpera_folder_view"))).toEqual([
			"qorpera_folder_view_open:read",
			"qorpera_folder_view_close:read",
			"qorpera_folder_view_open:read",
		]);
		expect(f.failure).not.toHaveBeenCalled();
		await session.close();
	});
	it("drains the screen when the way out's stop fails, and its mount goes only once the drain stopped the desktop", async () => {
		const h = folderHelper();
		const { f, session, desktop } = await screenshots(h);
		displays[0].stop.mockRejectedValueOnce(new Error("fixture desktop did not stop"));
		// What the helper had been asked when the drain confirmed the desktop gone.
		const drained: string[][] = [];
		physical.drain.mockImplementation(async () => void drained.push(h.ops()));
		h.answer("boundary", refusal("unreadable"));
		h.answer("drop", { answer: "dropped" });
		// The drain ends the run's session on the screen, the screenshot with it.
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow();
		await vi.waitFor(() => expect(f.order).toContain("qorpera_folder_view_close:read"));
		expect(drained).toEqual([["mount", "list", "boundary"]]);
		// Then the mount went without a boundary, and its view closed.
		expect(h.ops()).toEqual(["mount", "list", "boundary", "drop"]);
		expect(f.events().find((event) => event.state === "closing")).toMatchObject({ reason: "AUTHORITY_LOST" });
		expect(f.failure).not.toHaveBeenCalled();
	});
	it("keeps the mount for the stop control when neither the way out nor its drain can confirm the browser gone", async () => {
		const h = folderHelper();
		const { f, session, desktop } = await screenshots(h, true);
		physical.browserRequest.mockResolvedValueOnce(true);
		await vi.waitFor(() => expect(physical.browserLaunch).toHaveBeenCalledOnce(), { timeout: 3000 });
		browsers[0].close.mockRejectedValue(new Error("namespace still running"));
		h.answer("boundary", refusal("unreadable"));
		h.answer("drop", { answer: "dropped" });
		await expect(session.endpoint.perform(desktop, f.lease, f.effect())).rejects.toThrow();
		await vi.waitFor(() => expect(f.failure).toHaveBeenCalledOnce());
		const failed = f.failure.mock.calls[0][0] as Error & { cause: Error & { cause: AggregateError } };
		expect(failed.cause.message).toBe("OFFICE_DESKTOP_STOP_FAILED");
		// The way out's stop failed on the browser, and so did the drain after it.
		expect(failed.cause.cause.errors).toHaveLength(2);
		expect(failed.cause.cause.errors[1]).toMatchObject({ message: "OFFICE_GUEST_DRAIN_UNCONFIRMED" });
		await expect(f.guest.close()).rejects.toThrow("OFFICE_GUEST_DRAIN_UNCONFIRMED");
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The drain stopped the desktop, but the browser's own namespace may still read the mount: no drop, no view
		// closed. The mount is the stop control's now.
		expect(displays[0].stop).toHaveBeenCalledOnce();
		expect(h.ops()).toEqual(["mount", "list", "boundary"]);
		expect(f.order).not.toContain("qorpera_folder_view_close:read");
	});
});
