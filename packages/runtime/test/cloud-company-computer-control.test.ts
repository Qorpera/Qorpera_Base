import { randomUUID } from "node:crypto";
import type { CompanyComputerScreenLease } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CloudCompanyComputerScreenControl } from "@qorpera/runtime/cloud-company-computer-control";
import { CompanyComputerScreenAdmissionRefusedError } from "@qorpera/runtime/cloud-company-computer-leases";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture() {
	const source = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => source.authority },
		new AbortController().signal,
	);
	runs.push(run);
	const scope = {
		companyId: run.identity.companyId,
		environmentId: run.identity.environmentId,
		companyComputerId: randomUUID(),
		logicalComputerId: randomUUID(),
	};
	const lease: CompanyComputerScreenLease = {
		binding: {
			...scope,
			computerGeneration: 1,
			screenId: randomUUID(),
			screenOrdinal: 1,
			screenGeneration: 2,
			staffAgentId: run.identity.staffAgentId,
		},
		leaseId: randomUUID(),
		epoch: 1,
		driver: { kind: "agent", runId: run.identity.runId, staffAgentId: run.identity.staffAgentId },
		validForMs: 30_000,
	};
	const call = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ state: "admitted", lease });
	return {
		run,
		scope,
		lease,
		call,
		control: new CloudCompanyComputerScreenControl({ run, scope, control: { call } }),
		signal: new AbortController().signal,
	};
}

describe("native office screen registry adapter", () => {
	it("sends the full admitted native binding and accepts a scoped lease", async () => {
		const f = await fixture();
		expect(await f.control.acquire(f.scope, f.signal)).toEqual(f.lease);
		expect(f.call).toHaveBeenCalledExactlyOnceWith(
			"qorpera_native_office_screen",
			{ p_binding: f.run.binding, p_scope: f.scope, p_action: "acquire", p_lease: null },
			expect.any(AbortSignal),
		);
	});

	it.each(["SCREEN_OCCUPIED", "SCREEN_CAPACITY_EXHAUSTED"])(
		"only classifies a confirmed %s refusal",
		async (reason) => {
			const f = await fixture();
			f.call.mockResolvedValue({ state: "refused", reason });
			await expect(f.control.acquire(f.scope, f.signal)).rejects.toBeInstanceOf(
				CompanyComputerScreenAdmissionRefusedError,
			);
			expect(f.call).toHaveBeenCalledTimes(1);
		},
	);

	it("does not turn transport failures or ambiguous responses into admission refusals", async () => {
		const f = await fixture();
		const error = new Error("SCREEN_OCCUPIED");
		f.call
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce({ state: "refused", reason: "SCREEN_OCCUPIED", lease: f.lease });
		await expect(f.control.acquire(f.scope, f.signal)).rejects.toBe(error);
		await expect(f.control.acquire(f.scope, f.signal)).rejects.not.toBeInstanceOf(
			CompanyComputerScreenAdmissionRefusedError,
		);
		expect(f.call).toHaveBeenCalledTimes(2);
	});

	it.each(["leaseId", "epoch", "generation", "driver", "scope", "extra", "duration"])(
		"rejects renewal with changed %s without acquiring a replacement",
		async (change) => {
			const f = await fixture();
			const lease = structuredClone(f.lease);
			const changed = {
				...lease,
				...(change === "leaseId" ? { leaseId: randomUUID() } : {}),
				...(change === "epoch" ? { epoch: lease.epoch + 1 } : {}),
				...(change === "generation" ? { binding: { ...lease.binding, screenGeneration: 10 } } : {}),
				...(change === "scope" ? { binding: { ...lease.binding, companyId: randomUUID() } } : {}),
				...(change === "driver" ? { driver: { ...lease.driver, runId: randomUUID() } } : {}),
				...(change === "extra" ? { futureAuthority: true } : {}),
				...(change === "duration" ? { validForMs: 30_001 } : {}),
			};
			f.call.mockResolvedValue({ state: "admitted", lease: changed });
			await expect(f.control.renew(lease, f.signal)).rejects.toThrow();
			expect(f.call).toHaveBeenCalledTimes(1);
			expect(f.call.mock.calls[0][1]).toMatchObject({ p_action: "renew" });
		},
	);

	it("releases the exact lease after local run abort and rejects unconfirmed cleanup", async () => {
		const f = await fixture();
		f.run.close();
		f.call.mockResolvedValueOnce({ state: "released" }).mockResolvedValueOnce({ state: "pending" });
		await f.control.release(f.lease, f.signal);
		expect(f.call.mock.calls[0][1]).toEqual({
			p_binding: f.run.binding,
			p_scope: f.scope,
			p_action: "release",
			p_lease: f.lease,
		});
		await expect(f.control.release(f.lease, f.signal)).rejects.toThrow("OFFICE_RELEASE_UNCONFIRMED");
	});

	it("does not call the registry for a foreign scope or an aborted request", async () => {
		const f = await fixture();
		await expect(f.control.acquire({ ...f.scope, companyId: randomUUID() }, f.signal)).rejects.toThrow();
		await expect(f.control.acquire(f.scope, AbortSignal.abort())).rejects.toThrow();
		expect(f.call).not.toHaveBeenCalled();
	});
});
