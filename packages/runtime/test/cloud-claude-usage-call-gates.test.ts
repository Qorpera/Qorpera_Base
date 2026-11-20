import { randomUUID } from "node:crypto";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { NATIVE_HOST_CALLS, NativeHostDispatch } from "@qorpera/runtime/cloud-native-host-dispatch";
import { expect, it } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const ORIGIN = "https://project.supabase.example";
const PUBLISHABLE_KEY = "sb_publishable_claudeUsage0123456789";
const LEASE_TOKEN = "L".repeat(43);

it("records a Claude Code run's usage through the path control and the native host's entry point, as SQL takes it", async () => {
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const dispatch = new NativeHostDispatch({
		supabaseUrl: ORIGIN,
		identity: { computeIdentityId: randomUUID(), credential: "I".repeat(43), publishableKey: PUBLISHABLE_KEY },
		fetch: async (input, init) => {
			sent.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return Response.json({ schema: "qorpera.claude-run-usage/v1", recorded: true });
		},
	});
	const { binding } = nativeToolAuthorityFixture();
	dispatch.begin(binding.jobId, { leaseToken: LEASE_TOKEN, publishableKey: PUBLISHABLE_KEY });
	const paths = new HttpCloudCompanyPathControl({
		supabaseUrl: ORIGIN,
		serviceRoleKey: PUBLISHABLE_KEY,
		fetch: dispatch.fetch,
	});
	const usage = {
		observedAt: "2026-11-17T11:00:00.000Z",
		windows: [{ id: "seven_day", label: "Weekly", usedPercent: 28, resetAt: "2026-11-21T13:00:00.000Z" }],
	};
	expect(
		await paths.call(
			"qorpera_record_claude_run_usage",
			{ p_binding: binding, p_usage: usage },
			AbortSignal.timeout(5_000),
		),
	).toEqual({ schema: "qorpera.claude-run-usage/v1", recorded: true });
	expect(NATIVE_HOST_CALLS.get("qorpera_record_claude_run_usage")).toBe("standard");
	expect(sent).toEqual([
		{
			url: `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
			body: {
				p_job_id: binding.jobId,
				p_job_lease_token: LEASE_TOKEN,
				p_name: "qorpera_record_claude_run_usage",
				p_args: { p_binding: binding, p_usage: usage },
			},
		},
	]);
});
