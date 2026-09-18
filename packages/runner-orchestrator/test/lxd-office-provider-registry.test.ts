import { afterEach, describe, expect, it, vi } from "vitest";
import { LxdOfficeProviderHttpRegistry, type LxdOfficeProviderMethod } from "../src/lxd-office-provider-registry.ts";

const key = "synthetic-infrastructure-credential-".repeat(2);
const method = "qorpera_runtime_office_provider_status";
const signal = () => new AbortController().signal;
const response = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
afterEach(() => {
	vi.useRealTimers();
});
describe("provider-only office HTTP registry", () => {
	it.each([
		method,
		"qorpera_enroll_office_package_provision",
		"qorpera_check_office_package_provision",
		"qorpera_check_office_package_provision_observation",
		"qorpera_ack_office_package_provision",
		"qorpera_office_package_provision_status",
		"qorpera_check_office_package_invocation",
		"qorpera_ack_office_package_invocation",
		"qorpera_reserve_runtime_node_machine",
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
		"qorpera_runtime_office_provider_activation",
		"qorpera_begin_runtime_office_host_reboot",
		"qorpera_record_runtime_office_host_reboot_resume",
	] as const)("uses exact HTTPS RPC %s without following or retrying", async (method) => {
		const fetcher = vi.fn(async () => response({ schema: "synthetic" }));
		const client = new LxdOfficeProviderHttpRegistry("https://control.example", key, fetcher);
		expect(await client.call(method, { p_scope: { companyId: "test" } }, signal())).toEqual({
			schema: "synthetic",
		});
		expect(fetcher).toHaveBeenCalledWith(
			`https://control.example/rest/v1/rpc/${method}`,
			expect.objectContaining({
				redirect: "error",
				method: "POST",
				headers: expect.objectContaining({ apikey: key, authorization: `Bearer ${key}` }),
				body: '{"p_scope":{"companyId":"test"}}',
			}),
		);
	});
	it.each([
		"http://localhost",
		"https://control.example/",
		"https://control.example/path",
		"https://user:secret@control.example",
		"https://control.example?x=1",
		"https://control.example#hash",
		" https://control.example",
	])("refuses noncanonical/untrusted root %s", (url) => {
		expect(() => new LxdOfficeProviderHttpRegistry(url, key)).toThrow("INVALID_OFFICE_PROVIDER_REGISTRY");
	});
	it.each([
		"qorpera_set_runtime_office_provider",
		"qorpera_configure_runtime_node",
		"qorpera_enroll_runtime_node_provider",
		"qorpera_observe_runtime_node",
		"qorpera_cancel_runtime_office_start",
		"qorpera_report_runtime_office_ready",
		"qorpera_release_machine_allocation",
		"../tables",
	])("refuses %s before HTTP", async (value) => {
		const fetcher = vi.fn();
		const client = new LxdOfficeProviderHttpRegistry("https://control.example", key, fetcher);
		await expect(client.call(value as LxdOfficeProviderMethod, {}, signal())).rejects.toThrow("FORBIDDEN");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each(["redirect", "denied", "large", "mime", "invalid_json", "length", "invalid_utf8"])(
		"rejects %s once and redacts the response",
		async (kind) => {
			const fetcher = vi.fn(async () => {
				if (kind === "redirect")
					return new Response(key, { status: 307, headers: { location: "https://other.example" } });
				if (kind === "denied") return new Response(key, { status: 403 });
				if (kind === "large") return response("x".repeat(65537));
				if (kind === "mime") return new Response(key);
				if (kind === "invalid_json") return new Response(key, { headers: { "content-type": "application/json" } });
				if (kind === "invalid_utf8")
					return new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } });
				return new Response("{}", { headers: { "content-type": "application/json", "content-length": "3" } });
			});
			const client = new LxdOfficeProviderHttpRegistry("https://control.example", key, fetcher);
			await expect(client.call(method, {}, signal())).rejects.toThrow(/^OFFICE_PROVIDER_RPC_UNCONFIRMED$/);
			expect(fetcher).toHaveBeenCalledTimes(1);
		},
	);
	it("bounds a stalled fetch and retains its slot until actual transport settlement", async () => {
		vi.useFakeTimers();
		let finish!: (value: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const client = new LxdOfficeProviderHttpRegistry("https://control.example", key, fetcher);
		const controller = new AbortController();
		const result = expect(client.call(method, {}, controller.signal)).rejects.toThrow("UNCONFIRMED");
		controller.abort();
		await result;
		await expect(client.call(method, {}, signal())).rejects.toThrow("PENDING");
		finish(response({}));
		await vi.waitFor(async () => {
			await expect(client.call("forbidden" as LxdOfficeProviderMethod, {}, signal())).rejects.toThrow("FORBIDDEN");
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("does not send oversized or aborted requests", async () => {
		const fetcher = vi.fn();
		const client = new LxdOfficeProviderHttpRegistry("https://control.example", key, fetcher);
		await expect(client.call(method, { data: "x".repeat(65536) }, signal())).rejects.toThrow("INVALID");
		await expect(client.call(method, {}, AbortSignal.abort())).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
