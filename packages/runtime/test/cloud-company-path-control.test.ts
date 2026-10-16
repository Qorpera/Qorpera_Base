import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { CloudCompanyHeadConflict } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CloudCompanyFolderRpcError,
	CloudCompanyPathRpcMissing,
	CloudCompanyPathRpcParentMissing,
	CloudCompanyPathRpcPrecondition,
	CloudCompanyPathRpcRefusal,
} from "@qorpera/runtime/cloud-company-path-refusal";
import { CloudControlRpcRefused, cloudControlRetryable } from "@qorpera/runtime/cloud-control-errors";
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
		// A request on the publishable key: PostgREST answers 42501 with 401 (G2-2, qorpera_native_host_call).
		[401, { code: "42501", message: "PRIVATE_DENIAL", details: null, hint: null }, true],
		[401, { code: "OTHER", message: "PRIVATE_DENIAL", details: null, hint: null }, false],
		[500, { code: "42501", message: "PRIVATE_DENIAL", details: null, hint: null }, false],
	] as const)("brands only a complete transaction denial (%i, %j)", async (status, body, denied) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
		const error = await fixture(transport)
			.call("qorpera_find_agent_mail", {}, new AbortController().signal)
			.catch((error) => error);
		expect(error instanceof CloudCompanyPathRpcRefusal).toBe(denied);
		expect(String(error)).not.toContain("PRIVATE_DENIAL");
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([
		"qorpera_assert_company_path_reads",
		"qorpera_assert_native_connector_operation",
		"qorpera_native_presence_forget",
	] as const)("accepts PostgREST no-content success for the void RPC %s", async (method) => {
		const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		await expect(fixture(transport).call(method, {}, new AbortController().signal)).resolves.toBeNull();
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([
		"qorpera_record_runtime_observation_batch",
		"qorpera_begin_native_company_execution_v2",
		"qorpera_begin_native_company_execution_v3",
		"qorpera_bind_native_company_context",
		"qorpera_memory_events_run",
		"qorpera_memory_compaction_record",
		"qorpera_describe_company_run_context",
		"qorpera_read_company_run_context",
		"qorpera_record_native_context_view",
		"qorpera_fence_native_context",
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
			.call("qorpera_find_agent_mail", {}, new AbortController().signal)
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
			.call("qorpera_find_agent_mail", {}, new AbortController().signal)
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
			.call("qorpera_find_agent_mail", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error instanceof CloudCompanyPathRpcParentMissing).toBe(missing);
		expect(error instanceof CloudCompanyPathRpcPrecondition).toBe(false);
		if (missing) expect((error as CloudRuntimeDiagnosticError).category).toBe("parent_missing");
		expect(String(error)).not.toContain("PRIVATE_DIAGNOSTIC");
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each([
		[
			404,
			{ code: "PGRST202", message: "Could not find the function", details: "PRIVATE_DIAGNOSTIC", hint: null },
			true,
		],
		[404, { code: "PGRST202", message: "PRIVATE_DIAGNOSTIC" }, false],
		[404, { code: "PGRST116", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
		[400, { code: "PGRST202", message: "PRIVATE_DIAGNOSTIC", details: null, hint: null }, false],
	] as const)("brands only a complete missing-function answer (%i, %j)", async (status, body, missing) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
		const error = await fixture(transport)
			.call("qorpera_fence_native_context", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error instanceof CloudCompanyPathRpcMissing).toBe(missing);
		expect(String(error)).not.toContain("PRIVATE_DIAGNOSTIC");
		expect(transport).toHaveBeenCalledOnce();
	});

	it("brands a missing function only for the one-call fence", async () => {
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json(
				{ code: "PGRST202", message: "Could not find the function", details: null, hint: null },
				{ status: 404 },
			),
		);
		const error = await fixture(transport)
			.call("qorpera_assert_company_path_reads", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error instanceof CloudCompanyPathRpcMissing).toBe(false);
		expect((error as CloudRuntimeDiagnosticError).category).toBe("transport_unavailable");
	});

	it.each([200, 403])("bounds stalled success and denial bodies (%i) and cancels the reader", async (status) => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const transport = vi.fn<typeof fetch>(
			async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status }),
		);
		const result = fixture(transport).call("qorpera_describe_agent_open_work", {}, new AbortController().signal);
		const rejected = expect(result).rejects.toThrow("unavailable");
		await vi.advanceTimersByTimeAsync(3001);
		await rejected;
		expect(cancel).toHaveBeenCalled();
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("bounds an uncooperative fetch and never retries an uncertain write", async () => {
		vi.useFakeTimers();
		const transport = vi.fn<typeof fetch>(async () => new Promise<Response>(() => undefined));
		const result = fixture(transport).call("qorpera_send_agent_mail", {}, new AbortController().signal);
		const rejected = expect(result).rejects.toThrow("unavailable");
		await vi.advanceTimersByTimeAsync(3001);
		await rejected;
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("leaves the one-call fence's attempt to the run's retry, where every other call stops at 3 s (6 Oct 2026)", async () => {
		vi.useFakeTimers();
		let answer: (response: Response) => void = () => undefined;
		const transport = vi.fn<typeof fetch>(async (input) =>
			String(input).endsWith("/qorpera_fence_native_context")
				? new Promise<Response>((resolve) => {
						answer = resolve;
					})
				: new Promise<Response>(() => undefined),
		);
		const control = fixture(transport);
		const fenced = control.call("qorpera_fence_native_context", {}, new AbortController().signal);
		const read = control.call("qorpera_assert_company_path_reads", {}, new AbortController().signal);
		const readRejected = expect(read).rejects.toThrow("unavailable");
		// The run cuts the fence's attempt at 10 s at first and gives the next twice as long: 12 s here is not a cut.
		await vi.advanceTimersByTimeAsync(12_000);
		await readRejected;
		vi.useRealTimers();
		answer(Response.json({ kept: [] }));
		await expect(fenced).resolves.toEqual({ kept: [] });
	});

	it("bounds responses and never interprets malformed errors as permission to retry", async () => {
		for (const response of [
			new Response("bad JSON", { status: 409 }),
			new Response(`"${"x".repeat(5000)}"`, { status: 409 }),
			Response.json({ body: "x".repeat(300000) }),
		]) {
			const error = await fixture(async () => response)
				.call("qorpera_find_agent_mail", {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(CloudCompanyHeadConflict);
		}
	});

	it.each([
		[500, "55000", "Company execution is paused", "authority_unavailable"],
		[501, "0A000", "Coding workers come to the company folder with coding machines", "authority_unavailable"],
		[400, "P0001", "That todo is closed", "authority_unavailable"],
		[409, "QRC01", "Company folder view changed", "authority_unavailable"],
		[400, "22023", "Worker request is invalid", "invalid_arguments"],
	] as const)(
		"keeps a refusal the database raised as a refusal, never a lost connection (%i %s)",
		async (status, code, message, category) => {
			const transport = vi.fn<typeof fetch>(async () =>
				Response.json({ code, message, details: null, hint: null }, { status }),
			);
			const error = await fixture(transport)
				.call("qorpera_send_agent_mail", {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(CloudControlRpcRefused);
			expect((error as CloudControlRpcRefused).code).toBe(code);
			expect((error as CloudControlRpcRefused).detail).toBe(message);
			expect((error as CloudControlRpcRefused).category).toBe(category);
			expect(String(error)).not.toContain(message);
			expect(cloudControlRetryable(error)).toBe(false);
			expect(transport).toHaveBeenCalledOnce();
		},
	);

	it.each([
		[500, { code: "40001", message: "could not serialize access", details: null, hint: null }],
		[500, { code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null }],
		[503, { code: "PGRST001", message: "Could not connect", details: null, hint: null }],
		[502, "<html>bad gateway</html>"],
	] as const)("reads a lost or late answer as transient (%i)", async (status, body) => {
		const transport = vi.fn<typeof fetch>(async () =>
			typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }),
		);
		const error = await fixture(transport)
			.call("qorpera_send_agent_mail", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error).not.toBeInstanceOf(CloudControlRpcRefused);
		expect(cloudControlRetryable(error)).toBe(true);
	});

	it("does not call the service when already cancelled", async () => {
		const transport = vi.fn<typeof fetch>();
		const abort = new AbortController();
		abort.abort();
		await expect(fixture(transport).call("qorpera_find_agent_mail", {}, abort.signal)).rejects.toThrow();
		expect(transport).not.toHaveBeenCalled();
	});

	// A lock wait that ran out of its budget (20260928339380): PostgREST returns SQLSTATE 55P03 as HTTP 500.
	it.each([
		"qorpera_describe_company_run_context",
		"qorpera_assert_company_path_reads",
		"qorpera_find_agent_mail",
	] as const)("treats a lock timeout on %s as unavailable, never a refusal or a head conflict", async (method) => {
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json(
				{ code: "55P03", message: "canceling statement due to lock timeout", details: null, hint: null },
				{ status: 500 },
			),
		);
		const error = await fixture(transport)
			.call(method, {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CloudRuntimeDiagnosticError);
		expect(error).toMatchObject({ category: "transport_unavailable" });
		expect(error).not.toBeInstanceOf(CloudCompanyPathRpcRefusal);
		expect(error).not.toBeInstanceOf(CloudCompanyHeadConflict);
		expect(transport).toHaveBeenCalledTimes(1);
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
			.call("qorpera_find_agent_mail", {}, new AbortController().signal)
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
		"qorpera_folder_run_view_open",
		"qorpera_folder_open_upload",
		"qorpera_folder_seal_upload",
		"qorpera_folder_renew_upload",
		"qorpera_folder_agent_todos",
		"qorpera_folder_record_review",
		"qorpera_folder_agent_routines",
		"qorpera_prepare_routine_login",
		"qorpera_folder_worker_commit",
		"qorpera_folder_agent_workers",
		"qorpera_folder_cancel_agent_worker",
		"qorpera_folder_agent_proposals",
		"qorpera_folder_apply_proposal",
		"qorpera_folder_close_proposal",
		"qorpera_folder_archive_coding_worker",
		"qorpera_folder_manage_hook",
		"qorpera_folder_note_interface_changes",
	] as const;

	it("reads a page of proposals and a proposal's apply up to 16 MiB, where a proposal's close stops at 256 KiB", async () => {
		const answer = { schema: "fixture", proposals: ["x".repeat(2 * 1024 * 1024)] };
		const transport = vi.fn<typeof fetch>(async () => Response.json(answer));
		for (const method of ["qorpera_folder_agent_proposals", "qorpera_folder_apply_proposal"] as const) {
			await expect(fixture(transport).call(method, {}, new AbortController().signal)).resolves.toEqual(answer);
		}
		await expect(
			fixture(transport).call("qorpera_folder_close_proposal", {}, new AbortController().signal),
		).rejects.toThrow("Company File control response too large");
		const over = vi.fn<typeof fetch>(async () => Response.json({ proposals: ["x".repeat(16 * 1024 * 1024)] }));
		await expect(
			fixture(over).call("qorpera_folder_agent_proposals", {}, new AbortController().signal),
		).rejects.toThrow("Company File control response too large");
	});

	it("reads one routine whole, up to a megabyte, where other folder reads stop at 256 KiB", async () => {
		const answer = { schema: "fixture", routines: ["x".repeat(300 * 1024)] };
		const transport = vi.fn<typeof fetch>(async () => Response.json(answer));
		await expect(
			fixture(transport).call("qorpera_folder_agent_routines", {}, new AbortController().signal),
		).resolves.toEqual(answer);
		await expect(
			fixture(transport).call("qorpera_folder_agent_todos", {}, new AbortController().signal),
		).rejects.toThrow("Company File control response too large");
		const over = vi.fn<typeof fetch>(async () => Response.json({ routines: ["x".repeat(1024 * 1024)] }));
		await expect(
			fixture(over).call("qorpera_folder_agent_routines", {}, new AbortController().signal),
		).rejects.toThrow("Company File control response too large");
	});

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
			.call("qorpera_find_agent_mail", {}, new AbortController().signal)
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

	it("brands PostgREST's own codes as requests nothing ran, and reads an unreadable 5xx as a lost answer", async () => {
		const missing = await fixture(
			vi.fn<typeof fetch>(async () =>
				Response.json(
					{ code: "PGRST202", message: "Could not find the function", details: "PRIVATE", hint: null },
					{ status: 404 },
				),
			),
		)
			.call("qorpera_folder_commit", {}, new AbortController().signal)
			.catch((error: unknown) => error);
		expect(missing).toBeInstanceOf(CloudCompanyFolderRpcError);
		expect(missing).toMatchObject({ code: "PGRST202", category: "invalid_arguments" });
		const page = "<html><body>504 Gateway Time-out</body></html>";
		// PostgREST's connection errors are lost answers, not requests it refused; its service-key errors are authority.
		for (const [status, code, category] of [
			[503, "PGRST000", "transport_unavailable"],
			[503, "PGRST001", "transport_unavailable"],
			[504, "PGRST003", "transport_unavailable"],
			[401, "PGRST301", "authority_unavailable"],
		] as const) {
			const error = await fixture(
				vi.fn<typeof fetch>(async () =>
					Response.json({ code, message: "x", details: null, hint: null }, { status }),
				),
			)
				.call("qorpera_folder_commit", {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toMatchObject({ category });
			expect(error instanceof CloudCompanyFolderRpcError).toBe(code === "PGRST301");
		}
		for (const [status, body, method, category] of [
			[500, page, "qorpera_folder_list", "transport_unavailable"],
			[504, page, "qorpera_folder_commit", "transport_unavailable"],
			[502, "x".repeat(5000), "qorpera_folder_record_release", "transport_unavailable"],
			// Any call's unreadable 5xx is a lost answer (control calls, 4 Oct 2026); only checks of a run ask again.
			[504, page, "qorpera_find_agent_mail", "transport_unavailable"],
			[400, page, "qorpera_folder_commit", "invalid_response"],
		] as const) {
			const error = await fixture(vi.fn<typeof fetch>(async () => new Response(body, { status })))
				.call(method, {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toMatchObject({ category });
			expect(error).not.toBeInstanceOf(CloudCompanyFolderRpcError);
		}
	});

	it("gives a listing page and a change set's outcomes room, and nothing else", async () => {
		const sized = (bytes: number) => ({ padding: "x".repeat(bytes) });
		for (const [method, bytes, fits] of [
			["qorpera_folder_list", 8_000_000, true],
			["qorpera_folder_list", 8_500_000, false],
			["qorpera_folder_commit", 3_000_000, true],
			["qorpera_folder_read", 300_000, false],
			["qorpera_folder_record_release", 300_000, false],
			["qorpera_find_agent_mail", 300_000, false],
		] as const) {
			const result = await fixture(vi.fn<typeof fetch>(async () => Response.json(sized(bytes))))
				.call(method, {}, new AbortController().signal)
				.then(
					() => true,
					(error: unknown) => {
						expect(error).toMatchObject({ category: "invalid_response" });
						return false;
					},
				);
			expect([method, bytes, result]).toEqual([method, bytes, fits]);
		}
	});

	it("reads a listing page of 200 links with the longest paths and targets escaped at worst", async () => {
		const entries = Array.from({ length: 200 }, (_, index) => ({
			path: `${String(index).padStart(3, "0")}${'"'.repeat(4093)}`,
			kind: "symlink",
			receipt: "x".repeat(550),
			target: "\u0001".repeat(4095),
		}));
		const answer = { schema: "fixture", entries, next: entries.at(-1)!.path };
		expect(Buffer.byteLength(JSON.stringify(answer))).toBeGreaterThan(6_500_000);
		const transport = vi.fn<typeof fetch>(async () => Response.json(answer));
		await expect(fixture(transport).call("qorpera_folder_list", {}, new AbortController().signal)).resolves.toEqual(
			answer,
		);
	});
});
