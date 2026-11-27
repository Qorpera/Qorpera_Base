import { describe, expect, it, vi } from "vitest";
import { createOpsActionExecutor } from "../src/ops-action-executor.ts";
import type { ClaimedSurfaceMergeJob } from "../src/surface-worker-loop.ts";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const SURFACE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const CHANGE_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_TOKEN = "55555555-5555-4555-8555-555555555555";

function makeOpsJob(patchManifest: Record<string, unknown> | null): ClaimedSurfaceMergeJob {
	return {
		jobId: JOB_ID,
		kind: "land_change",
		surfaceId: SURFACE_ID,
		profileId: PROFILE_ID,
		sessionId: null,
		leaseToken: LEASE_TOKEN,
		sourceKind: "native_ops",
		repositoryKey: null,
		folderRoot: null,
		payload: {},
		approvedChanges: [
			{
				changeId: CHANGE_ID,
				kind: "ops_action",
				parentSha: null,
				headSha: null,
				title: "Ops change",
				summary: "Run approved ops action",
				patchManifest,
				affectedPaths: [],
			},
		],
	};
}

describe("createOpsActionExecutor", () => {
	it("succeeds on noop without calling control plane", async () => {
		const executeSurfaceOpsAction = vi.fn();
		const executor = createOpsActionExecutor({ controlPlane: { executeSurfaceOpsAction } });
		const result = await executor(makeOpsJob({ actionKind: "noop" }), new AbortController().signal);
		expect(result).toEqual({ status: "landed" });
		expect(executeSurfaceOpsAction).not.toHaveBeenCalled();
	});

	it("dispatches mail actions to controlPlane.executeSurfaceOpsAction", async () => {
		const executeSurfaceOpsAction = vi.fn().mockResolvedValue({
			status: "landed",
			replayed: false,
			actionKind: "mail.archive",
			receipt: { updatedCount: 1 },
		});
		const executor = createOpsActionExecutor({ controlPlane: { executeSurfaceOpsAction } });
		const result = await executor(
			makeOpsJob({
				actionKind: "mail.archive",
				actionPayload: { threadIds: ["t".repeat(43)] },
			}),
			new AbortController().signal,
		);
		expect(result).toEqual({ status: "landed" });
		expect(executeSurfaceOpsAction).toHaveBeenCalledTimes(1);
		expect(executeSurfaceOpsAction.mock.calls[0]?.[0]).toEqual({
			profileId: PROFILE_ID,
			jobId: JOB_ID,
			changeId: CHANGE_ID,
			leaseToken: LEASE_TOKEN,
		});
	});

	it("executes safe file.write and file.delete through folder port and blocks protected system paths", async () => {
		const writeFile = vi.fn().mockResolvedValue(undefined);
		const deleteFile = vi.fn().mockResolvedValue(undefined);
		const executor = createOpsActionExecutor({
			controlPlane: {},
			folder: {
				readFiles: vi.fn(),
				writeFile,
				deleteFile,
			},
		});

		const written = await executor(
			makeOpsJob({
				actionKind: "file.write",
				actionPayload: { path: "notes/summary.md", content: "Hello world" },
			}),
			new AbortController().signal,
		);
		expect(written).toEqual({ status: "landed" });
		expect(writeFile).toHaveBeenCalledWith(
			{ profileId: PROFILE_ID, path: "notes/summary.md", content: "Hello world" },
			expect.any(AbortSignal),
		);

		const deleted = await executor(
			makeOpsJob({
				actionKind: "file.delete",
				actionPayload: { path: "notes/old.md" },
			}),
			new AbortController().signal,
		);
		expect(deleted).toEqual({ status: "landed" });
		expect(deleteFile).toHaveBeenCalledWith(
			{ profileId: PROFILE_ID, path: "notes/old.md" },
			expect.any(AbortSignal),
		);

		for (const blockedPath of ["QorperaOS/agents/ceo.md", "code/acme/app/repo.git/config", "../escape.txt"]) {
			const refused = await executor(
				makeOpsJob({
					actionKind: "file.write",
					actionPayload: { path: blockedPath, content: "bad" },
				}),
				new AbortController().signal,
			);
			expect(refused.status).toBe("failed");
		}
		expect(writeFile).toHaveBeenCalledTimes(1);
	});

	it("returns structured failure when control plane rejects or is unavailable", async () => {
		const executor = createOpsActionExecutor({
			controlPlane: {
				executeSurfaceOpsAction: vi.fn().mockRejectedValue(new Error("Unsupported ops action kind: custom.bad")),
			},
		});
		const result = await executor(
			makeOpsJob({ actionKind: "custom.bad", actionPayload: {} }),
			new AbortController().signal,
		);
		expect(result).toEqual({
			status: "failed",
			errorDetail: "Unsupported ops action kind: custom.bad",
		});
	});
});
