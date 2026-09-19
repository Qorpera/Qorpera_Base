import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyComputerPrivacyChallenge } from "../src/cloud-company-computer-privacy.ts";
import type { CompanyComputerWebSocket } from "../src/cloud-company-computer-view-channel.ts";
import { CloudCompanyComputerViews, type CloudCompanyComputerViewsRpc } from "../src/cloud-company-computer-views.ts";

const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	const scope = { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) };
	const binding = {
		...scope,
		computerGeneration: 1,
		screenId: id(5),
		screenOrdinal: 1,
		screenGeneration: 2,
		staffAgentId: id(6),
	};
	const grant = {
		binding,
		memberId: id(7),
		viewerSessionId: id(8),
		screenEpoch: 2,
		privacyVersion: 0,
		mode: "watch",
		validForMs: 30000,
	};
	const screen = { binding, epoch: 2, driver: "agent" as const, drainPending: false, takeoverMemberId: null };
	const status = {
		scope,
		computerGeneration: 1,
		state: "active",
		privacyState: "shared",
		privacyVersion: 0,
		maintenance: null,
		screens: [screen],
		viewers: [],
	};
	const socket: CompanyComputerWebSocket = {
		readyState: 1,
		bufferedAmount: 0,
		binaryType: "arraybuffer",
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		close: vi.fn(),
		send: vi.fn(),
	};
	const createWebSocket = vi.fn(() => {
		queueMicrotask(() => {
			socket.onopen?.(new Event("open"));
			socket.onmessage?.(
				new MessageEvent("message", {
					data: new TextEncoder().encode(
						`${JSON.stringify({ ok: true, binding, mode: grant.mode })}\nRFB 003.008\n`,
					).buffer,
				}),
			);
		});
		return socket;
	});
	const rpc = vi.fn<CloudCompanyComputerViewsRpc>(async (method) => {
		if (method === "qorpera_runtime_office_member_status") return { data: structuredClone(status), error: null };
		if (method === "qorpera_cancel_runtime_office_viewer") return { data: { state: "released" }, error: null };
		if (method === "qorpera_request_runtime_office_drain")
			return { data: { state: "draining", binding, epoch: 3, drainId: id(10) }, error: null };
		return { data: { state: "issued", capability: "A".repeat(43), grant: structuredClone(grant) }, error: null };
	});
	const client = new CloudCompanyComputerViews({
		scope,
		memberId: id(7),
		rpc,
		url: `wss://office.qorpera.test/office/${id(3)}/view`,
		createWebSocket,
	});
	const abort = new AbortController();
	return {
		scope,
		binding,
		grant,
		screen,
		status,
		rpc,
		socket,
		createWebSocket,
		client,
		abort,
		input: { binding, screenEpoch: 2, signal: abort.signal },
	};
}
afterEach(() => vi.useRealTimers());
describe("member office viewer client", () => {
	function privateFixture() {
		const f = fixture();
		f.status.privacyState = "private";
		f.status.privacyVersion = 1;
		const challenge: CompanyComputerPrivacyChallenge = {
			scope: f.scope,
			computerGeneration: 1,
			challengeId: id(20),
			version: 1,
			state: "entering",
			memberId: id(7),
			profileId: id(21),
			profileVersion: 2,
			screenId: f.binding.screenId,
			drains: [{ state: "draining", drainId: id(22), epoch: 2, binding: f.binding }],
		};
		const connect = vi.spyOn(f.client, "connect").mockResolvedValue({} as never);
		return { ...f, challenge, connect };
	}
	it("connects private control only with the owner's acknowledged challenge without takeover", async () => {
		const f = privateFixture();
		await f.client.connectPrivate({ challenge: f.challenge, signal: f.abort.signal });
		expect(f.connect).toHaveBeenCalledWith({
			binding: f.binding,
			screenEpoch: 2,
			mode: "control",
			privateChallenge: f.challenge,
			signal: f.abort.signal,
		});
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual(["qorpera_runtime_office_member_status"]);
	});
	it("waits for a private reconnect's newer drain before issuing another capability", async () => {
		vi.useFakeTimers();
		const f = privateFixture();
		f.screen.epoch = 3;
		f.screen.drainPending = true;
		const waiting = f.client.connectPrivate({ challenge: f.challenge, signal: f.abort.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.connect).not.toHaveBeenCalled();
		f.screen.drainPending = false;
		await vi.advanceTimersByTimeAsync(250);
		await waiting;
		expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ screenEpoch: 3 }));
		expect(f.rpc.mock.calls.every(([method]) => method === "qorpera_runtime_office_member_status")).toBe(true);
	});
	it("rejects private entry/exit, generation changes and nonowners without issuing input", async () => {
		for (const change of ["owner", "entering", "leaving", "version", "generation", "screen", "epoch"]) {
			const f = privateFixture();
			if (change === "owner") f.challenge.memberId = id(99);
			else if (change === "version") f.status.privacyVersion = 2;
			else if (change === "generation") f.status.computerGeneration = 2;
			else if (change === "screen") f.screen.binding = { ...f.binding, screenGeneration: 3 };
			else if (change === "epoch") f.screen.epoch = 1;
			else f.status.privacyState = change;
			await expect(f.client.connectPrivate({ challenge: f.challenge, signal: f.abort.signal })).rejects.toThrow();
			expect(f.connect).not.toHaveBeenCalled();
		}
	});
	it("aborts private drain polling without minting or resuming shared access", async () => {
		vi.useFakeTimers();
		const f = privateFixture();
		f.screen.drainPending = true;
		const waiting = f.client.connectPrivate({ challenge: f.challenge, signal: f.abort.signal });
		const failed = expect(waiting).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		f.abort.abort();
		await failed;
		expect(f.connect).not.toHaveBeenCalled();
		expect(f.rpc.mock.calls).toHaveLength(1);
	});
	it("refreshes the exact screen before watching without requesting takeover", async () => {
		const f = fixture();
		const view = await f.client.connectScreen({ binding: f.binding, mode: "watch", signal: f.abort.signal });
		expect(view.mode).toBe("watch");
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_runtime_office_member_status",
			"qorpera_create_runtime_office_viewer",
		]);
		await view.close();
	});
	it("joins the agent with shared input without draining or replacing its lease", async () => {
		const f = fixture();
		f.grant.mode = "shared";
		// Shared fencing is independent of the agent's current lease epoch.
		f.grant.screenEpoch = 1;
		const view = await f.client.connectScreen({ binding: f.binding, mode: "shared", signal: f.abort.signal });
		expect(view.mode).toBe("shared");
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_runtime_office_member_status",
			"qorpera_create_runtime_office_viewer",
		]);
		expect(f.rpc.mock.calls[1][1]).toEqual({
			p_binding: f.binding,
			p_epoch: 2,
			p_mode: "shared",
			p_private_challenge: null,
		});
		await view.close();
		expect(f.rpc.mock.calls.at(-1)?.[0]).toBe("qorpera_cancel_runtime_office_viewer");
	});
	it.each(["private", "draining", "takeover", "screen"])("refuses shared input during %s", async (change) => {
		const f = fixture();
		f.grant.mode = "shared";
		if (change === "private") f.status.privacyState = "private";
		if (change === "draining") f.screen.drainPending = true;
		if (change === "takeover") Object.assign(f.screen, { takeoverMemberId: id(9) });
		if (change === "screen") f.screen.binding = { ...f.binding, screenGeneration: 3 };
		await expect(
			f.client.connectScreen({ binding: f.binding, mode: "shared", signal: f.abort.signal }),
		).rejects.toThrow();
		expect(f.rpc).toHaveBeenCalledOnce();
		expect(f.createWebSocket).not.toHaveBeenCalled();
	});
	it("waits for the exact acknowledged takeover before issuing control", async () => {
		vi.useFakeTimers();
		const f = fixture(),
			connect = vi.spyOn(f.client, "connect").mockResolvedValue({} as never);
		const waiting = f.client.connectScreen({ binding: f.binding, mode: "control", signal: f.abort.signal });
		await vi.advanceTimersByTimeAsync(0);
		Object.assign(f.screen, { epoch: 3, driver: "draining", takeoverMemberId: id(7), drainPending: true });
		await vi.advanceTimersByTimeAsync(250);
		expect(connect).not.toHaveBeenCalled();
		Object.assign(f.screen, { driver: "member", drainPending: false });
		await vi.advanceTimersByTimeAsync(250);
		await waiting;
		expect(connect).toHaveBeenCalledWith({
			binding: f.binding,
			mode: "control",
			screenEpoch: 3,
			signal: f.abort.signal,
		});
		expect(f.rpc.mock.calls.filter(([method]) => method === "qorpera_request_runtime_office_drain")).toHaveLength(1);
	});
	it("recovers an owned pending takeover without submitting another mutation", async () => {
		vi.useFakeTimers();
		const f = fixture(),
			connect = vi.spyOn(f.client, "connect").mockResolvedValue({} as never);
		Object.assign(f.screen, { driver: "draining", takeoverMemberId: id(7), drainPending: true });
		const waiting = f.client.connectScreen({ binding: f.binding, mode: "control", signal: f.abort.signal });
		await vi.advanceTimersByTimeAsync(250);
		Object.assign(f.screen, { driver: "member", drainPending: false });
		await vi.advanceTimersByTimeAsync(250);
		await waiting;
		expect(connect).toHaveBeenCalledOnce();
		expect(f.rpc.mock.calls.every(([method]) => method === "qorpera_runtime_office_member_status")).toBe(true);
	});
	it("refuses replacement screens, other drivers and private surfaces before a new intent", async () => {
		for (const change of ["screen", "owner", "privacy"]) {
			const f = fixture();
			if (change === "screen") f.screen.binding = { ...f.binding, screenGeneration: 4 };
			if (change === "owner") Object.assign(f.screen, { takeoverMemberId: id(99) });
			if (change === "privacy") f.status.privacyState = "private";
			await expect(
				f.client.connectScreen({ binding: f.binding, mode: "control", signal: f.abort.signal }),
			).rejects.toThrow();
			expect(f.rpc).toHaveBeenCalledOnce();
			expect(f.createWebSocket).not.toHaveBeenCalled();
		}
	});
	it("does not mint after cancellation, changed epoch, or a missing drain acknowledgement", async () => {
		vi.useFakeTimers();
		for (const failure of ["abort", "epoch", "timeout"]) {
			const f = fixture();
			const waiting = expect(
				f.client.connectScreen({ binding: f.binding, mode: "control", signal: f.abort.signal }),
			).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(0);
			Object.assign(f.screen, {
				epoch: failure === "epoch" ? 4 : 3,
				driver: "draining",
				takeoverMemberId: id(7),
				drainPending: true,
			});
			if (failure === "abort") f.abort.abort();
			await vi.advanceTimersByTimeAsync(failure === "timeout" ? 20001 : 250);
			await waiting;
			expect(f.createWebSocket).not.toHaveBeenCalled();
			expect(f.rpc.mock.calls.filter(([method]) => method === "qorpera_request_runtime_office_drain")).toHaveLength(
				1,
			);
		}
	});
	it("never retries an uncertain takeover intent", async () => {
		const f = fixture();
		f.rpc.mockResolvedValueOnce({ data: f.status, error: null }).mockRejectedValueOnce(new Error("lost reply"));
		await expect(
			f.client.connectScreen({ binding: f.binding, mode: "control", signal: f.abort.signal }),
		).rejects.toThrow();
		expect(f.rpc).toHaveBeenCalledTimes(2);
		expect(f.createWebSocket).not.toHaveBeenCalled();
	});
	it("opens watch by default, hides capability, and cancels exactly once without stopping the office", async () => {
		const f = fixture();
		const view = await f.client.connect(f.input);
		expect(view).toMatchObject({ connectionId: id(8), binding: f.binding, mode: "watch" });
		expect(f.rpc.mock.calls[0]).toEqual([
			"qorpera_create_runtime_office_viewer",
			{ p_binding: f.binding, p_epoch: 2, p_mode: "watch", p_private_challenge: null },
			expect.any(AbortSignal),
		]);
		expect(JSON.stringify(view)).not.toContain("A".repeat(43));
		await Promise.all([view.close(), view.close()]);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_create_runtime_office_viewer",
			"qorpera_cancel_runtime_office_viewer",
		]);
		expect(f.rpc.mock.calls[1][1]).toEqual({ p_scope: f.scope, p_viewer_session_id: id(8) });
		expect(f.socket.close).toHaveBeenCalledOnce();
	});
	it("requires a fresh explicit takeover and reads acknowledgement without minting control automatically", async () => {
		const f = fixture();
		expect(await f.client.status(f.abort.signal)).toEqual(f.status);
		await f.client.requestTakeover(f.screen, f.abort.signal);
		expect(f.rpc.mock.calls[1][1]).toEqual({
			p_scope: f.scope,
			p_screen_id: id(5),
			p_computer_generation: 1,
			p_screen_generation: 2,
			p_epoch: 2,
			p_takeover: true,
		});
		expect(f.createWebSocket).not.toHaveBeenCalled();
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_runtime_office_member_status",
			"qorpera_request_runtime_office_drain",
		]);
	});
	it("recovers unknown mint outcomes through status without replaying intent", async () => {
		const f = fixture();
		f.rpc.mockRejectedValueOnce(new Error("SQL private diagnostic"));
		await expect(f.client.connect(f.input)).rejects.toThrow("OFFICE_VIEW_UNCONFIRMED_REFRESH_STATUS");
		await f.client.status(f.abort.signal);
		expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
			"qorpera_create_runtime_office_viewer",
			"qorpera_runtime_office_member_status",
		]);
		expect(f.createWebSocket).not.toHaveBeenCalled();
	});
	it("rejects cross-member, epoch, mode, private and binding substitution before exposing a stream", async () => {
		for (const patch of [
			{ memberId: id(99) },
			{ screenEpoch: 3 },
			{ binding: { ...fixture().binding, screenGeneration: 3 } },
			{ mode: "control" },
			{ privateSignIn: { challengeId: id(11), profileId: id(12), profileVersion: 2 } },
		]) {
			const f = fixture();
			Object.assign(f.grant, patch);
			await expect(f.client.connect(f.input)).rejects.toThrow();
			expect(f.createWebSocket).not.toHaveBeenCalled();
			expect(f.rpc).toHaveBeenCalledOnce();
		}
	});
	it("cleans up a confirmed ticket after transport failure, using uncancelled cleanup authority", async () => {
		const f = fixture();
		f.createWebSocket.mockImplementation(() => {
			throw new Error("TLS diagnostic");
		});
		await expect(f.client.connect(f.input)).rejects.toThrow("OFFICE_VIEW_UNCONFIRMED_REFRESH_STATUS");
		expect(f.rpc.mock.calls[1][0]).toBe("qorpera_cancel_runtime_office_viewer");
		expect(f.rpc.mock.calls[1][2].aborted).toBe(false);
	});
	it("cancels on client abort and permits exact cleanup retry after an unknown cancellation", async () => {
		const f = fixture();
		const view = await f.client.connect(f.input);
		f.rpc.mockRejectedValueOnce(new Error("unknown cancellation"));
		await expect(view.close()).rejects.toThrow("OFFICE_VIEW_UNCONFIRMED_REFRESH_STATUS");
		await view.close();
		expect(f.rpc.mock.calls.slice(1).map(([, args]) => args.p_viewer_session_id)).toEqual([id(8), id(8)]);
		const g = fixture();
		await g.client.connect(g.input);
		g.abort.abort();
		await vi.waitFor(() => expect(g.rpc).toHaveBeenCalledTimes(2));
		expect(g.rpc.mock.calls[1][2].aborted).toBe(false);
	});
	it("rejects unbounded/foreign status and fails a stalled call without retry", async () => {
		const f = fixture();
		for (const change of [
			{ scope: { ...f.scope, companyId: id(99) } },
			{ screens: [f.screen, f.screen] },
			{ capability: "secret" },
			{ viewers: Array(65).fill({}) },
		]) {
			f.rpc.mockResolvedValueOnce({ data: { ...f.status, ...change }, error: null });
			await expect(f.client.status(f.abort.signal)).rejects.toThrow();
		}
		vi.useFakeTimers();
		f.rpc.mockImplementation(() => new Promise(() => undefined));
		const pending = expect(f.client.connect(f.input)).rejects.toThrow("OFFICE_VIEW_UNCONFIRMED_REFRESH_STATUS");
		await vi.advanceTimersByTimeAsync(5001);
		await pending;
		expect(f.rpc).toHaveBeenCalledTimes(5);
		expect(f.rpc.mock.calls[4][2].aborted).toBe(true);
	});
});
