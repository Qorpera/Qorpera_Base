import { describe, expect, it, vi } from "vitest";
import { CloudApi } from "../src/cloud/api.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { id } from "./fixtures.ts";

/* A member's Stop of a worker's own run, by run id (session-buildup audit gap 4b, migration 20260930002800). */
describe("a worker run's control", () => {
	it("reads and stops by run id, and refuses an answer about another run", async () => {
		const rpc = vi.fn(async (_name: string, args: { p_run_id: string }) => ({
			run_id: args.p_run_id,
			status: "leased",
			can_cancel: true,
		}));
		const api = new CloudApi({ rpc } as unknown as Cloud);
		expect(await api.workerRunControl(id(81))).toEqual({ runId: id(81), status: "leased", canCancel: true });
		expect(rpc).toHaveBeenLastCalledWith("qorpera_get_worker_run_control", { p_run_id: id(81) });
		rpc.mockResolvedValueOnce({ run_id: id(81), status: "cancelled", can_cancel: false });
		expect(await api.stopWorkerRun(id(81))).toEqual({ runId: id(81), status: "cancelled", canCancel: false });
		expect(rpc).toHaveBeenLastCalledWith("qorpera_cancel_worker_run", { p_run_id: id(81) });
		rpc.mockResolvedValueOnce({ run_id: id(82), status: "leased", can_cancel: true });
		await expect(api.workerRunControl(id(81))).rejects.toThrow("another worker run");
		rpc.mockResolvedValueOnce({ run_id: id(81), status: "paused", can_cancel: true });
		await expect(api.workerRunControl(id(81))).rejects.toThrow();
		expect(() => api.stopWorkerRun("not-a-run")).toThrow();
	});
});
