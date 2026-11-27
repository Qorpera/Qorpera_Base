import { randomUUID } from "node:crypto";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	CloudCompanyFolderError,
} from "@qorpera/runtime/cloud-company-folder-client";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import { NATIVE_HOST_CALLS, NativeHostDispatch } from "@qorpera/runtime/cloud-native-host-dispatch";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const ORIGIN = "https://project.supabase.example";
const PUBLISHABLE_KEY = "sb_publishable_numbersGates0123456789";
const LEASE_TOKEN = "L".repeat(43);

async function hostOf(answer: (body: Record<string, unknown>) => Response) {
	const sent: { url: string; body: Record<string, unknown> }[] = [];
	const dispatch = new NativeHostDispatch({
		supabaseUrl: ORIGIN,
		identity: { computeIdentityId: randomUUID(), credential: "I".repeat(43), publishableKey: PUBLISHABLE_KEY },
		fetch: async (input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			sent.push({ url: String(input), body });
			return answer(body);
		},
	});
	const { binding, authority } = nativeToolAuthorityFixture();
	dispatch.begin(binding.jobId, { leaseToken: LEASE_TOKEN, publishableKey: PUBLISHABLE_KEY });
	const control = new HttpCloudCompanyPathControl({
		supabaseUrl: ORIGIN,
		serviceRoleKey: PUBLISHABLE_KEY,
		fetch: dispatch.fetch,
	});
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const bytes: CloudCompanyFolderBytes = { put: vi.fn(), get: vi.fn(), range: vi.fn() };
	const folder = new CloudCompanyFolderClient({ binding, identity: run.identity, control, bytes });
	return { sent, folder, binding, run };
}

it("asks the platform's numbers through the real path control and the native host's entry point, as SQL needs it", async () => {
	const host = await hostOf(() =>
		Response.json({
			columns: ["day", "balance"],
			rows: [["2026-11-26", 41250.5]],
			more: false,
			asOf: "2026-11-26T11:00:00.000Z",
			etag: "0123456789abcdef0123456789abcdef",
		}),
	);
	const answer = await host.folder.companyNumbers("money-balance", { from: "2026-11-26" }, AbortSignal.timeout(5_000));
	expect(answer).toEqual({
		state: "answer",
		columns: ["day", "balance"],
		rows: [["2026-11-26", 41250.5]],
		more: false,
		asOf: "2026-11-26T11:00:00.000Z",
	});
	expect(NATIVE_HOST_CALLS.get("qorpera_run_company_numbers")).toBe("standard");
	expect(host.sent).toEqual([
		{
			url: `${ORIGIN}/rest/v1/rpc/qorpera_native_host_call`,
			body: {
				p_job_id: host.binding.jobId,
				p_job_lease_token: LEASE_TOKEN,
				p_name: "qorpera_run_company_numbers",
				p_args: {
					p_environment_id: host.run.identity.environmentId,
					p_actor: host.folder.actor,
					p_question: "money-balance",
					p_params: { from: "2026-11-26" },
				},
			},
		},
	]);
});

it("keeps SQL's refusal through both gates: a question the run may not read is refused, never a lost answer", async () => {
	const host = await hostOf(() =>
		Response.json(
			{ code: "P0002", message: "No question qorpera/money-now that you may read", details: null, hint: null },
			{ status: 404 },
		),
	);
	expect(await host.folder.companyNumbers("money-now", {}, AbortSignal.timeout(5_000))).toEqual({
		state: "refused",
		words: "No question qorpera/money-now that you may read",
	});
});

it("answers a source the company has not connected in SQL's words, while any other 55000 still says work is stopped", async () => {
	const words = "Not connected: orders count once card payments are connected or an order is added by hand";
	const unconnected = await hostOf(() =>
		Response.json({ code: "55000", message: words, details: null, hint: null }, { status: 400 }),
	);
	expect(await unconnected.folder.companyNumbers("orders-now", {}, AbortSignal.timeout(5_000))).toEqual({
		state: "not_connected",
		words,
	});
	const stopped = await hostOf(() =>
		Response.json({ code: "55000", message: "Company is being deleted", details: null, hint: null }, { status: 400 }),
	);
	const error = await stopped.folder.companyNumbers("orders-now", {}, AbortSignal.timeout(5_000)).catch((e) => e);
	expect(error).toBeInstanceOf(CloudCompanyFolderError);
	expect(error).toMatchObject({ failure: "stopped" });
});
