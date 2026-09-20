import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, id } from "./fixtures.ts";

afterEach(() => vi.restoreAllMocks());

describe("member failure acknowledgment", () => {
	it("uses the read-receipt RPC and requires confirmation of the exact run", async () => {
		const f = fixture();
		const rpc = vi.mocked(f.cloud.rpc);
		rpc.mockResolvedValueOnce(id(70));
		await f.api.acknowledgeFailedRun(id(70));
		expect(rpc).toHaveBeenCalledExactlyOnceWith("qorpera_acknowledge_execution_run_failure", { p_run_id: id(70) });
		for (const invalid of [null, undefined, true, id(71), { run_id: id(70) }]) {
			rpc.mockResolvedValueOnce(invalid);
			await expect(f.api.acknowledgeFailedRun(id(70))).rejects.toThrow("could not be confirmed");
		}
		expect(rpc.mock.calls.some(([name]) => name === "qorpera_resolve_failed_execution_run")).toBe(false);
	});

	it("does not treat a missing or rejected endpoint as a successful acknowledgment", async () => {
		const f = fixture();
		vi.mocked(f.cloud.rpc).mockRejectedValueOnce(new Error("RPC is not deployed"));
		await expect(f.api.acknowledgeFailedRun(id(70))).rejects.toThrow("RPC is not deployed");
		await expect(f.api.acknowledgeFailedRun("not-a-run")).rejects.toThrow("Run id must be a UUID");
		expect(f.cloud.rpc).toHaveBeenCalledTimes(1);
	});
});
