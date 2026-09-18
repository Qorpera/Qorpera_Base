import type { CompanyComputerViewChannel } from "@qorpera/cloud-client/cloud-company-computer-view-channel";
import type { CloudCompanyComputerViews } from "@qorpera/cloud-client/cloud-company-computer-views";
import { CloudMemberBrowserRecovery } from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { CloudMemberCompanyComputerClient } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openMemberBrowserRecoveryWindow } from "../src/member-browser-recovery-window.ts";
import { openMemberCompanyComputerWindow } from "../src/member-company-computer-window.ts";

const electron = vi.hoisted(() => {
	const partition = {
		setPermissionCheckHandler: vi.fn(),
		setPermissionRequestHandler: vi.fn(),
		setDevicePermissionHandler: vi.fn(),
		setDisplayMediaRequestHandler: vi.fn(),
		on: vi.fn(),
		webRequest: { onBeforeRequest: vi.fn() },
	};
	class Window {
		destroyed = false;
		closed: (() => void)[] = [];
		handlers = new Map<
			string,
			(event: { sender: unknown; senderFrame: { url: string } | null }, input: unknown) => Promise<unknown>
		>();
		readonly webContents = {
			mainFrame: { url: "" },
			ipc: {
				handle: (name: string, handler: Window["handlers"] extends Map<string, infer H> ? H : never) => {
					this.handlers.set(name, handler);
				},
			},
			setWebRTCIPHandlingPolicy: vi.fn(),
			setWindowOpenHandler: vi.fn(),
			on: vi.fn(),
		};
		readonly options: unknown;
		constructor(options: unknown) {
			this.options = options;
		}
		once(_name: string, handler: () => void) {
			this.closed.push(handler);
		}
		isDestroyed() {
			return this.destroyed;
		}
		destroy() {
			this.destroyed = true;
			for (const handler of this.closed) handler();
		}
		async loadFile(path: string) {
			this.webContents.mainFrame.url = `file://${path}`;
		}
		show() {}
	}
	return { Window, partition };
});
vi.mock("electron", () => ({ BrowserWindow: electron.Window, session: { fromPartition: () => electron.partition } }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
beforeEach(() => vi.clearAllMocks());
async function fixture(manage = true, viewing = false) {
	const calls: { method: string; args: Record<string, unknown> }[] = [],
		state = { current: true, loseStart: false, loseGrant: false, scope };
	const intent = {
		schema: "qorpera.office-start-intent/v1",
		intentId: id(9),
		companyComputerId: id(3),
		computerGeneration: 1,
		state: "requested",
	};
	let startIntent: typeof intent | null = null,
		grant: { grantId: string; version: number; state: string; capabilities: string[] } | null = null;
	const client = new CloudMemberCompanyComputerClient({
		companyId: id(1),
		environmentId: id(2),
		supabaseUrl: "https://control.test",
		publishableKey: "public",
		accessToken: async () => "token",
		fetch: async (url, init) => {
			const method = String(url).split("/").at(-1)!,
				args = JSON.parse(init!.body as string);
			calls.push({ method, args });
			if (method === "qorpera_member_office_catalog")
				return Response.json({
					companyId: id(1),
					environmentId: id(2),
					canManage: manage,
					scope: state.scope,
					staff: [{ staffAgentId: id(5), name: "Agent" }],
					nextAfter: null,
				});
			if (method === "qorpera_runtime_office_start_status")
				return Response.json({
					scope: state.scope,
					computerGeneration: 1,
					officeState: "provisioning",
					intent: startIntent,
				});
			if (method === "qorpera_request_runtime_office_start") {
				startIntent = intent;
				if (state.loseStart) return new Response(null, { status: 503 });
				return Response.json(intent);
			}
			if (method === "qorpera_cancel_runtime_office_start") {
				startIntent = { ...intent, state: "cancelled" };
				return Response.json(startIntent);
			}
			if (method === "qorpera_configure_runtime_office_access") {
				grant = {
					grantId: id(6),
					version: (args.p_expected_version as number) + 1,
					state: args.p_enabled ? "active" : "revoked",
					capabilities: args.p_capabilities as string[],
				};
				if (state.loseGrant) return new Response(null, { status: 503 });
			}
			if (["qorpera_runtime_office_access_status", "qorpera_configure_runtime_office_access"].includes(method))
				return Response.json({ schema: "qorpera.office-access-status/v1", scope, staffAgentId: id(5), grant });
			throw new Error("Unexpected RPC");
		},
	});
	const binding = {
		...scope,
		screenId: id(11),
		staffAgentId: id(5),
		computerGeneration: 1,
		screenGeneration: 1,
		screenOrdinal: 1,
	};
	const channel: CompanyComputerViewChannel = {
		readyState: 1,
		protocol: "",
		binaryType: "arraybuffer",
		onmessage: null,
		onclose: null,
		onerror: null,
		onopen: null,
		send: vi.fn(),
		close: vi.fn(),
	};
	const close = vi.fn(async () => undefined);
	const viewClient = {
		status: vi.fn(async () => ({
			scope,
			computerGeneration: 1,
			state: "active",
			privacyState: "shared",
			privacyVersion: 0,
			screens: [{ binding, epoch: 1, drainPending: false, takeoverMemberId: null, driver: "agent" }],
			viewers: [{ viewerSessionId: id(20), screenId: id(11), mode: "watch", state: "issued" }],
		})),
		connectScreen: vi.fn(async (_input: { signal: AbortSignal }) => ({
			binding,
			connectionId: id(20),
			mode: "watch",
			channel,
			close,
		})),
		cancel: vi.fn(async () => undefined),
	};
	const window = (await openMemberCompanyComputerWindow({
		owner: {} as BrowserWindow,
		directory: "/synthetic",
		title: "Company",
		client,
		views: viewing ? () => viewClient as unknown as CloudCompanyComputerViews : undefined,
		current: () => state.current,
	})) as unknown as InstanceType<typeof electron.Window>;
	const handler = window.handlers.get("company-computer:member")!,
		event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
	return {
		window,
		calls,
		state,
		viewClient,
		binding,
		channel,
		close,
		viewRequest: (value: unknown, source: Parameters<typeof handler>[0] = event) =>
			window.handlers.get("company-computer:view")!(source, value),
		event,
		request: (value: unknown, source: Parameters<typeof handler>[0] = event) => handler(source, value),
		refresh: () => handler(event, { method: "catalog", after: null }),
	};
}
describe("member Company Computer host", () => {
	it("fences the cleanup window by exact frame, account and lifetime without company access", async () => {
		const rpc = vi.fn(async () => ({ data: { memberId: id(10), offices: [], nextAfter: null }, error: null }));
		let current = true;
		const owner = new electron.Window({}),
			window = (await openMemberBrowserRecoveryWindow({
				owner: owner as unknown as BrowserWindow,
				directory: "/synthetic",
				client: new CloudMemberBrowserRecovery({ memberId: id(10), rpc }),
				current: () => current,
			})) as unknown as InstanceType<typeof electron.Window>;
		const action = window.handlers.get("browser-recovery:member")!,
			event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
		expect(
			await action({ sender: {}, senderFrame: event.senderFrame }, { method: "offices", after: null }),
		).toMatchObject({ ok: false });
		expect(
			await action({ ...event, senderFrame: { url: event.senderFrame.url } }, { method: "offices", after: null }),
		).toMatchObject({ ok: false });
		expect(await action(event, { method: "offices", after: null })).toMatchObject({ ok: true });
		current = false;
		expect(await action(event, { method: "offices", after: null })).toMatchObject({ ok: false });
		current = true;
		owner.destroy();
		expect(window.isDestroyed()).toBe(true);
		expect(await action(event, { method: "offices", after: null })).toMatchObject({ ok: false });
		expect(rpc).toHaveBeenCalledOnce();
	});
	it("closes an old view when catalog refresh discovers a replacement office", async () => {
		const f = await fixture(true, true);
		await f.refresh();
		await f.viewRequest({ method: "status" });
		expect(
			await f.viewRequest({ method: "connect", attemptId: id(30), binding: f.binding, mode: "watch" }),
		).toMatchObject({ ok: true });
		f.state.scope = { ...scope, companyComputerId: id(90), logicalComputerId: id(91) };
		expect(await f.refresh()).toMatchObject({ ok: false });
		expect(f.close).toHaveBeenCalledOnce();
		expect(await f.viewRequest({ method: "status" })).toMatchObject({ ok: false });
		expect(f.viewClient.status).toHaveBeenCalledOnce();
		f.window.destroy();
	});
	it("allows embedded display images while denying renderer network and executable data URLs", async () => {
		const f = await fixture(true, true),
			boundary = electron.partition.webRequest.onBeforeRequest.mock.calls.at(-1)![0];
		for (const [url, resourceType, cancel] of [
			["file:///synthetic/vendor/novnc-rfb.js", "script", false],
			["data:image/png;base64,a", "image", false],
			["blob:null/example", "image", false],
			["data:text/javascript,script", "script", true],
			["https://remote.test/pixels", "image", true],
			["wss://remote.test/view", "webSocket", true],
			["file:///local/private", "image", true],
		] as const) {
			const reply = vi.fn();
			boundary({ url, resourceType }, reply);
			expect(reply).toHaveBeenCalledWith({ cancel });
		}
		f.window.destroy();
	});
	it("allows member viewing only for discovered exact screens and a trusted frame", async () => {
		const f = await fixture(false, true),
			connect = { method: "connect", attemptId: id(30), binding: f.binding, mode: "watch" };
		expect(await f.viewRequest(connect)).toMatchObject({ ok: false });
		await f.refresh();
		await f.viewRequest({ method: "status" });
		for (const request of [
			{ ...connect, mode: "control" },
			{ ...connect, url: "wss://untrusted" },
			{ ...connect, binding: { ...f.binding, screenGeneration: 2 } },
		])
			expect(await f.viewRequest(request)).toMatchObject({ ok: false });
		expect(await f.viewRequest(connect, { sender: {}, senderFrame: f.event.senderFrame })).toMatchObject({
			ok: false,
		});
		expect(f.viewClient.connectScreen).not.toHaveBeenCalled();
		expect(await f.viewRequest(connect)).toEqual({
			ok: true,
			result: { binding: f.binding, connectionId: id(20), mode: "watch" },
		});
		expect(await f.viewRequest({ method: "send", connectionId: id(99), data: new Uint8Array([1]) })).toMatchObject({
			ok: false,
		});
		expect(f.channel.send).not.toHaveBeenCalled();
		f.window.destroy();
		await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
	});
	it("cleans up only the exact observed connection after a lost reply or window closure", async () => {
		const f = await fixture(true, true);
		await f.refresh();
		await f.viewRequest({ method: "status" });
		expect(await f.viewRequest({ method: "cancel", connectionId: id(99) })).toMatchObject({ ok: false });
		expect(await f.viewRequest({ method: "cancel", connectionId: id(20) })).toMatchObject({ ok: true });
		expect(f.viewClient.cancel).toHaveBeenCalledWith(id(20), expect.any(AbortSignal));
		expect(await f.viewRequest({ method: "cancel", connectionId: id(20) })).toMatchObject({ ok: false });
		f.window.destroy();
		expect(f.viewClient.cancel).toHaveBeenCalledOnce();
	});
	it("aborts a pending connection by attempt identity and disposes a late result", async () => {
		const f = await fixture(true, true);
		await f.refresh();
		await f.viewRequest({ method: "status" });
		let done!: () => void;
		f.viewClient.connectScreen.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				done = resolve;
			});
			return { binding: f.binding, connectionId: id(20), mode: "watch", channel: f.channel, close: f.close };
		});
		const opening = f.viewRequest({ method: "connect", attemptId: id(30), binding: f.binding, mode: "watch" });
		await vi.waitFor(() => expect(done).toBeTypeOf("function"));
		await f.viewRequest({ method: "abortConnect", attemptId: id(99) });
		expect(f.viewClient.connectScreen.mock.calls[0][0].signal.aborted).toBe(false);
		await f.viewRequest({ method: "abortConnect", attemptId: id(30) });
		expect(f.viewClient.connectScreen.mock.calls[0][0].signal.aborted).toBe(true);
		done();
		expect(await opening).toMatchObject({ ok: false });
		expect(f.close).toHaveBeenCalledOnce();
		f.window.destroy();
	});
	it("requires observed authority and never starts a machine when opened or closed", async () => {
		const f = await fixture();
		expect(await f.request({ method: "start" })).toMatchObject({ ok: false });
		expect(f.calls).toEqual([]);
		expect(await f.refresh()).toMatchObject({ ok: true });
		f.window.destroy();
		expect(f.calls.map((c) => c.method)).toEqual([
			"qorpera_member_office_catalog",
			"qorpera_runtime_office_start_status",
		]);
	});
	it("recovers an uncertain start without submitting it again", async () => {
		const f = await fixture();
		await f.refresh();
		f.state.loseStart = true;
		expect(await f.request({ method: "start" })).toMatchObject({ ok: false });
		expect(await f.request({ method: "start" })).toMatchObject({ ok: false });
		expect(await f.refresh()).toMatchObject({ ok: true, result: { start: { intent: { intentId: id(9) } } } });
		expect(f.calls.filter((c) => c.method === "qorpera_request_runtime_office_start")).toHaveLength(1);
		expect(await f.request({ method: "cancelStart", intentId: id(8) })).toMatchObject({ ok: false });
		expect(await f.request({ method: "cancelStart", intentId: id(9) })).toMatchObject({
			ok: true,
			result: { state: "cancelled" },
		});
	});
	it("requires observed agent/version and refresh after uncertain access changes", async () => {
		const f = await fixture();
		await f.refresh();
		const action = {
			method: "configure",
			staffAgentId: id(5),
			expectedVersion: 0,
			enabled: true,
			capabilities: ["desktop", "shell"],
		};
		expect(await f.request(action)).toMatchObject({ ok: false });
		expect(await f.request({ method: "access", staffAgentId: id(8) })).toMatchObject({ ok: false });
		await f.request({ method: "access", staffAgentId: id(5) });
		f.state.loseGrant = true;
		expect(await f.request(action)).toMatchObject({ ok: false });
		expect(await f.request(action)).toMatchObject({ ok: false });
		expect(await f.request({ method: "access", staffAgentId: id(5) })).toMatchObject({
			ok: true,
			result: { grant: { version: 1 } },
		});
		expect(await f.request(action)).toMatchObject({ ok: false });
		expect(f.calls.filter((c) => c.method === "qorpera_configure_runtime_office_access")).toHaveLength(1);
	});
	it("keeps ordinary members read-only and rejects added renderer fields", async () => {
		const f = await fixture(false);
		await f.refresh();
		await f.request({ method: "access", staffAgentId: id(5) });
		for (const value of [
			{ method: "start" },
			{ method: "configure", staffAgentId: id(5), expectedVersion: 0, enabled: true, capabilities: ["shell"] },
			{ method: "catalog", after: null, path: "/local" },
		])
			expect(await f.request(value)).toMatchObject({ ok: false });
		expect(f.calls).toHaveLength(2);
	});
	it("fences account/window/frame changes before cloud access", async () => {
		const f = await fixture();
		expect(
			await f.request({ method: "catalog", after: null }, { sender: {}, senderFrame: f.event.senderFrame }),
		).toMatchObject({ ok: false });
		f.state.current = false;
		expect(await f.refresh()).toMatchObject({ ok: false });
		f.state.current = true;
		f.window.destroy();
		expect(await f.refresh()).toMatchObject({ ok: false });
		expect(f.calls).toHaveLength(0);
	});
});
