import { describe, expect, it, vi } from "vitest";
import { CodingExecutorHttpControl } from "../../../deploy/coding-worker/control.ts";
import { CodingControlBusy } from "../../runner-orchestrator/src/coding-executor.ts";
import { CODING_SNAPSHOT_LOG_BYTES, CodingSnapshotRecords } from "../../runner-orchestrator/src/coding-snapshots.ts";

describe("dedicated coding executor control", () => {
	it("uses a closed RPC set and fixed HTTPS origin without retries", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => new Response("null", { status: 200 }));
		const control = new CodingExecutorHttpControl({
			supabaseUrl: "https://project.supabase.co",
			serviceRoleKey: "private",
			fetch: fetcher,
		});
		expect(
			await control.call("qorpera_claim_coding_session", { p_owner: "node" }, new AbortController().signal),
		).toBeNull();
		expect(fetcher).toHaveBeenCalledWith(
			"https://project.supabase.co/rest/v1/rpc/qorpera_claim_coding_session",
			expect.objectContaining({ redirect: "error", method: "POST" }),
		);
		await expect(
			control.call("qorpera_configure_coding_vm_policy", {}, new AbortController().signal),
		).rejects.toThrow("METHOD_INVALID");
		expect(fetcher).toHaveBeenCalledTimes(1);
		await control.call("qorpera_list_coding_machines", {}, new AbortController().signal);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://project.supabase.co/rest/v1/rpc/qorpera_list_coding_machines",
			expect.objectContaining({ redirect: "error", method: "POST" }),
		);
		await control.call("qorpera_route_coding_command", {}, new AbortController().signal);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://project.supabase.co/rest/v1/rpc/qorpera_route_coding_command",
			expect.objectContaining({ redirect: "error", method: "POST" }),
		);
		// G2-6b: the guest-facing listener's lease proof.
		await control.call("qorpera_native_binding_proven", {}, new AbortController().signal);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://project.supabase.co/rest/v1/rpc/qorpera_native_binding_proven",
			expect.objectContaining({ redirect: "error", method: "POST" }),
		);
		// 5h-2: the node's snapshot records.
		await control.call("qorpera_list_coding_snapshots", {}, new AbortController().signal);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://project.supabase.co/rest/v1/rpc/qorpera_list_coding_snapshots",
			expect.objectContaining({ redirect: "error", method: "POST" }),
		);
		// 5e: which companies with a code host on the node are being deleted.
		await control.call("qorpera_code_hosts_deleting", {}, new AbortController().signal);
		expect(fetcher).toHaveBeenLastCalledWith(
			"https://project.supabase.co/rest/v1/rpc/qorpera_code_hosts_deleting",
			expect.objectContaining({ redirect: "error", method: "POST" }),
		);
		// The per-session VM authority is gone.
		await expect(control.call("qorpera_describe_coding_cleanup", {}, new AbortController().signal)).rejects.toThrow(
			"METHOD_INVALID",
		);
	});
	it("tells only a complete PostgREST 55P03 refusal apart as busy", async () => {
		const busy = {
			code: "55P03",
			details: null,
			hint: null,
			message: 'could not obtain lock on row in relation "qorpera_profiles"',
		};
		const answer = (status: number, body: string) => async () =>
			new Response(body, { status, headers: { "content-type": "application/json" } });
		const cases: [status: number, body: string, expected: string][] = [
			[500, JSON.stringify(busy), "CODING_CONTROL_BUSY"],
			[500, JSON.stringify({ ...busy, code: "40P01" }), "CODING_CONTROL_UNCONFIRMED"],
			[503, JSON.stringify(busy), "CODING_CONTROL_UNCONFIRMED"],
			[500, JSON.stringify({ ...busy, extra: 1 }), "CODING_CONTROL_UNCONFIRMED"],
			[500, JSON.stringify({ ...busy, details: 1 }), "CODING_CONTROL_UNCONFIRMED"],
			[500, JSON.stringify({ ...busy, message: "x".repeat(5000) }), "CODING_CONTROL_UNCONFIRMED"],
			[500, "55P03", "CODING_CONTROL_UNCONFIRMED"],
		];
		for (const [status, body, expected] of cases) {
			const fetcher = vi.fn<typeof fetch>(answer(status, body));
			const control = new CodingExecutorHttpControl({
				supabaseUrl: "https://project.supabase.co",
				serviceRoleKey: "private",
				fetch: fetcher,
			});
			const call = control.call("qorpera_begin_coding_turn", {}, new AbortController().signal);
			await expect(call).rejects.toThrow(expected);
			if (expected === "CODING_CONTROL_BUSY") await expect(call).rejects.toBeInstanceOf(CodingControlBusy);
			// The control never retries by itself.
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	});
	it("carries a snapshot build's longest log both ways (5h-2)", async () => {
		const build = {
			buildId: "52500000-0000-4000-8000-0000000000b1",
			leaseToken: "52500000-0000-4000-8000-0000000000b2",
			leaseUntil: "2026-10-15T01:02:03.123456+00:00",
		};
		const sent: string[] = [];
		let answer: unknown = { schema: "qorpera.coding-snapshot-build/v1", buildId: build.buildId, state: "failed" };
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			sent.push(String(init?.body));
			return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
		});
		const records = new CodingSnapshotRecords({
			control: new CodingExecutorHttpControl({
				supabaseUrl: "https://project.supabase.co",
				serviceRoleKey: "private",
				fetch: fetcher,
			}),
			owner: "exec-a",
			machineIdSha256: "a".repeat(64),
		});
		// An escape character takes six bytes as JSON: 30000 of them are 180000, cut to what SQL keeps.
		const log = String.fromCharCode(0x1b).repeat(30000);
		expect(
			await records.finish(build, { kind: "failed", code: "SETUP_FAILED", log }, new AbortController().signal),
		).toBe("failed");
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(Buffer.byteLength(sent[0] ?? "")).toBeLessThanOrEqual(128 * 1024);
		const kept = (JSON.parse(sent[0] ?? "") as { p_log: string }).p_log;
		expect(Buffer.byteLength(JSON.stringify(kept)) - 2).toBeLessThanOrEqual(CODING_SNAPSHOT_LOG_BYTES);
		// The failed answer at the next attach brings that log back.
		const failure = { buildId: build.buildId, code: "SETUP_FAILED", log: kept, finishedAt: build.leaseUntil };
		answer = {
			schema: "qorpera.coding-snapshot-plan/v1",
			state: "failed",
			snapshot: null,
			build: null,
			waitingUntil: null,
			failure,
		};
		expect(
			await records.begin(
				{ workerId: "52500000-0000-4000-8000-0000000000c1", leaseToken: "52500000-0000-4000-8000-0000000000e1" },
				{ setupDigest: "d".repeat(64), commitSha: "c".repeat(40) },
				new AbortController().signal,
			),
		).toEqual({ state: "failed", snapshot: null, failure });
	});
	it("does not wait on an error body that stalls", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response(new ReadableStream({ start() {} }), { status: 500 }),
		);
		const control = new CodingExecutorHttpControl({
			supabaseUrl: "https://project.supabase.co",
			serviceRoleKey: "private",
			fetch: fetcher,
		});
		const started = Date.now();
		await expect(control.call("qorpera_begin_coding_turn", {}, new AbortController().signal)).rejects.toThrow(
			"CODING_CONTROL_UNCONFIRMED",
		);
		expect(Date.now() - started).toBeLessThan(5000);
	});
	it("sanitizes failures and rejects credential-bearing destinations", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error("secret-token");
		});
		const control = new CodingExecutorHttpControl({
			supabaseUrl: "https://project.supabase.co",
			serviceRoleKey: "private",
			fetch: fetcher,
		});
		await expect(control.call("qorpera_heartbeat_coding_session", {}, new AbortController().signal)).rejects.toThrow(
			"CODING_CONTROL_UNCONFIRMED",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			() =>
				new CodingExecutorHttpControl({
					supabaseUrl: "https://user:pass@project.supabase.co",
					serviceRoleKey: "private",
				}),
		).toThrow("CONFIG_INVALID");
	});
});
