import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { CloudCompanyHeadConflict } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

function fixture(transport: typeof fetch) {
	return new HttpCloudCompanyPathControl({
		supabaseUrl: "https://authority.example",
		serviceRoleKey: "synthetic-service-key",
		fetch: transport,
	});
}

describe("Company File bounded control transport", () => {
	it.each([
		"qorpera_assert_company_path_reads",
		"qorpera_verify_company_path_file",
		"qorpera_native_presence_forget",
	] as const)("accepts PostgREST no-content success for the void RPC %s", async (method) => {
		const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		await expect(fixture(transport).call(method, {}, new AbortController().signal)).resolves.toBeNull();
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([
		"qorpera_record_runtime_observation",
		"qorpera_begin_native_company_execution_v2",
		"qorpera_describe_company_run_context",
		"qorpera_read_company_run_context",
		"qorpera_read_company_path_v2",
		"qorpera_list_company_paths_v2",
		"qorpera_confirm_company_path_read",
		"qorpera_record_native_context_view",
		"qorpera_check_company_path_mutation",
		"qorpera_verify_company_path_tree",
		"qorpera_prepare_company_path_mutation",
		"qorpera_commit_company_path_mutation",
		"qorpera_native_company_file_write_source",
		"qorpera_native_company_file_write",
		"qorpera_prepare_company_path_approval",
		"qorpera_apply_company_path_approval",
		"qorpera_native_presence_register",
		"qorpera_company_presence_scope",
		"qorpera_native_presence_subject",
	] as const)("still requires a response value for %s", async (method) => {
		const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		await expect(fixture(transport).call(method, {}, new AbortController().signal)).rejects.toThrow("unavailable");
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([200, 202, 205, 401, 403, 429, 500, 503])(
		"does not mistake another empty response (%i) for a successful permission check",
		async (status) => {
			const transport = vi.fn<typeof fetch>(async () => new Response(null, { status }));
			await expect(
				fixture(transport).call("qorpera_assert_company_path_reads", {}, new AbortController().signal),
			).rejects.toThrow("unavailable");
			expect(transport).toHaveBeenCalledTimes(1);
		},
	);

	it("does not accept a no-content response after cancellation", async () => {
		const abort = new AbortController();
		const transport = vi.fn<typeof fetch>(async () => {
			abort.abort();
			return new Response(null, { status: 204 });
		});
		await expect(fixture(transport).call("qorpera_assert_company_path_reads", {}, abort.signal)).rejects.toThrow(
			"unavailable",
		);
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("uses only the fixed HTTPS RPC route and rejects redirects", async () => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(null));
		await fixture(transport).call("qorpera_assert_company_path_reads", { p_paths: [] }, new AbortController().signal);
		expect(transport).toHaveBeenCalledWith(
			"https://authority.example/rest/v1/rpc/qorpera_assert_company_path_reads",
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				body: '{"p_paths":[]}',
				headers: {
					apikey: "synthetic-service-key",
					"content-type": "application/json",
				},
			}),
		);
		for (const supabaseUrl of [
			"http://authority.example",
			"https://user:pass@authority.example",
			"https://authority.example/other",
			"https://authority.example/?redirect=elsewhere",
		]) {
			expect(() => new HttpCloudCompanyPathControl({ supabaseUrl, serviceRoleKey: "fixture" })).toThrow();
		}
	});

	it.each([
		[409, { code: "PT409", message: "head changed", details: null, hint: null }, true],
		[409, { code: "40001", message: "path changed" }, false],
		[503, { code: "PT409" }, false],
		[403, { code: "42501", message: "PRIVATE_DIAGNOSTIC" }, false],
		[409, { code: "PT409", approved: true }, false],
	] as const)("distinguishes definite head conflict %i %j", async (status, body, conflict) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
		const error = await fixture(transport)
			.call("qorpera_commit_company_path_mutation", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error instanceof CloudCompanyHeadConflict).toBe(conflict);
		expect(String(error)).not.toContain("PRIVATE_DIAGNOSTIC");
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([200, 403])("bounds stalled success and denial bodies (%i) and cancels the reader", async (status) => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const transport = vi.fn<typeof fetch>(
			async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status }),
		);
		const result = fixture(transport).call("qorpera_commit_company_path_mutation", {}, new AbortController().signal);
		const rejected = expect(result).rejects.toThrow("unavailable");
		await vi.advanceTimersByTimeAsync(3001);
		await rejected;
		expect(cancel).toHaveBeenCalled();
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("bounds an uncooperative fetch and never retries an uncertain write", async () => {
		vi.useFakeTimers();
		const transport = vi.fn<typeof fetch>(async () => new Promise<Response>(() => undefined));
		const result = fixture(transport).call("qorpera_commit_company_path_mutation", {}, new AbortController().signal);
		const rejected = expect(result).rejects.toThrow("unavailable");
		await vi.advanceTimersByTimeAsync(3001);
		await rejected;
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("bounds responses and never interprets malformed errors as permission to retry", async () => {
		for (const response of [
			new Response("bad JSON", { status: 409 }),
			new Response(`"${"x".repeat(5000)}"`, { status: 409 }),
			Response.json({ body: "x".repeat(300000) }),
		]) {
			const error = await fixture(async () => response)
				.call("qorpera_read_company_path_v2", {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(CloudCompanyHeadConflict);
		}
	});

	it("does not call the service when already cancelled", async () => {
		const transport = vi.fn<typeof fetch>();
		const abort = new AbortController();
		abort.abort();
		await expect(fixture(transport).call("qorpera_read_company_path_v2", {}, abort.signal)).rejects.toThrow();
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		[401, "authority_unavailable"],
		[403, "authority_unavailable"],
		[412, "stale_version"],
		[400, "invalid_arguments"],
		[422, "invalid_arguments"],
		[503, "transport_unavailable"],
	] as const)("classifies HTTP %i without retaining diagnostic text", async (status, category) => {
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json({ message: "PRIVATE_PATH PRIVATE_CREDENTIAL" }, { status }),
		);
		const error = await fixture(transport)
			.call("qorpera_read_company_path_v2", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CloudRuntimeDiagnosticError);
		expect(error).toMatchObject({ category });
		expect(String(error)).toBe("Error: Company File authority unavailable");
		expect(JSON.stringify(error)).not.toMatch(/PRIVATE_PATH|PRIVATE_CREDENTIAL/);
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
