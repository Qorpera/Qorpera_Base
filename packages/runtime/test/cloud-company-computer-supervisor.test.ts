import { CompanyComputerOfficeSupervisor } from "@qorpera/runtime/cloud-company-computer-supervisor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	const drain = { state: "draining", drainId: computerId(44), epoch: 2, binding: computerBinding() };
	const challenge = {
		scope: computerScope(),
		computerGeneration: 1,
		challengeId: computerId(40),
		version: 1,
		state: "entering",
		memberId: computerId(41),
		profileId: computerId(42),
		profileVersion: 2,
		screenId: computerBinding().screenId,
		drains: [drain],
	};
	const state = {
		scope: computerScope(),
		computerGeneration: 1,
		revision: 1,
		state: "active",
		privacyState: "shared",
		privacyVersion: 0,
		privacyChallenge: null as unknown,
		drains: [drain],
	};
	const order: string[] = [];
	const control = { call: vi.fn(async () => structuredClone(state)) };
	const viewers = {
		fencePrivacy: vi.fn(async () => {
			order.push("privacy-fence");
		}),
		fenceScreen: vi.fn(async () => {
			order.push("screen-fence");
		}),
		close: vi.fn(async () => {
			order.push("closed");
		}),
	};
	const drains = {
		drain: vi.fn(async () => {
			order.push("physical-drain");
		}),
	};
	const privacy = {
		transition: vi.fn(async () => {
			order.push("physical-privacy");
		}),
	};
	const supervisor = new CompanyComputerOfficeSupervisor({
		scope: computerScope(),
		computerGeneration: 1,
		control,
		viewers,
		drains,
		privacy,
	});
	return {
		supervisor,
		order,
		control,
		state,
		viewers,
		drains,
		privacy,
		challenge,
		signal: new AbortController().signal,
	};
}
afterEach(() => vi.useRealTimers());
describe("runtime office supervision", () => {
	it("runs on the service lifetime without viewers and closes admission on shutdown", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.state.drains = [];
		const abort = new AbortController();
		const running = f.supervisor.run(abort.signal);
		await vi.advanceTimersByTimeAsync(2100);
		expect(f.control.call).toHaveBeenCalledTimes(3);
		await expect(f.supervisor.run(abort.signal)).rejects.toThrow("OFFICE_SUPERVISOR_ALREADY_RUNNING");
		abort.abort();
		await running;
		expect(f.viewers.close).toHaveBeenCalledOnce();
		await expect(f.supervisor.reconcile(f.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
	});
	it("fences actual streams before draining expired control without a member client", async () => {
		const f = fixture();
		await f.supervisor.reconcile(f.signal);
		expect(f.order).toEqual(["screen-fence", "physical-drain"]);
		expect(f.control.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_runtime_office_supervisor_status",
			{ p_scope: computerScope(), p_computer_generation: 1 },
			expect.any(AbortSignal),
		);
	});
	it("shares concurrent reconciliation and waits for stream shutdown before guest effects", async () => {
		const f = fixture();
		const closed = computerDeferred<void>();
		f.viewers.fenceScreen.mockImplementation(async () => {
			await closed.promise;
			f.order.push("screen-fence");
		});
		const first = f.supervisor.reconcile(f.signal);
		const second = f.supervisor.reconcile(f.signal);
		await vi.waitFor(() => expect(f.viewers.fenceScreen).toHaveBeenCalledOnce());
		expect(f.drains.drain).not.toHaveBeenCalled();
		closed.resolve();
		await Promise.all([first, second]);
		expect(f.control.call).toHaveBeenCalledOnce();
		expect(f.order).toEqual(["screen-fence", "physical-drain"]);
	});
	it("restores an already-private barrier without restarting entry over a signed-in browser", async () => {
		const f = fixture();
		Object.assign(f.state, { privacyState: "private", privacyVersion: 1, privacyChallenge: f.challenge, drains: [] });
		await f.supervisor.reconcile(f.signal);
		expect(f.order).toEqual(["privacy-fence"]);
		expect(f.privacy.transition).not.toHaveBeenCalled();
	});
	it("delegates pending privacy only after all viewer barriers are installed", async () => {
		const f = fixture();
		Object.assign(f.state, { privacyState: "entering", privacyVersion: 1, privacyChallenge: f.challenge });
		await f.supervisor.reconcile(f.signal);
		expect(f.order).toEqual(["privacy-fence", "screen-fence", "physical-privacy"]);
		expect(f.drains.drain).not.toHaveBeenCalled();
	});
	it("closes streams on malformed, foreign, duplicate or regressed state before any guest mutation", async () => {
		for (const patch of [
			{ computerGeneration: 2 },
			{ scope: { ...computerScope(), companyId: computerId(99) } },
			{ privacyState: "private" },
			{ privacyVersion: -1 },
			{ drains: [fixture().state.drains[0], fixture().state.drains[0]] },
			{ credentials: "private" },
		]) {
			const f = fixture();
			Object.assign(f.state, patch);
			await expect(f.supervisor.reconcile(f.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
			expect(f.order).toEqual(["closed"]);
		}
		const f = fixture();
		f.state.revision = 2;
		await f.supervisor.reconcile(f.signal);
		f.state.revision = 1;
		await expect(f.supervisor.reconcile(f.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		expect(f.viewers.close).toHaveBeenCalledOnce();
	});
	it("retains failed physical reconciliation and never silently reopens the service", async () => {
		const f = fixture();
		f.drains.drain.mockRejectedValueOnce(new Error("guest state unknown"));
		await expect(f.supervisor.reconcile(f.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		await expect(f.supervisor.reconcile(f.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		expect(f.control.call).toHaveBeenCalledOnce();
		expect(f.viewers.close).toHaveBeenCalledOnce();
	});
	it("closes viewers when the office is no longer active", async () => {
		const f = fixture();
		f.state.state = "maintenance";
		await f.supervisor.reconcile(f.signal);
		expect(f.order).toEqual(["screen-fence", "closed"]);
		expect(f.drains.drain).not.toHaveBeenCalled();
	});
});
