import { describe, expect, it, vi } from "vitest";
import { CodingExecutorHttpControl } from "../../../deploy/coding-worker/control.ts";

describe("dedicated coding executor control", () => {
	it("requires a separate host secret for paid RPCs and never sends it to ordinary RPCs", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => new Response("null", { status: 200 }));
		const options = { supabaseUrl: "https://project.supabase.co", serviceRoleKey: "private", fetch: fetcher };
		const signal = new AbortController().signal;
		await expect(
			new CodingExecutorHttpControl(options).call("qorpera_prepare_coding_computer_permit", {}, signal),
		).rejects.toThrow("COMPUTER_KEY_REQUIRED");
		expect(fetcher).not.toHaveBeenCalled();
		const secret = "h".repeat(43);
		const control = new CodingExecutorHttpControl({ ...options, computerExecutorSecret: secret });
		await control.call(
			"qorpera_prepare_coding_computer_permit",
			{ p_request: {}, p_executor_secret: "caller-value" },
			signal,
		);
		expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ p_request: {}, p_executor_secret: secret });
		await control.call("qorpera_claim_coding_session", { p_owner: "node" }, signal);
		expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ p_owner: "node" });
		await expect(control.call("qorpera_reserve_computer_allowance", {}, signal)).rejects.toThrow("METHOD_INVALID");
		expect(() => new CodingExecutorHttpControl({ ...options, computerExecutorSecret: "short" })).toThrow(
			"COMPUTER_KEY_INVALID",
		);
	});
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
		// The per-session VM authority is gone.
		await expect(control.call("qorpera_describe_coding_cleanup", {}, new AbortController().signal)).rejects.toThrow(
			"METHOD_INVALID",
		);
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
