import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpCloudCompanyPathControl } from "../src/cloud-company-path-control.ts";
import { CloudCompanyHeadConflict } from "../src/cloud-company-path-gateway.ts";

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
		"qorpera_read_company_path_candidates",
		"qorpera_list_company_path_candidates",
		"qorpera_retain_company_path_sources",
		"qorpera_verify_company_knowledge_file",
		"qorpera_record_company_skill_load",
		"qorpera_assert_company_skill_load",
	] as const)("allows the explicit host preparation RPC %s", async (method) => {
		const transport = vi.fn<typeof fetch>(async () => Response.json(null));
		await fixture(transport).call(method, { p_paths: [] }, new AbortController().signal);
		expect(transport).toHaveBeenCalledWith(
			`https://authority.example/rest/v1/rpc/${method}`,
			expect.objectContaining({ method: "POST", redirect: "error" }),
		);
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
				.call("qorpera_read_company_path", {}, new AbortController().signal)
				.catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(CloudCompanyHeadConflict);
		}
	});

	it("does not call the service when already cancelled", async () => {
		const transport = vi.fn<typeof fetch>();
		const abort = new AbortController();
		abort.abort();
		await expect(fixture(transport).call("qorpera_read_company_path", {}, abort.signal)).rejects.toThrow();
		expect(transport).not.toHaveBeenCalled();
	});
});
