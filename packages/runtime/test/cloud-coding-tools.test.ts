import { randomUUID } from "node:crypto";
import type { CloudCodingWorker } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import { HttpCloudCodingControl } from "../src/cloud-coding-control.ts";
import { type CloudCodingControl, cloudCodingTools } from "../src/cloud-coding-tools.ts";
import { CloudNativeToolBoundary, type CloudToolContext } from "../src/cloud-native-tool-boundary.ts";

function fixture() {
	const { binding, authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const id = randomUUID();
	const worker: CloudCodingWorker = {
		schema: "qorpera.coding-worker/v1",
		id,
		companyId: identity.companyId,
		parentAgentId: identity.staffAgentId,
		parentRunId: identity.runId,
		repository: { host: "github.com", owner: "Qorpera", name: "test", baseBranch: "main" },
		branch: `qorpera/coding/${id}`,
		vmId: null,
		version: 1,
		state: "queued",
		turn: 1,
		pullRequest: null,
	};
	const dispatch = {
		operationKey: "build-one",
		repository: { ...worker.repository },
		goal: "Build feature",
		definitionOfDone: "Tests pass; draft PR ready",
		context: "Only bounded source context",
		sourceReadIds: [randomUUID()],
		todoPath: "projects/test/todos/build.json",
		cancellationPolicy: "retain-workspace",
		completionPolicy: "notify-parent",
		publication: "draft-pr",
	};
	const call = vi.fn<CloudCodingControl["call"]>().mockResolvedValue(worker);
	const tools = cloudCodingTools(binding, identity, { call });
	const boundary = new CloudNativeToolBoundary({
		companyId: identity.companyId,
		runId: identity.runId,
		identity,
		tools,
		assertActive: async () => undefined,
		signal: new AbortController().signal,
	});
	return { binding, identity, worker, dispatch, call, tools, boundary };
}

describe("coding worker native tools", () => {
	it("dispatches a bounded blank worker with host identity and fenced queued result", async () => {
		const f = fixture();
		try {
			const result = await f.boundary.invoke("dispatch", "qorpera", "dispatch_coding_worker", f.dispatch);
			expect(result.success).toBe(true);
			expect(f.call).toHaveBeenCalledWith(
				"qorpera_dispatch_coding_worker",
				{ p_binding: f.binding, p_dispatch: f.dispatch },
				expect.any(AbortSignal),
			);
			const envelope = JSON.parse(result.contentItems[0].text);
			expect(envelope.trust).toBe("untrusted_data");
			expect(JSON.parse(envelope.content.text)).toEqual(f.worker);
			expect(JSON.stringify(result)).not.toContain(f.binding.credentialCapsuleId);
			expect(await f.boundary.invoke("dispatch", "qorpera", "dispatch_coding_worker", f.dispatch)).toEqual(result);
			expect(f.call).toHaveBeenCalledTimes(1);
		} finally {
			f.boundary.close();
		}
	});
	it.each(["companyId", "vmId", "branch", "sponsorUserId", "binding", "credential"])(
		"rejects model-selected %s before the effect",
		async (field) => {
			const f = fixture();
			try {
				expect(
					(
						await f.boundary.invoke("bad", "qorpera", "dispatch_coding_worker", {
							...f.dispatch,
							[field]: randomUUID(),
						})
					).success,
				).toBe(false);
				expect(f.call).not.toHaveBeenCalled();
			} finally {
				f.boundary.close();
			}
		},
	);
	it("steers the same handle without allowing a replacement VM or branch", async () => {
		const f = fixture();
		try {
			const followup = { operationKey: "fix", workerId: f.worker.id, expectedVersion: 1, goal: "Fix test failure" };
			expect((await f.boundary.invoke("followup", "qorpera", "followup_coding_worker", followup)).success).toBe(
				true,
			);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_followup_coding_worker",
				{ p_binding: f.binding, p_followup: followup },
			]);
			expect(
				(await f.boundary.invoke("replace", "qorpera", "followup_coding_worker", { ...followup, branch: "new" }))
					.success,
			).toBe(false);
			expect(f.call).toHaveBeenCalledTimes(1);
		} finally {
			f.boundary.close();
		}
	});
	it.each(["id", "companyId", "parentAgentId"])("rejects another worker's %s", async (key) => {
		const f = fixture();
		f.call.mockResolvedValue({ ...f.worker, [key]: randomUUID() });
		try {
			expect(
				(await f.boundary.invoke("read", "qorpera", "read_coding_worker", { workerId: f.worker.id })).success,
			).toBe(false);
		} finally {
			f.boundary.close();
		}
	});
	it("does not silently retry an uncertain dispatch", async () => {
		const f = fixture();
		f.call.mockRejectedValue(new Error("canary-secret"));
		try {
			const result = await f.boundary.invoke("lost", "qorpera", "dispatch_coding_worker", f.dispatch);
			expect(result.success).toBe(false);
			expect(JSON.stringify(result)).not.toContain("canary-secret");
			await f.boundary.invoke("lost", "qorpera", "dispatch_coding_worker", f.dispatch);
			expect(f.call).toHaveBeenCalledTimes(1);
		} finally {
			f.boundary.close();
		}
	});
	it("requires exact native context even when invoked without the boundary", async () => {
		const f = fixture();
		const context: CloudToolContext = {
			companyId: f.identity.companyId,
			runId: f.identity.runId,
			callId: "direct",
			argumentSha256: "a".repeat(64),
			signal: new AbortController().signal,
			identity: { ...f.identity, sponsorUserId: randomUUID() },
		};
		try {
			await expect(f.tools[0].execute(f.tools[0].parseArguments(f.dispatch), context)).rejects.toThrow(
				"identity differs",
			);
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});
	it("cancellation is an addressed versioned request, never a delete", async () => {
		const f = fixture();
		try {
			const args = { workerId: f.worker.id, expectedVersion: 1, operationKey: "cancel" };
			expect((await f.boundary.invoke("cancel", "qorpera", "cancel_coding_worker", args)).success).toBe(true);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_cancel_coding_worker",
				{ p_binding: f.binding, p_worker_id: f.worker.id, p_expected_version: 1, p_operation_key: "cancel" },
			]);
		} finally {
			f.boundary.close();
		}
	});
});

describe("coding control transport", () => {
	it("keeps credentials at the approved HTTPS origin and refuses reflected errors without retry", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("canary-secret", { status: 403 }));
		const control = new HttpCloudCodingControl({
			supabaseUrl: "https://database.example",
			serviceRoleKey: "canary-secret",
			fetch: fetcher,
		});
		await expect(control.call("qorpera_read_coding_worker", {}, new AbortController().signal)).rejects.toThrow(
			"Coding operation unconfirmed",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0][0]).toBe("https://database.example/rest/v1/rpc/qorpera_read_coding_worker");
		expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", method: "POST" });
	});
	it.each([
		"http://database.example",
		"https://user:secret@database.example",
		"https://database.example/path",
		"https://database.example/?token=x",
	])("rejects ambiguous endpoint %s", (supabaseUrl) => {
		expect(() => new HttpCloudCodingControl({ supabaseUrl, serviceRoleKey: "secret" })).toThrow();
	});
});
