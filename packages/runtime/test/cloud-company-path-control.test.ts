import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { CloudCompanyHeadConflict } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CloudCompanyFolderRpcError,
	CloudCompanyPathRpcParentMissing,
	CloudCompanyPathRpcPrecondition,
	CloudCompanyPathRpcRefusal,
} from "@qorpera/runtime/cloud-company-path-refusal";
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
		[403, { code: "42501", message: "PRIVATE_DENIAL", details: null, hint: null }, true],
		[403, { code: "42501", message: "PRIVATE_DENIAL", details: "private", hint: "private" }, true],
		[403, { code: "42501", message: "PRIVATE_DENIAL" }, false],
		[403, { code: "42501", message: "PRIVATE_DENIAL", details: {}, hint: null }, false],
		[403, { code: "42501", message: "PRIVATE_DENIAL", details: null, hint: null, extra: true }, false],
		[403, { code: "OTHER", message: "PRIVATE_DENIAL", details: null, hint: null }, false],
		[500, { code: "42501", message: "PRIVATE_DENIAL", details: null, hint: null }, false],
	] as const)("brands only a complete transaction denial (%i, %j)", async (status, body, denied) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
		const error = await fixture(transport)
			.call("qorpera_read_company_path_v2", {}, new AbortController().signal)
			.catch((error) => error);
		expect(error instanceof CloudCompanyPathRpcRefusal).toBe(denied);
		expect(String(error)).not.toContain("PRIVATE_DENIAL");
		expect(transport).toHaveBeenCalledOnce();
	});

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
		"qorpera_read_company_path",
		"qorpera_list_company_paths",
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
		[409, { code: "QRC01", message: "storage is busy", details: null, hint: null }, false],
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

	it.each([
		[412, { code: "PT412", message: "Company File path version changed", details: null, hint: null }, true],
		[412, { code: "PT412", message: "PRIVATE_DIAGNOSTIC", details: "private", hint: "private" }, true],
		[412, { code: "PT412", message: "PRIVATE_DIAGNOSTIC" }, false],
		[412, { code: "PT412", message: "PRIVATE_DIAGNOSTIC", details: {}, hint: null }, false],
		[412, { code: "PT412", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null, extra: true }, false],
		[412, { code: "40001", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
		[409, { code: "PT412", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
		[500, { code: "PT412", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
	] as const)("brands only a complete request precondition refusal (%i, %j)", async (status, body, precondition) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
		const error = await fixture(transport)
			.call("qorpera_check_company_path_mutation", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error instanceof CloudCompanyPathRpcPrecondition).toBe(precondition);
		// Either way the diagnostic category stays what it was, and no database text leaks.
		if (status === 412) expect((error as CloudRuntimeDiagnosticError).category).toBe("stale_version");
		expect(String(error)).not.toContain("PRIVATE_DIAGNOSTIC");
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([
		[424, { code: "PT424", message: "Company File parent folder is missing", details: null, hint: null }, true],
		[424, { code: "PT424", message: "PRIVATE_DIAGNOSTIC", details: "private", hint: "private" }, true],
		[424, { code: "PT424", message: "PRIVATE_DIAGNOSTIC" }, false],
		[424, { code: "PT424", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null, extra: true }, false],
		[424, { code: "PT412", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
		[412, { code: "PT424", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
		[500, { code: "PT424", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
	] as const)("brands only a complete missing-folder refusal (%i, %j)", async (status, body, missing) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
		const error = await fixture(transport)
			.call("qorpera_check_company_path_mutation", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error instanceof CloudCompanyPathRpcParentMissing).toBe(missing);
		expect(error instanceof CloudCompanyPathRpcPrecondition).toBe(false);
		if (missing) expect((error as CloudRuntimeDiagnosticError).category).toBe("parent_missing");
		expect(String(error)).not.toContain("PRIVATE_DIAGNOSTIC");
		expect(transport).toHaveBeenCalledOnce();
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

describe("the folder core's entry points (core C3)", () => {
	const FOLDER = [
		"qorpera_folder_read",
		"qorpera_folder_list",
		"qorpera_folder_commit",
		"qorpera_folder_record_release",
	] as const;

	it.each(FOLDER)("permits %s over the fixed RPC route", async (method) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json({ schema: "fixture" }));
		await expect(fixture(transport).call(method, { p_path: "a" }, new AbortController().signal)).resolves.toEqual({
			schema: "fixture",
		});
		expect(transport).toHaveBeenCalledWith(`https://authority.example/rest/v1/rpc/${method}`, expect.anything());
	});

	it.each([
		// The commit's authority check, raised through PostgREST with its own status and code.
		[409, "QRC01", "Company folder authority changed", "folder_authority_changed"],
		[500, "55000", "Company execution is paused", null],
		[403, "42501", "Run is unavailable", null],
		[403, "42501", "A read is no longer readable", null],
		[500, "40P01", "deadlock detected", "PRIVATE_PROCESS_DETAIL"],
		[409, "23505", "duplicate key value violates unique constraint", "PRIVATE_KEY_DETAIL"],
		[400, "22023", "Change set unit 1 is invalid", null],
	] as const)("keeps a folder error's code and message (%i %s)", async (status, code, message, details) => {
		for (const method of FOLDER) {
			const transport = vi.fn<typeof fetch>(async () =>
				Response.json({ code, message, details, hint: null }, { status }),
			);
			const error = await fixture(transport)
				.call(method, {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(CloudCompanyFolderRpcError);
			expect(error).toMatchObject({ code, detail: message });
			// The SQL's words stay out of the error's text; only the folder client reads them.
			expect(String(error)).not.toContain(message);
		}
	});

	it("keeps today's mapping for every other RPC, and brands no incomplete folder error", async () => {
		const denial = { code: "42501", message: "Run is unavailable", details: null, hint: null };
		const other = await fixture(vi.fn<typeof fetch>(async () => Response.json(denial, { status: 403 })))
			.call("qorpera_read_company_path_v2", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(other).toBeInstanceOf(CloudCompanyPathRpcRefusal);
		for (const body of [
			{ code: "55000", message: "Company execution is paused" },
			{ code: "55000", message: "Company execution is paused", details: null, hint: null, extra: 1 },
			{ code: 55000, message: "Company execution is paused", details: null, hint: null },
			{ code: "5500", message: "Company execution is paused", details: null, hint: null },
		]) {
			const error = await fixture(vi.fn<typeof fetch>(async () => Response.json(body, { status: 500 })))
				.call("qorpera_folder_commit", {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).not.toBeInstanceOf(CloudCompanyFolderRpcError);
			expect(error).toBeInstanceOf(CloudRuntimeDiagnosticError);
		}
	});
});
