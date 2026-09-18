import { performance } from "node:perf_hooks";
import type { CompanyComputerPrivacyChallenge } from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { CloudCompanyComputerPrivateSurfaceControl } from "@qorpera/runtime/cloud-company-computer-private-surface-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	const challenge: CompanyComputerPrivacyChallenge = {
		scope: computerScope(),
		computerGeneration: 1,
		challengeId: computerId(40),
		version: 3,
		state: "entering",
		memberId: computerId(41),
		profileId: computerId(42),
		profileVersion: 2,
		screenId: computerBinding().screenId,
		drains: [{ state: "draining", drainId: computerId(43), epoch: 2, binding: computerBinding() }],
	};
	const response = { state: "authorized", privacyState: "entering", version: 3, validForMs: 5000 };
	const call = vi.fn(async (): Promise<unknown> => response);
	const control = new CloudCompanyComputerPrivateSurfaceControl({
		scope: computerScope(),
		computerGeneration: 1,
		control: { call },
	});
	return { challenge, response, call, control, signal: new AbortController().signal };
}

afterEach(() => vi.restoreAllMocks());

describe("private surface lifetime authority", () => {
	it("checks preparation and idle private lifetime afresh without member input authority", async () => {
		const f = fixture();
		await f.control.assertActive(f.challenge, f.signal);
		f.response.privacyState = "private";
		await f.control.assertActive(f.challenge, f.signal);
		expect(f.call).toHaveBeenCalledTimes(2);
		expect(f.call).toHaveBeenLastCalledWith(
			"qorpera_check_runtime_office_private_surface",
			{ p_challenge: f.challenge },
			expect.any(AbortSignal),
		);
		f.call.mockRejectedValue(new Error("owner removed: sensitive SQL detail"));
		await expect(f.control.assertActive(f.challenge, f.signal)).rejects.toThrow("PRIVATE_SURFACE_UNCONFIRMED");
	});

	it.each([
		{ state: "leaving" },
		{ computerGeneration: 2 },
		{ scope: { ...computerScope(), companyId: computerId(90) } },
		{ password: "not metadata" },
		{ drains: [] },
	])("rejects incompatible challenge before RPC: %j", async (changed) => {
		const f = fixture();
		await expect(
			f.control.assertActive({ ...f.challenge, ...changed } as CompanyComputerPrivacyChallenge, f.signal),
		).rejects.toThrow();
		expect(f.call).not.toHaveBeenCalled();
	});

	it.each([
		null,
		[],
		{ state: "private", version: 3, challenge: {} },
		{ state: "authorized", privacyState: "shared", version: 3, validForMs: 5000 },
		{ state: "authorized", privacyState: "private", version: 4, validForMs: 5000 },
		{ state: "authorized", privacyState: "private", version: 3, validForMs: 5001 },
		{ state: "authorized", privacyState: "private", version: 3, validForMs: 0 },
		{ state: "authorized", privacyState: "private", version: 3, validForMs: 1.5 },
		{ state: "authorized", privacyState: "private", version: 3, validForMs: 5000, url: "private" },
	])("rejects metadata, stale or open response: %j", async (response) => {
		const f = fixture();
		f.call.mockResolvedValue(response);
		await expect(f.control.assertActive(f.challenge, f.signal)).rejects.toThrow("PRIVATE_SURFACE_UNCONFIRMED");
	});

	it("does not let caller or registry mutation change the pending identity", async () => {
		const f = fixture();
		const pending = computerDeferred<unknown>();
		f.call.mockImplementation(async (...args: unknown[]) => {
			const sent = (args[1] as { p_challenge: CompanyComputerPrivacyChallenge }).p_challenge;
			sent.version = 99;
			return pending.promise;
		});
		const result = f.control.assertActive(f.challenge, f.signal);
		f.challenge.version = 99;
		pending.resolve(f.response);
		await result;
	});

	it("rejects responses whose validity elapsed during the request", async () => {
		const f = fixture();
		vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(5100);
		await expect(f.control.assertActive(f.challenge, f.signal)).rejects.toThrow("PRIVATE_SURFACE_UNCONFIRMED");
	});

	it("does not accept a response after cancellation", async () => {
		const f = fixture();
		const pending = computerDeferred<unknown>();
		const abort = new AbortController();
		f.call.mockReturnValue(pending.promise);
		const result = f.control.assertActive(f.challenge, abort.signal);
		abort.abort();
		pending.resolve(f.response);
		await expect(result).rejects.toThrow("PRIVATE_SURFACE_UNCONFIRMED");
	});

	it("bounds an unresponsive registry without accepting late authority", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture();
			const pending = computerDeferred<unknown>();
			f.call.mockReturnValue(pending.promise);
			const result = expect(f.control.assertActive(f.challenge, f.signal)).rejects.toThrow(
				"PRIVATE_SURFACE_UNCONFIRMED",
			);
			await vi.advanceTimersByTimeAsync(3000);
			await result;
			pending.resolve(f.response);
		} finally {
			vi.useRealTimers();
		}
	});
});
