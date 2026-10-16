import { describe, expect, it, vi } from "vitest";
import { CodingExecutorHttpControl } from "../../../deploy/coding-worker/control.ts";
import { CodingControlBusy, CodingControlRefused } from "../../runner-orchestrator/src/coding-executor.ts";

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
		// F3 5g-4: a session's folder view.
		for (const method of ["qorpera_folder_view_open", "qorpera_folder_view_close"]) {
			await control.call(method, {}, new AbortController().signal);
			expect(fetcher).toHaveBeenLastCalledWith(
				`https://project.supabase.co/rest/v1/rpc/${method}`,
				expect.objectContaining({ redirect: "error", method: "POST" }),
			);
		}
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
	it("keeps a folder view's refusal, in the core's words, and no other", async () => {
		const refusal = (code: string, message: string) => JSON.stringify({ code, details: null, hint: null, message });
		const notCurrent = refusal("42501", "Folder view attachment is not current");
		const cases: [method: string, status: number, body: string, reason: string | undefined][] = [
			["qorpera_folder_view_open", 403, notCurrent, "Folder view attachment is not current"],
			[
				"qorpera_folder_view_open",
				403,
				refusal("42501", "Company folder is unavailable"),
				"Company folder is unavailable",
			],
			[
				"qorpera_folder_view_open",
				400,
				refusal("22023", "Folder view anchor is invalid"),
				"Folder view anchor is invalid",
			],
			[
				"qorpera_folder_view_close",
				403,
				refusal("42501", "Folder view is unavailable"),
				"Folder view is unavailable",
			],
			// Another method, message, SQLSTATE, status or body shape stays unconfirmed.
			["qorpera_attach_coding_session", 403, notCurrent, undefined],
			["qorpera_folder_view_close", 403, notCurrent, undefined],
			["qorpera_folder_view_open", 403, refusal("42501", "permission denied for function"), undefined],
			["qorpera_folder_view_open", 403, refusal("P0001", "Folder view attachment is not current"), undefined],
			["qorpera_folder_view_open", 401, notCurrent, undefined],
			["qorpera_folder_view_open", 500, notCurrent, undefined],
			["qorpera_folder_view_open", 403, JSON.stringify({ ...JSON.parse(notCurrent), extra: 1 }), undefined],
			["qorpera_folder_view_open", 403, "Folder view attachment is not current", undefined],
		];
		for (const [method, status, body, reason] of cases) {
			const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status }));
			const control = new CodingExecutorHttpControl({
				supabaseUrl: "https://project.supabase.co",
				serviceRoleKey: "private",
				fetch: fetcher,
			});
			const failure = await control.call(method, {}, new AbortController().signal).then(
				() => undefined,
				(error: unknown) => error,
			);
			if (reason === undefined) expect(failure).toEqual(new Error("CODING_CONTROL_UNCONFIRMED"));
			else {
				expect(failure).toBeInstanceOf(CodingControlRefused);
				expect((failure as CodingControlRefused).reason).toBe(reason);
			}
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
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
