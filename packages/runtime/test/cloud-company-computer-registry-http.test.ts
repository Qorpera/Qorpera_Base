import {
	CompanyComputerRegistryUnansweredError,
	companyComputerAuthorityUnanswered,
	HttpCloudCompanyComputerRegistry,
	OfficeComputerMeteringPending,
} from "@qorpera/runtime/cloud-company-computer-registry-http";
import { cloudToolRequest } from "@qorpera/runtime/cloud-native-tool-authority";
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
	it("classifies only the exact metering prerequisite on startup and work reads", async () => {
		const f = fixture();
		for (const method of [
			"qorpera_check_runtime_office_startup",
			"qorpera_report_runtime_office_ready",
			"qorpera_check_runtime_office_work_binding",
		] as const) {
			f.fetcher.mockResolvedValueOnce(
				Response.json(
					{ code: "55000", message: "Office computer metering not ready", details: null, hint: null },
					{ status: 400 },
				),
			);
			const pending = await f.registry.call(method, {}, f.signal).catch((error: unknown) => error);
			expect(pending).toBeInstanceOf(OfficeComputerMeteringPending);
			expect(companyComputerAuthorityUnanswered(pending)).toBe(false);
			expect(
				companyComputerAuthorityUnanswered(
					new Error("PULSE", {
						cause: new AggregateError([
							new CompanyComputerRegistryUnansweredError(new Error("timeout")),
							pending,
						]),
					}),
				),
			).toBe(false);
		}
		for (const error of [
			{ code: "42501", message: "Office computer metering not ready" },
			{ code: "55000", message: "Office startup binding differs" },
			{ message: "Office computer metering not ready" },
		]) {
			f.fetcher.mockResolvedValueOnce(Response.json(error, { status: 400 }));
			await expect(f.registry.call("qorpera_check_runtime_office_startup", {}, f.signal)).rejects.toThrow(
				"OFFICE_REGISTRY_UNCONFIRMED",
			);
		}
		f.fetcher.mockResolvedValueOnce(
			Response.json({ code: "55000", message: "Office computer metering not ready" }, { status: 400 }),
		);
		await expect(f.registry.call("qorpera_native_office_operation", {}, f.signal)).rejects.toThrow(
			"OFFICE_REGISTRY_UNCONFIRMED",
		);
		expect(f.fetcher).toHaveBeenCalledTimes(7);
	});
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
	it("tells a refusal apart from no answer, with the same code either way", async () => {
		const f = fixture();
		const outcome = async (respond: () => Promise<Response>) => {
			f.fetcher.mockImplementationOnce(respond);
			const error = await f.registry.call("qorpera_check_runtime_office_shared_surface", {}, f.signal).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(error).toMatchObject({ message: "OFFICE_REGISTRY_UNCONFIRMED" });
			return companyComputerAuthorityUnanswered(error);
		};
		// SQL raised (PostgREST 403 for 42501, 400 for other errors): a refusal.
		expect(await outcome(async () => Response.json({ code: "42501" }, { status: 403 }))).toBe(false);
		expect(await outcome(async () => Response.json({ code: "22023" }, { status: 400 }))).toBe(false);
		expect(await outcome(async () => Response.json({}, { status: 401 }))).toBe(false);
		// The network, an overloaded or failing server, a throttle: no answer.
		for (const status of [500, 502, 503, 504, 408, 425, 429])
			expect(await outcome(async () => new Response("", { status }))).toBe(true);
		expect(
			await outcome(async () => {
				throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
			}),
		).toBe(true);
		// A complete body that is not an object is still an answer; one over the bound is not.
		expect(await outcome(async () => new Response("not json"))).toBe(false);
		expect(await outcome(async () => new Response("null"))).toBe(false);
		expect(await outcome(async () => new Response("x".repeat(65537)))).toBe(true);
		// A database error in a 5xx is an answer, unless it says "try again".
		expect(await outcome(async () => Response.json({ code: "P0002", message: "secret" }, { status: 500 }))).toBe(
			false,
		);
		expect(await outcome(async () => Response.json({ code: "55000" }, { status: 500 }))).toBe(false);
		for (const code of ["57014", "55P03", "40001", "40P01", "08006", "53300", "25006"])
			expect(await outcome(async () => Response.json({ code }, { status: code === "40001" ? 409 : 500 }))).toBe(
				true,
			);
		expect(await outcome(async () => Response.json({ code: "PGRST000" }, { status: 503 }))).toBe(true);
		vi.useFakeTimers();
		const late = f.registry.call("qorpera_check_runtime_office_shared_surface", {}, f.signal).catch((error) => error);
		f.fetcher.mockImplementationOnce(() => new Promise<Response>(() => undefined));
		await vi.advanceTimersByTimeAsync(3001);
		expect(companyComputerAuthorityUnanswered(await late)).toBe(true);
	});
	it("finds no answer through wrapping causes and local deadlines, and nothing else", async () => {
		const unanswered = new CompanyComputerRegistryUnansweredError(new Error("socket hang up"));
		expect(unanswered.message).toBe("OFFICE_REGISTRY_UNCONFIRMED");
		expect(
			companyComputerAuthorityUnanswered(
				new Error("SHARED_SURFACE_UNCONFIRMED", {
					cause: new Error("OFFICE_GUEST_READINESS_UNCONFIRMED", { cause: unanswered }),
				}),
			),
		).toBe(true);
		expect(companyComputerAuthorityUnanswered(new AggregateError([new Error("x"), unanswered]))).toBe(true);
		// A registry refusal anywhere wins over a missing answer elsewhere.
		const f = fixture();
		f.fetcher.mockResolvedValueOnce(Response.json({ code: "42501" }, { status: 403 }));
		const refusal = await f.registry
			.call("qorpera_check_runtime_office_shared_surface", {}, f.signal)
			.catch((error: unknown) => error);
		expect(companyComputerAuthorityUnanswered(refusal)).toBe(false);
		expect(companyComputerAuthorityUnanswered(new AggregateError([unanswered, refusal]))).toBe(false);
		expect(
			companyComputerAuthorityUnanswered(new Error("PULSE", { cause: new AggregateError([refusal, unanswered]) })),
		).toBe(false);
		vi.useFakeTimers();
		const deadline = cloudToolRequest(
			() => new Promise<void>(() => undefined),
			new AbortController().signal,
			10,
		).catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(11);
		expect(companyComputerAuthorityUnanswered(new Error("PULSE", { cause: await deadline }))).toBe(true);
		expect(companyComputerAuthorityUnanswered(new Error("COMPUTER_REQUEST_STOPPED"))).toBe(true);
		for (const refused of [
			new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: new Error("denied") }),
			new Error("OFFICE_PRIVACY_FENCED"),
			new Error("OFFICE_GUEST_READINESS_UNCONFIRMED", { cause: new Error("boot differs") }),
			"not an error",
			undefined,
		])
			expect(companyComputerAuthorityUnanswered(refused)).toBe(false);
	});
});
