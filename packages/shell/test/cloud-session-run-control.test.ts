import { CloudSessionRunControl, type CloudSessionRunRpc } from "@qorpera/cloud-client/cloud-session-run-control";
import { describe, expect, it, vi } from "vitest";

const sessionId = "28000000-0000-4000-8000-000000000055";
const staffAgentId = "28000000-0000-4000-8000-000000000054";
const runId = "28000000-0000-4000-8000-000000000081";
const otherId = "28000000-0000-4000-8000-000000000082";

describe("cloud conversation run control", () => {
	it("reads a closed, exact-session run projection without returning provider or job data", async () => {
		const rpc = vi.fn<CloudSessionRunRpc>(async () => ({
			data: {
				session_id: sessionId,
				staff_agent_id: staffAgentId,
				run: { run_id: runId, status: "leased", can_cancel: true, private: "hidden" },
			},
			error: null,
		}));
		await expect(new CloudSessionRunControl(rpc).read(sessionId, staffAgentId)).resolves.toEqual({
			sessionId,
			staffAgentId,
			run: { runId, status: "leased", canCancel: true },
		});
		expect(rpc).toHaveBeenCalledWith(
			"qorpera_get_session_run_control",
			{ p_session_id: sessionId },
			expect.any(AbortSignal),
		);
	});

	it("supports an idle session and a non-cancellable coworker's run", async () => {
		const rpc = vi
			.fn<CloudSessionRunRpc>()
			.mockResolvedValueOnce({
				data: { session_id: sessionId, staff_agent_id: staffAgentId, run: null },
				error: null,
			})
			.mockResolvedValueOnce({
				data: {
					session_id: sessionId,
					staff_agent_id: staffAgentId,
					run: { run_id: runId, status: "queued", can_cancel: false },
				},
				error: null,
			});
		const control = new CloudSessionRunControl(rpc);
		expect((await control.read(sessionId, staffAgentId)).run).toBeNull();
		expect((await control.read(sessionId, staffAgentId)).run).toEqual({ runId, status: "queued", canCancel: false });
	});

	it.each([
		{ session_id: otherId, staff_agent_id: staffAgentId, run: null },
		{ session_id: sessionId, staff_agent_id: otherId, run: null },
		{
			session_id: sessionId,
			staff_agent_id: staffAgentId,
			run: { run_id: runId, status: "failed", can_cancel: true },
		},
		{ session_id: sessionId, staff_agent_id: staffAgentId, run: { run_id: "", status: "leased", can_cancel: true } },
		{
			session_id: sessionId,
			staff_agent_id: staffAgentId,
			run: { run_id: runId, status: "leased", can_cancel: "true" },
		},
		{ session_id: sessionId, staff_agent_id: staffAgentId },
	])("rejects rebound or malformed status: %j", async (data) => {
		await expect(
			new CloudSessionRunControl(async () => ({ data, error: null })).read(sessionId, staffAgentId),
		).rejects.toThrow();
	});

	it.each(["cancelled", "completed", "failed"])(
		"addresses exactly one run and accepts terminal readback: %s",
		async (status) => {
			const rpc = vi.fn<CloudSessionRunRpc>(async () => ({
				data: { session_id: sessionId, run_id: runId, status },
				error: null,
			}));
			const control = new CloudSessionRunControl(rpc);
			await expect(control.cancel(sessionId, runId)).resolves.toBe(status);
			await expect(control.cancel(sessionId, runId)).resolves.toBe(status);
			for (const call of rpc.mock.calls)
				expect(call.slice(0, 2)).toEqual([
					"qorpera_cancel_session_run",
					{ p_session_id: sessionId, p_run_id: runId },
				]);
		},
	);

	it.each([
		{ session_id: otherId, run_id: runId, status: "cancelled" },
		{ session_id: sessionId, run_id: otherId, status: "cancelled" },
		{ session_id: sessionId, run_id: runId, status: "leased" },
	])("does not acknowledge cancellation of a different or still-running run", async (data) => {
		await expect(
			new CloudSessionRunControl(async () => ({ data, error: null })).cancel(sessionId, runId),
		).rejects.toThrow("not confirmed");
	});

	it("rejects missing or invalid identities without making requests", async () => {
		const rpc = vi.fn<CloudSessionRunRpc>();
		const control = new CloudSessionRunControl(rpc);
		await expect(control.cancel(sessionId, "")).rejects.toThrow("exact cloud run");
		await expect(control.read("", staffAgentId)).rejects.toThrow("identity");
		expect(rpc).not.toHaveBeenCalled();
	});

	it("keeps raw gateway errors private and never retries cancellation automatically", async () => {
		const rpc = vi.fn<CloudSessionRunRpc>().mockRejectedValue(new Error("<html>private gateway dump</html>"));
		await expect(new CloudSessionRunControl(rpc).cancel(sessionId, runId)).rejects.toThrow("Could not confirm");
		expect(rpc).toHaveBeenCalledTimes(1);
	});

	it("preserves explicit permission denials", async () => {
		await expect(
			new CloudSessionRunControl(async () => ({ data: null, error: { code: "42501" } })).cancel(sessionId, runId),
		).rejects.toThrow("permission");
	});

	it("bounds a stalled request and aborts transport without claiming cancellation", async () => {
		vi.useFakeTimers();
		try {
			const rpc = vi.fn<CloudSessionRunRpc>(() => new Promise(() => {}));
			const pending = new CloudSessionRunControl(rpc, 100).cancel(sessionId, runId);
			const rejected = expect(pending).rejects.toThrow("Could not confirm");
			await vi.advanceTimersByTimeAsync(100);
			await rejected;
			expect(rpc.mock.calls[0]?.[2].aborted).toBe(true);
			expect(rpc).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
