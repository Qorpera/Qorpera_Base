import { randomUUID } from "node:crypto";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { NATIVE_HOST_CALLS, NativeHostDispatch } from "@qorpera/runtime/cloud-native-host-dispatch";
import { expect, it } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const ORIGIN = "https://project.supabase.example";
const PUBLISHABLE_KEY = "sb_publishable_geminiUsage0123456789";
const LEASE_TOKEN = "L".repeat(43);

it("forwards Gemini run usage and cap notices through path control and native host dispatch", async () => {
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const dispatch = new NativeHostDispatch({
		supabaseUrl: ORIGIN,
		identity: { computeIdentityId: randomUUID(), credential: "I".repeat(43), publishableKey: PUBLISHABLE_KEY },
		fetch: async (input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sent.push({ url: String(input), body });
			if (body.p_name === "qorpera_record_gemini_run_usage") {
				return Response.json({
					schema: "qorpera.gemini-run-usage/v1",
					spendMonth: "2026-11",
					monthSpendMicrodollars: 500_000,
					monthlyCapCents: 10_000,
					capReached: false,
				});
			}
			if (body.p_name === "qorpera_record_gemini_key_error") {
				return Response.json({ schema: "qorpera.gemini-key-error-notice/v1", recorded: true });
			}
			return Response.json({ schema: "qorpera.gemini-cap-notice/v1", recorded: true });
		},
	});
	const { binding } = nativeToolAuthorityFixture();
	dispatch.begin(binding.jobId, { leaseToken: LEASE_TOKEN, publishableKey: PUBLISHABLE_KEY });
	const paths = new HttpCloudCompanyPathControl({
		supabaseUrl: ORIGIN,
		serviceRoleKey: PUBLISHABLE_KEY,
		fetch: dispatch.fetch,
	});
	const usage = { inputTokens: 100_000, cachedTokens: 50_000, outputTokens: 10_000 };

	expect(
		await paths.call(
			"qorpera_record_gemini_run_usage",
			{ p_binding: binding, p_usage: usage },
			AbortSignal.timeout(5_000),
		),
	).toEqual({
		schema: "qorpera.gemini-run-usage/v1",
		spendMonth: "2026-11",
		monthSpendMicrodollars: 500_000,
		monthlyCapCents: 10_000,
		capReached: false,
	});
	expect(
		await paths.call("qorpera_record_gemini_cap_reached", { p_binding: binding }, AbortSignal.timeout(5_000)),
	).toEqual({
		schema: "qorpera.gemini-cap-notice/v1",
		recorded: true,
	});
	expect(
		await paths.call(
			"qorpera_record_gemini_key_error",
			{ p_binding: binding, p_error_code: "billing_required" },
			AbortSignal.timeout(5_000),
		),
	).toEqual({
		schema: "qorpera.gemini-key-error-notice/v1",
		recorded: true,
	});

	expect(NATIVE_HOST_CALLS.get("qorpera_record_gemini_run_usage")).toBe("standard");
	expect(NATIVE_HOST_CALLS.get("qorpera_record_gemini_cap_reached")).toBe("standard");
	expect(NATIVE_HOST_CALLS.get("qorpera_record_gemini_key_error")).toBe("standard");
	expect(sent).toEqual([
		{
			url: `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
			body: {
				p_job_id: binding.jobId,
				p_job_lease_token: LEASE_TOKEN,
				p_name: "qorpera_record_gemini_run_usage",
				p_args: { p_binding: binding, p_usage: usage },
			},
		},
		{
			url: `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
			body: {
				p_job_id: binding.jobId,
				p_job_lease_token: LEASE_TOKEN,
				p_name: "qorpera_record_gemini_cap_reached",
				p_args: { p_binding: binding },
			},
		},
		{
			url: `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
			body: {
				p_job_id: binding.jobId,
				p_job_lease_token: LEASE_TOKEN,
				p_name: "qorpera_record_gemini_key_error",
				p_args: { p_binding: binding, p_error_code: "billing_required" },
			},
		},
	]);
});
