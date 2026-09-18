import { HttpCloudCompanyComputerRegistry } from "@qorpera/runtime/cloud-company-computer-registry-http";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
function fixture() {
	const fetcher = vi.fn<typeof fetch>(async () => Response.json({ state: "released" }));
	const registry = new HttpCloudCompanyComputerRegistry({
		supabaseUrl: "https://control.example.test",
		serviceRoleKey: "sb_secret_fixture",
		fetch: fetcher,
	});
	return { fetcher, registry, signal: new AbortController().signal };
}
describe("host-only office registry transport", () => {
	it("sends the exact retained record through the bounded service-only recovery port", async () => {
		const f = fixture(),
			record = '{"schema":"synthetic-closed-record"}\n';
		await f.registry.call("qorpera_retain_runtime_screen_observation", { p_record: record }, f.signal);
		expect(f.fetcher.mock.calls[0][0]).toBe(
			"https://control.example.test/rest/v1/rpc/qorpera_retain_runtime_screen_observation",
		);
		expect(JSON.parse(f.fetcher.mock.calls[0][1]!.body as string)).toEqual({ p_record: record });
	});
	it.each([
		"qorpera_runtime_office_provider_status",
		"qorpera_reserve_runtime_office_start",
		"qorpera_check_runtime_office_start",
		"qorpera_check_runtime_office_adoption",
		"qorpera_check_runtime_office_startup",
		"qorpera_report_runtime_office_ready",
	] as const)("supports the provider discovery/admission port: %s", async (method) => {
		const f = fixture();
		await f.registry.call(method, { p_provider_id: "fixture" }, f.signal);
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(f.fetcher.mock.calls[0][0]).toBe(`https://control.example.test/rest/v1/rpc/${method}`);
		expect(f.fetcher.mock.calls[0][1]?.redirect).toBe("error");
	});
	it("uses the configured HTTPS origin, closed RPC name and service header without redirects", async () => {
		const f = fixture();
		await expect(
			f.registry.call("qorpera_release_runtime_office_viewer", { p_grant: { fixture: true } }, f.signal),
		).resolves.toEqual({ state: "released" });
		expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
			"https://control.example.test/rest/v1/rpc/qorpera_release_runtime_office_viewer",
			{
				method: "POST",
				redirect: "error",
				signal: expect.any(AbortSignal),
				headers: { apikey: "sb_secret_fixture", "content-type": "application/json" },
				body: '{"p_grant":{"fixture":true}}',
			},
		);
	});
	it("does not replay writes or expose SQL diagnostics on an uncertain or denied response", async () => {
		const f = fixture();
		f.fetcher.mockResolvedValueOnce(
			Response.json({ message: "secret profile contents SCREEN_OCCUPIED", code: "42501" }, { status: 403 }),
		);
		await expect(f.registry.call("qorpera_native_office_operation", {}, f.signal)).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		expect(f.fetcher).toHaveBeenCalledOnce();
	});
	it("rejects extra origin components, unknown methods and overlarge requests before network access", async () => {
		for (const supabaseUrl of [
			"http://control.example.test",
			"https://user:password@control.example.test",
			"https://control.example.test/rpc",
			"https://control.example.test/?key=value",
		]) {
			expect(() => new HttpCloudCompanyComputerRegistry({ supabaseUrl, serviceRoleKey: "fixture" })).toThrow();
		}
		const f = fixture();
		await expect(
			f.registry.call("qorpera_native_office_operation", { input: "x".repeat(128 * 1024) }, f.signal),
		).rejects.toThrow("OFFICE_REGISTRY_REQUEST_TOO_LARGE");
		// Runtime rejection matters even if an unsafe caller erases TypeScript.
		await expect(f.registry.call("unknown" as never, {}, f.signal)).rejects.toThrow("UNKNOWN_OFFICE_REGISTRY_METHOD");
		await expect(f.registry.call("qorpera_set_runtime_office_provider" as never, {}, f.signal)).rejects.toThrow(
			"UNKNOWN_OFFICE_REGISTRY_METHOD",
		);
		for (const method of [
			"qorpera_prepare_runtime_office_activation",
			"qorpera_runtime_office_activation_status",
			"qorpera_activate_runtime_office",
			"qorpera_begin_runtime_office_lifecycle",
			"qorpera_runtime_office_lifecycle_status",
			"qorpera_prepare_runtime_office_stop",
			"qorpera_ack_runtime_office_stop",
			"qorpera_runtime_office_stop_status",
			"qorpera_prepare_runtime_office_successor",
			"qorpera_runtime_office_successor_status",
			"qorpera_check_runtime_office_successor",
			"qorpera_activate_runtime_office_successor",
			"qorpera_prepare_runtime_office_boot_successor",
			"qorpera_runtime_office_boot_successor_status",
			"qorpera_check_runtime_office_boot_successor",
			"qorpera_activate_runtime_office_boot_successor",
			"qorpera_prepare_runtime_office_boot_intent",
			"qorpera_runtime_office_boot_intent_status",
			"qorpera_check_runtime_office_boot_intent",
		]) {
			await expect(f.registry.call(method as never, {}, f.signal)).rejects.toThrow("UNKNOWN_OFFICE_REGISTRY_METHOD");
		}
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("bounds body size and the entire response deadline", async () => {
		const f = fixture();
		f.fetcher.mockResolvedValueOnce(new Response("x".repeat(65537)));
		await expect(f.registry.call("qorpera_native_office_descriptor", {}, f.signal)).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		vi.useFakeTimers();
		f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
		const pending = expect(f.registry.call("qorpera_native_office_descriptor", {}, f.signal)).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		await vi.advanceTimersByTimeAsync(3001);
		await pending;
		expect(f.fetcher).toHaveBeenCalledTimes(2);
	});
});
