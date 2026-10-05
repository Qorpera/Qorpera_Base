import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { SupabaseNativeProviderControlPlane } from "@qorpera/runtime/cloud-native-provider-service";
import { type CloudNativeToolBinding, CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { afterEach, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("calls the service-only authority RPC with a closed host binding", async () => {
	const { binding, authority } = nativeToolAuthorityFixture();
	const request = vi.fn<typeof fetch>(async () => Response.json(authority));
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	const run = await CloudNativeToolRun.open(binding, control, new AbortController().signal);
	runs.push(run);
	expect(request).toHaveBeenCalledTimes(1);
	const [url, init] = request.mock.calls[0];
	expect(String(url)).toBe("https://cloud.example.test/rest/v1/rpc/qorpera_describe_native_tool_authority");
	expect(init).toMatchObject({
		method: "POST",
		redirect: "error",
		headers: { apikey: "SYNTHETIC_SERVICE_KEY", "content-type": "application/json" },
	});
	expect(JSON.parse(String(init?.body))).toEqual({ p_binding: binding });
	expect(run.identity).toEqual(authority.identity);
	expect(JSON.stringify(run.identity)).not.toContain("SYNTHETIC_SERVICE_KEY");
});

it("asks again when an authority answer's connection ends mid-body, and keeps the run (control calls)", async () => {
	const { binding, authority } = nativeToolAuthorityFixture();
	let calls = 0;
	const request = vi.fn<typeof fetch>(async () => {
		calls += 1;
		if (calls > 1) return Response.json(authority);
		// HTTP 200, then the connection resets before the body ends.
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"schema":'));
					controller.error(new TypeError("terminated"));
				},
			}),
		);
	});
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	const run = await CloudNativeToolRun.open(binding, control, new AbortController().signal);
	runs.push(run);
	expect(request).toHaveBeenCalledTimes(2);
	expect(run.identity).toEqual(authority.identity);
	// A malformed but complete answer is no lost answer: it is not asked again.
	request.mockImplementationOnce(async () => new Response("{not json"));
	await expect(run.assertActive(run.signal)).rejects.toThrow("Cloud tool authority unavailable");
	expect(request).toHaveBeenCalledTimes(3);
});

it("does not send a model-supplied authority field to the control plane", async () => {
	const { binding } = nativeToolAuthorityFixture();
	const request = vi.fn<typeof fetch>();
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	await expect(
		control.describeToolAuthority(
			{ ...binding, approved: true } as CloudNativeToolBinding,
			new AbortController().signal,
		),
	).rejects.toThrow("Invalid cloud tool binding");
	expect(request).not.toHaveBeenCalled();
});

it("uses the existing receipt contract without exposing runner or session tokens", async () => {
	const { binding } = nativeToolAuthorityFixture();
	const request = vi.fn<typeof fetch>(async () => Response.json({}));
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	const receiptId = randomUUID();
	const inputSha256 = "a".repeat(64);
	await control.beginToolOperation(
		binding,
		{
			receiptId,
			logicalOperationKey: "read_document:item-1",
			operationKind: "cloud_tool",
			inputSha256,
			downstreamIdempotencyKey: "logical-attempt",
			requiresCompanyRevision: false,
		},
		new AbortController().signal,
	);
	await control.completeToolOperation(
		binding,
		{ receiptId, inputSha256, result: { ok: true } },
		new AbortController().signal,
	);
	expect(String(request.mock.calls[0][0])).toMatch(/\/qorpera_begin_native_tool_operation$/);
	expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
		p_binding: binding,
		p_receipt_id: receiptId,
		p_logical_operation_key: "read_document:item-1",
		p_input_sha256: inputSha256,
		p_downstream_idempotency_sha256: createHash("sha256").update("logical-attempt").digest("hex"),
		p_requires_company_revision: false,
	});
	expect(String(request.mock.calls[1][0])).toMatch(/\/qorpera_complete_native_tool_operation$/);
	expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toEqual({
		p_binding: binding,
		p_receipt_id: receiptId,
		p_input_sha256: inputSha256,
		p_result: { ok: true },
		p_output_snapshot_id: null,
		p_proposal_id: null,
	});
	expect(String(request.mock.calls.map((entry) => entry[1]?.body))).not.toMatch(/lease_token|session_token/);
});

it("completes a folder writer's receipt with its commit through the folder core's completion", async () => {
	const { binding } = nativeToolAuthorityFixture();
	const request = vi.fn<typeof fetch>(async () => Response.json({}));
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	const receiptId = randomUUID();
	const folderCommitId = randomUUID();
	await control.completeFolderToolOperation(
		binding,
		{ receiptId, inputSha256: "b".repeat(64), result: { saved: true }, folderCommitId },
		new AbortController().signal,
	);
	expect(String(request.mock.calls[0][0])).toBe(
		"https://cloud.example.test/rest/v1/rpc/qorpera_folder_complete_run_receipt",
	);
	expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
		p_binding: binding,
		p_receipt_id: receiptId,
		p_input_sha256: "b".repeat(64),
		p_result: { saved: true },
		p_folder_commit_id: folderCommitId,
	});
});

it.each([403, 500, 503])("does not read or echo a stalled %s error body", async (status) => {
	const { binding } = nativeToolAuthorityFixture();
	const cancel = vi.fn();
	const request = vi.fn<typeof fetch>(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("PRIVATE_ERROR_BODY"));
					},
					cancel,
				}),
				{ status },
			),
	);
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	await expect(control.describeToolAuthority(binding, new AbortController().signal)).rejects.toThrow(
		`Native control-plane RPC failed (${status})`,
	);
	expect(cancel).toHaveBeenCalledTimes(1);
});

it("bounds an uncooperative success-body read and cancels the stream", async () => {
	vi.useFakeTimers();
	const { binding } = nativeToolAuthorityFixture();
	const cancel = vi.fn();
	const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })));
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	// A late answer is asked again within the authority window (control calls, 4 Oct 2026): five attempts of 5 s, each
	// cancelled. Both clocks move together.
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const rejected = expect(CloudNativeToolRun.open(binding, control, new AbortController().signal)).rejects.toThrow(
		"Cloud tool authority unavailable",
	);
	for (let step = 0; step < 130; step += 1) {
		now += 250;
		await vi.advanceTimersByTimeAsync(250);
	}
	await rejected;
	expect(cancel).toHaveBeenCalledTimes(5);
	expect(request).toHaveBeenCalledTimes(5);
	expect(vi.getTimerCount()).toBe(0);
});

it("rejects oversized authority before JSON parsing and cancels the body", async () => {
	const { binding } = nativeToolAuthorityFixture();
	const cancel = vi.fn();
	const request = vi.fn<typeof fetch>(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(256 * 1024 + 1));
					},
					cancel,
				}),
			),
	);
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	await expect(control.describeToolAuthority(binding, new AbortController().signal)).rejects.toThrow("byte limit");
	expect(cancel).toHaveBeenCalledTimes(1);
});

it("rejects malformed authority JSON without exposing its content", async () => {
	const { binding } = nativeToolAuthorityFixture();
	const request = vi.fn<typeof fetch>(async () => new Response("PRIVATE_INVALID_JSON"));
	const control = new SupabaseNativeProviderControlPlane(
		"https://cloud.example.test",
		"SYNTHETIC_SERVICE_KEY",
		request,
	);
	await expect(CloudNativeToolRun.open(binding, control, new AbortController().signal)).rejects.toThrow(
		"Cloud tool authority unavailable",
	);
});
