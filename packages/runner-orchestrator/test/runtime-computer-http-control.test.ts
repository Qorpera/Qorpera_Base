import { describe, expect, it, vi } from "vitest";
import type { ServiceHttpFetch } from "../src/http-transport.ts";
import { RuntimeComputerHttpControl } from "../src/runtime-computer-http-control.ts";

const config = {
	supabaseUrl: "https://control.example",
	supabaseServiceKey: "s".repeat(64),
	executorSecret: "e".repeat(43),
};
const method = "qorpera_prepare_runtime_computer_permit";
const signal = () => AbortSignal.timeout(5000);
describe("runtime computer host capability transport", () => {
	it.each([
		method,
		"qorpera_register_runtime_office_computer_outage",
		"qorpera_prepare_runtime_office_outage_recovery",
		"qorpera_check_runtime_office_outage_recovery",
		"qorpera_runtime_office_outage_recovery_status",
		"qorpera_prepare_runtime_office_outage_termination",
		"qorpera_ack_runtime_office_outage_termination",
		"qorpera_check_runtime_office_outage_configuration",
		"qorpera_prepare_runtime_office_outage_successor",
		"qorpera_runtime_office_outage_successor_status",
		"qorpera_check_runtime_office_outage_successor",
		"qorpera_activate_runtime_office_outage_successor",
	])("adds the separate secret only at the protected transport boundary for %s", async (method) => {
		const fetcher = vi.fn<ServiceHttpFetch>().mockResolvedValue(Response.json({ permitId: "permit" }));
		const control = new RuntimeComputerHttpControl(config, fetcher);
		const request = { p_request: { allocationId: "allocation" } };
		await expect(control.call(method, request, signal())).resolves.toEqual({ permitId: "permit" });
		expect(request).toEqual({ p_request: { allocationId: "allocation" } });
		const [url, init] = fetcher.mock.calls[0]!;
		expect(url).toBe(`https://control.example/rest/v1/rpc/${method}`);
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(JSON.parse(String(init?.body))).toEqual({ ...request, p_executor_secret: config.executorSecret });
		expect(JSON.stringify(control)).toBe("{}");
	});
	it("refuses arbitrary RPCs and caller-supplied capability overrides before sending", async () => {
		const fetcher = vi.fn<ServiceHttpFetch>();
		const control = new RuntimeComputerHttpControl(config, fetcher);
		await expect(
			control.call("qorpera_enroll_runtime_computer_executor", { p_request: {} }, signal()),
		).rejects.toThrow("FORBIDDEN");
		await expect(control.call(method, { p_request: {}, p_executor_secret: "injected" }, signal())).rejects.toThrow(
			"REQUEST_INVALID",
		);
		await expect(control.call(method, { p_request: [] }, signal())).rejects.toThrow("REQUEST_INVALID");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("does not echo transport or server bodies, retry, or accept redirects", async () => {
		const fetcher = vi
			.fn<ServiceHttpFetch>()
			.mockRejectedValueOnce(new Error(`private:${config.executorSecret}`))
			.mockResolvedValueOnce(new Response(config.executorSecret, { status: 400 }))
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example" } }));
		const control = new RuntimeComputerHttpControl(config, fetcher);
		for (let attempt = 0; attempt < 3; attempt++)
			await expect(control.call(method, { p_request: {} }, signal())).rejects.toThrow(
				/^RUNTIME_COMPUTER_RPC_UNCONFIRMED$/,
			);
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	it("rejects oversized, truncated and invalid JSON responses", async () => {
		const fetcher = vi
			.fn<ServiceHttpFetch>()
			.mockResolvedValueOnce(Response.json({ body: "x".repeat(65536) }))
			.mockResolvedValueOnce(
				new Response("{}", { headers: { "content-type": "application/json", "content-length": "3" } }),
			)
			.mockResolvedValueOnce(new Response("{", { headers: { "content-type": "application/json" } }));
		const control = new RuntimeComputerHttpControl(config, fetcher);
		for (let attempt = 0; attempt < 3; attempt++)
			await expect(control.call(method, { p_request: {} }, signal())).rejects.toThrow("UNCONFIRMED");
	});
	it("does not send canceled or oversized requests", async () => {
		const fetcher = vi.fn<ServiceHttpFetch>();
		const control = new RuntimeComputerHttpControl(config, fetcher);
		await expect(control.call(method, { p_request: {} }, AbortSignal.abort())).rejects.toThrow();
		await expect(control.call(method, { p_request: { body: "x".repeat(65536) } }, signal())).rejects.toThrow(
			"UNCONFIRMED",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("requires a canonical HTTPS origin and separate valid credentials", () => {
		for (const supabaseUrl of [
			"http://control.example",
			"https://control.example/",
			"https://user:pass@control.example",
			"https://control.example/rpc",
		])
			expect(() => new RuntimeComputerHttpControl({ ...config, supabaseUrl })).toThrow("CONTROL_INVALID");
		expect(() => new RuntimeComputerHttpControl({ ...config, executorSecret: "short" })).toThrow("CONTROL_INVALID");
		expect(() => new RuntimeComputerHttpControl({ ...config, executorSecret: config.supabaseServiceKey })).toThrow(
			"CONTROL_INVALID",
		);
	});
});
