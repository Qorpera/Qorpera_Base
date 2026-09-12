import {
	COMPANY_COMPUTER_SUPERVISOR_STALE_BUDGET_MS,
	CompanyComputerOfficeSupervisor,
} from "@qorpera/runtime/cloud-company-computer-supervisor";
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
	it("retains the registry cause without including its message in diagnostics", async () => {
		const f = fixture();
		const cause = Object.assign(new Error("secret database credentials"), { code: "ECONNRESET" });
		f.control.call.mockRejectedValueOnce(cause);
		const error = await f.supervisor.reconcile(f.signal).catch((error: unknown) => error);
		expect(error).toHaveProperty("cause", cause);
		expect(companyComputerFailureDiagnostic(error)).toEqual({
			schema: "qorpera.office-service-failure/v1",
			stages: [],
			codes: ["OFFICE_SUPERVISOR_RECONCILIATION_FAILED"],
			categories: ["transport"],
		});
		expect(f.viewers.close).toHaveBeenCalledOnce();
	});
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
	it("keeps the last confirmed state through transient unconfirmed polls and resumes", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.state.drains = [];
		const abort = new AbortController();
		const running = f.supervisor.run(abort.signal);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.control.call).toHaveBeenCalledTimes(1);
		expect(f.supervisor.unconfirmedSince).toBeUndefined();
		expect(() => f.supervisor.assertConfirmed()).not.toThrow();
		// A wrapped registry deadline, then a poll that never answers inside the 5 s request deadline.
		f.control.call
			.mockRejectedValueOnce(
				new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("COMPUTER_REQUEST_STOPPED") }),
			)
			.mockImplementationOnce(() => new Promise(() => undefined));
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.control.call).toHaveBeenCalledTimes(2);
		expect(f.supervisor.unconfirmedSince).toBe(Date.now());
		expect(f.supervisor.unconfirmedPolls).toBe(1);
		expect(() => f.supervisor.assertConfirmed()).toThrow("OFFICE_SUPERVISOR_STATUS_STALE");
		await vi.advanceTimersByTimeAsync(6000);
		expect(f.control.call).toHaveBeenCalledTimes(3);
		expect(f.supervisor.unconfirmedPolls).toBe(2);
		expect(() => f.supervisor.assertConfirmed()).toThrow("OFFICE_SUPERVISOR_STATUS_STALE");
		expect(f.viewers.close).not.toHaveBeenCalled();
		expect(f.order).toEqual([]);
		f.state.drains = [fixture().state.drains[0]];
		f.state.revision = 2;
		await vi.advanceTimersByTimeAsync(1000);
		expect(f.control.call).toHaveBeenCalledTimes(4);
		expect(f.supervisor.unconfirmedSince).toBeUndefined();
		expect(f.supervisor.unconfirmedPolls).toBe(0);
		expect(() => f.supervisor.assertConfirmed()).not.toThrow();
		expect(f.order).toEqual(["screen-fence", "physical-drain"]);
		abort.abort();
		await running;
		expect(f.viewers.close).toHaveBeenCalledOnce();
	});
	it("fails closed at once on an authority refusal or inactive office after a confirmed poll", async () => {
		for (const refusal of [
			new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("denied") }),
			new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new SyntaxError("invalid response") }),
			new Error("OFFICE_SERVICE_UNAVAILABLE"),
		]) {
			vi.useFakeTimers();
			const f = fixture();
			f.state.drains = [];
			const abort = new AbortController();
			const running = f.supervisor.run(abort.signal).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(0);
			f.control.call.mockRejectedValueOnce(refusal);
			await vi.advanceTimersByTimeAsync(1000);
			const error = await running;
			expect(error).toHaveProperty("message", "OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
			expect(error).toHaveProperty("cause", refusal);
			expect(f.supervisor.unconfirmedSince).toBeUndefined();
			expect(() => f.supervisor.assertConfirmed()).toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
			expect(f.viewers.close).toHaveBeenCalledTimes(2);
			vi.useRealTimers();
		}
	});
	it("never tolerates an unconfirmed first reconciliation or an aborted lifetime", async () => {
		const f = fixture();
		f.control.call.mockRejectedValueOnce(
			new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("COMPUTER_REQUEST_STOPPED") }),
		);
		await expect(f.supervisor.reconcile(f.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		expect(f.viewers.close).toHaveBeenCalledOnce();
		const g = fixture();
		await g.supervisor.reconcile(g.signal);
		const abort = new AbortController();
		g.control.call.mockImplementationOnce(async () => {
			abort.abort();
			throw new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("COMPUTER_REQUEST_STOPPED") });
		});
		await expect(g.supervisor.reconcile(abort.signal)).rejects.toThrow("COMPUTER_REQUEST_STOPPED");
		await expect(g.supervisor.reconcile(g.signal)).rejects.toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		expect(g.viewers.close).toHaveBeenCalledOnce();
	});
	it("fails closed with a counted stale-status code once the unconfirmed budget is exhausted", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.state.drains = [];
		const abort = new AbortController();
		const running = f.supervisor.run(abort.signal).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		f.control.call.mockImplementation(() => new Promise(() => undefined));
		// Each unconfirmed poll spends the 5 s request deadline plus the 1 s cadence.
		await vi.advanceTimersByTimeAsync(COMPANY_COMPUTER_SUPERVISOR_STALE_BUDGET_MS);
		expect(f.viewers.close).not.toHaveBeenCalled();
		expect(f.supervisor.unconfirmedPolls).toBe(15);
		await vi.advanceTimersByTimeAsync(6000);
		const error = await running;
		expect(error).toHaveProperty("message", "OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		expect(f.viewers.close).toHaveBeenCalledTimes(2);
		expect(() => f.supervisor.assertConfirmed()).toThrow("OFFICE_SUPERVISOR_RECONCILIATION_FAILED");
		expect(companyComputerFailureDiagnostic(error)).toEqual({
			schema: "qorpera.office-service-failure/v1",
			stages: [],
			codes: [
				"OFFICE_SUPERVISOR_RECONCILIATION_FAILED",
				"OFFICE_SUPERVISOR_STATUS_STALE",
				"COMPUTER_REQUEST_STOPPED",
			],
			categories: ["unknown"],
			staleStatus: { polls: 16, durationMs: COMPANY_COMPUTER_SUPERVISOR_STALE_BUDGET_MS },
		});
	});
});

import { companyComputerFailureDiagnostic } from "@qorpera/runtime/cloud-company-computer-diagnostics";
