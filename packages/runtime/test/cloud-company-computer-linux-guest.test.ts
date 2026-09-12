import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import { companyComputerFailureDiagnostic } from "@qorpera/runtime/cloud-company-computer-diagnostics";
import { CloudCompanyComputerEffectControl } from "@qorpera/runtime/cloud-company-computer-effect-control";
import { CompanyComputerScreenActionGate } from "@qorpera/runtime/cloud-company-computer-leases";
import { CompanyComputerLinuxCommands } from "@qorpera/runtime/cloud-company-computer-linux-commands";
import { CompanyComputerLinuxGuest } from "@qorpera/runtime/cloud-company-computer-linux-guest";
import { CompanyComputerScreenLifecyclePublisher } from "@qorpera/runtime/cloud-company-computer-screen-lifecycle";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerOperation,
	computerScope,
} from "./fixtures/company-computer.ts";
import { screenReceipt, screenStartup } from "./fixtures/screen-lifecycle.ts";

const physical = vi.hoisted(() => ({
	prepare: vi.fn(),
	launch: vi.fn(),
	close: vi.fn(),
	connect: vi.fn(),
	privateStart: vi.fn(),
	drain: vi.fn(),
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
		xSocket() {
			return "/run/office-screens/fixture/X1";
		}
	},
}));
vi.mock("../src/cloud-company-computer-linux-private-surface.ts", () => ({
	startCompanyComputerLinuxPrivateSurface: physical.privateStart,
}));
const runs: CloudNativeToolRun[] = [];
const guests: CompanyComputerLinuxGuest[] = [];
const displays: { stop: ReturnType<typeof vi.fn>; exited: ReturnType<typeof computerDeferred<void>> }[] = [];
const privateCloses: ReturnType<typeof vi.fn>[] = [];
beforeEach(() => {
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
	vi.restoreAllMocks();
});
async function fixture() {
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
	const resources = { officeGrantId: computerId(80), officeGrantVersion: 1, officePrivacyVersion: 0 };
	const descriptor = { state: "available" as const, scope, capabilities: ["shell" as const], resources };
	const state = { privacy: "shared", version: 0, epoch: 1 };
	const order: string[] = [];
	const call = vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
		order.push(`${method}:${args.p_action ?? "read"}`);
		if (method === "qorpera_check_runtime_office_shared_surface") {
			if (state.privacy !== "shared") throw new Error("private");
			return { state: "authorized", privacyVersion: state.version, epoch: state.epoch, validForMs: 5000 };
		}
		if (method === "qorpera_check_runtime_office_private_surface")
			return { state: "authorized", privacyState: state.privacy, version: state.version, validForMs: 5000 };
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
			browserProfilesRoot: "/srv/profiles",
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
