import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acceptReviewedCloudCompanyExecution,
	bindCloudCompanyExecution,
	type CloudCompanyProposalPrimary,
	cloudCompanyExecutionMatchesCanonical,
	createCloudCompanyExecutionCheckout,
	discardCleanCloudCompanyExecution,
	findRecoverableCloudCompanyExecution,
	listRecoverableCloudCompanyExecutions,
	promoteCloudCompanyExecution,
	publishCloudCompanyExecutionProposal,
	quarantineCloudCompanyExecution,
	recoverableCloudCompanyExecutions,
	recoverOrphanedCloudCompanyExecutions,
	rejectReviewedCloudCompanyExecution,
	resolvePublishedCloudCompanyExecution,
} from "../src/cloud-company-execution.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "20000000-0000-4000-8000-000000000002";
const CLAIMANT_ID = "30000000-0000-4000-8000-000000000003";
const HOST_INSTANCE_ID = "40000000-0000-4000-8000-000000000004";
const RESTARTED_HOST_INSTANCE_ID = "50000000-0000-4000-8000-000000000005";
const ENVIRONMENT_ID = "60000000-0000-4000-8000-000000000006";
const BASE_SNAPSHOT_ID = "70000000-0000-4000-8000-000000000007";
const PROPOSAL_SNAPSHOT_ID = "80000000-0000-4000-8000-000000000008";
const SESSION_ID = "90000000-0000-4000-8000-000000000009";
const roots: string[] = [];

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgSign=false", "-C", root, ...args], {
		encoding: "utf-8",
		windowsHide: true,
	}).trim();
}

function fixture(): { userData: string; companyRoot: string } {
	const base = mkdtempSync(join(tmpdir(), "qorpera-company-execution-"));
	roots.push(base);
	const userData = join(base, "user-data");
	const companyRoot = join(base, "company");
	mkdirSync(companyRoot, { recursive: true });
	git(companyRoot, "init");
	writeFileSync(join(companyRoot, "analysis.md"), "base\n", "utf-8");
	writeFileSync(join(companyRoot, "operations.md"), "base\n", "utf-8");
	writeFileSync(join(companyRoot, ".gitignore"), "*.tmp\n", "utf-8");
	git(companyRoot, "add", "--all");
	git(companyRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
	return { userData, companyRoot };
}

function commitCanonical(companyRoot: string, path: string, contents: string): void {
	writeFileSync(join(companyRoot, path), contents, "utf-8");
	git(companyRoot, "add", "--", path);
	git(
		companyRoot,
		"-c",
		"user.name=Founder",
		"-c",
		"user.email=founder@example.com",
		"commit",
		"-m",
		"canonical edit",
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloud Company File execution checkouts", () => {
	it("promotes a settled proposal without overwriting a concurrent unrelated canonical change", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		bindCloudCompanyExecution(checkout, { kind: "turn", id: EXECUTION_ID, claimantId: CLAIMANT_ID });
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "agent\n", "utf-8");
		writeFileSync(join(checkout.checkoutRoot, "research.tmp"), "ignored but company-owned\n", "utf-8");
		commitCanonical(companyRoot, "operations.md", "founder\n");

		await expect(promoteCloudCompanyExecution(checkout)).resolves.toMatchObject({ status: "promoted" });
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("agent\n");
		expect(readFileSync(join(companyRoot, "operations.md"), "utf-8")).toBe("founder\n");
		expect(readFileSync(join(companyRoot, "research.tmp"), "utf-8")).toBe("ignored but company-owned\n");
		expect(() =>
			git(companyRoot, "show-ref", "--verify", `refs/qorpera/executions/${checkout.checkoutId}`),
		).toThrow();
	});

	it("detects when an attached execution checkout predates the canonical Company File", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		expect(cloudCompanyExecutionMatchesCanonical(checkout)).toBe(true);
		commitCanonical(companyRoot, "operations.md", "new canonical revision\n");
		expect(cloudCompanyExecutionMatchesCanonical(checkout)).toBe(false);
	});

	it("retains a same-path conflict as a reviewable proposal without changing canonical bytes", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "agent\n", "utf-8");
		commitCanonical(companyRoot, "analysis.md", "founder\n");

		await expect(promoteCloudCompanyExecution(checkout)).resolves.toMatchObject({ status: "requires_review" });
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("founder\n");
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(1);
		const [review] = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		if (!review) throw new Error("reviewable execution was not listed");
		writeFileSync(join(review.checkoutRoot, "analysis.md"), "reviewed combined result\n", "utf-8");
		await quarantineCloudCompanyExecution(review);
		const [updatedReview] = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		if (!updatedReview) throw new Error("updated reviewable execution was not listed");
		await acceptReviewedCloudCompanyExecution(updatedReview);
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("reviewed combined result\n");
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(0);
		expect(() => git(companyRoot, "show-ref", "--verify", `refs/qorpera/executions/${review.checkoutId}`)).toThrow();
	});

	it("persists a review-required checkout as a verified cloud proposal without advancing canonical", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		const execution = { kind: "turn" as const, id: EXECUTION_ID, claimantId: CLAIMANT_ID };
		bindCloudCompanyExecution(checkout, execution);
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "agent proposal\n", "utf-8");
		commitCanonical(companyRoot, "analysis.md", "founder edit\n");
		await expect(promoteCloudCompanyExecution(checkout)).resolves.toMatchObject({ status: "requires_review" });
		expect(cloudCompanyExecutionMatchesCanonical(checkout)).toBe(false);

		const objects = new CloudContentAddressedStore(new MemoryObjectTransport());
		let graphInput: Parameters<CloudCompanyProposalPrimary["beginObjectReachabilityGraph"]>[0] | undefined;
		const primary: CloudCompanyProposalPrimary = {
			prepareCompanyFileProposal: vi.fn(async (input) => ({
				snapshotId: PROPOSAL_SNAPSHOT_ID,
				profileId: PROFILE_ID,
				environmentId: ENVIRONMENT_ID,
				workspaceId: "a0000000-0000-4000-8000-000000000010",
				clientSnapshotId: input.clientRevisionId,
				parentSnapshotId: input.baseSnapshotId,
				tree: input.tree,
				createdByUserId: "b0000000-0000-4000-8000-000000000011",
				createdAt: "2026-08-20T12:00:00.000Z",
				publicationState: "prepared" as const,
			})),
			beginObjectReachabilityGraph: vi.fn(async (input) => {
				graphInput = input;
				return {
					graphId: "c0000000-0000-4000-8000-000000000012",
					profileId: PROFILE_ID,
					environmentId: ENVIRONMENT_ID,
					rootKind: input.rootKind,
					rootId: input.rootId,
					clientGraphId: input.clientGraphId,
					rootObjectSha256: input.rootObjectSha256,
					contractVersion: 1 as const,
					contentSha256: input.contentSha256,
					objectCount: input.objectCount,
					storageBytes: input.storageBytes,
					status: "uploading" as const,
					createdByUserId: "b0000000-0000-4000-8000-000000000011",
					createdAt: "2026-08-20T12:00:00.000Z",
				};
			}),
			appendObjectReachabilityEntries: vi.fn(async (_graphId, entries) => entries.length),
			completeObjectReachabilityGraph: vi.fn(async () => {
				if (!graphInput) throw new Error("graph was not started");
				return {
					graphId: "c0000000-0000-4000-8000-000000000012",
					profileId: PROFILE_ID,
					environmentId: ENVIRONMENT_ID,
					rootKind: graphInput.rootKind,
					rootId: graphInput.rootId,
					clientGraphId: graphInput.clientGraphId,
					rootObjectSha256: graphInput.rootObjectSha256,
					contractVersion: 1 as const,
					contentSha256: graphInput.contentSha256,
					objectCount: graphInput.objectCount,
					storageBytes: graphInput.storageBytes,
					status: "complete" as const,
					createdByUserId: "b0000000-0000-4000-8000-000000000011",
					createdAt: "2026-08-20T12:00:00.000Z",
					completedAt: "2026-08-20T12:00:01.000Z",
				};
			}),
			verifyCompanySnapshotClosure: vi.fn(async () => undefined),
			createObjectRestoreProof: vi.fn(async (graphId, clientProofId, restoredContentSha256, restoredBytes) => ({
				proofId: "d0000000-0000-4000-8000-000000000013",
				graphId,
				profileId: PROFILE_ID,
				clientProofId,
				restoredContentSha256,
				restoredBytes,
				verifiedByUserId: "b0000000-0000-4000-8000-000000000011",
				verifiedAt: "2026-08-20T12:00:01.000Z",
				validUntil: "2026-08-27T12:00:01.000Z",
			})),
			submitCompanyProposal: vi.fn(async (input) => ({
				proposalId: "e0000000-0000-4000-8000-000000000014",
				profileId: PROFILE_ID,
				environmentId: ENVIRONMENT_ID,
				clientProposalId: input.clientProposalId,
				baseSnapshotId: BASE_SNAPSHOT_ID,
				proposalSnapshot: {
					snapshotId: PROPOSAL_SNAPSHOT_ID,
					profileId: PROFILE_ID,
					environmentId: ENVIRONMENT_ID,
					workspaceId: "a0000000-0000-4000-8000-000000000010",
					clientSnapshotId: "f0000000-0000-4000-8000-000000000015",
					parentSnapshotId: BASE_SNAPSHOT_ID,
					tree: {
						manifestSha256: graphInput?.rootObjectSha256 ?? "",
						manifestBytes: 1,
						contractVersion: 3,
						fileCount: 1,
						totalBytes: 1,
					},
					createdByUserId: "b0000000-0000-4000-8000-000000000011",
					createdAt: "2026-08-20T12:00:00.000Z",
					publicationState: "prepared" as const,
				},
				execution,
				sessionId: SESSION_ID,
				trailEndSequence: 7,
				reason: "conflict" as const,
				title: "Review agent output",
				reviewerStaffIds: [],
				reviewRevision: 1,
				reviews: [],
				status: "open" as const,
				createdByUserId: "b0000000-0000-4000-8000-000000000011",
				createdByName: "Founder",
				createdAt: "2026-08-20T12:00:01.000Z",
			})),
		};

		await expect(
			publishCloudCompanyExecutionProposal({
				userData,
				environmentId: ENVIRONMENT_ID,
				baseSnapshotId: BASE_SNAPSHOT_ID,
				checkout,
				execution,
				sessionId: SESSION_ID,
				trailEndSequence: 7,
				reason: "conflict",
				title: "Review agent output",
				objects,
				primary,
			}),
		).resolves.toMatchObject({ status: "open", execution, trailEndSequence: 7 });
		expect(primary.prepareCompanyFileProposal).toHaveBeenCalledWith(
			expect.objectContaining({ environmentId: ENVIRONMENT_ID, baseSnapshotId: BASE_SNAPSHOT_ID }),
		);
		expect(primary.submitCompanyProposal).toHaveBeenCalledWith(
			expect.objectContaining({ execution, sessionId: SESSION_ID, trailEndSequence: 7 }),
		);
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("founder edit\n");
		await expect(
			resolvePublishedCloudCompanyExecution({
				userData,
				profileId: PROFILE_ID,
				companyRoot,
				proposalId: "e0000000-0000-4000-8000-000000000014",
				proposalSnapshotId: PROPOSAL_SNAPSHOT_ID,
			}),
		).resolves.toBe(1);
		expect(existsSync(checkout.checkoutRoot)).toBe(false);
		expect(existsSync(checkout.statePath)).toBe(false);
	});

	it("quarantines crash output without exposing it in the canonical Company File", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		bindCloudCompanyExecution(checkout, { kind: "wake", id: EXECUTION_ID, claimantId: CLAIMANT_ID });
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "partial\n", "utf-8");

		await expect(quarantineCloudCompanyExecution(checkout)).resolves.toMatchObject({
			proposalHead: expect.any(String),
		});
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("base\n");
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(1);
		const [review] = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		if (!review) throw new Error("quarantined execution was not listed");
		await rejectReviewedCloudCompanyExecution(review);
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(0);
	});

	it("removes an owned clean checkout", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		await discardCleanCloudCompanyExecution(checkout);
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(0);
		expect(() => readFileSync(checkout.statePath, "utf-8")).toThrow();
	});

	it("recovers only orphaned active checkouts after an exclusively fenced restart", async () => {
		const { userData, companyRoot } = fixture();
		const orphaned = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		writeFileSync(join(orphaned.checkoutRoot, "analysis.md"), "interrupted work\n", "utf-8");
		const live = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: RESTARTED_HOST_INSTANCE_ID,
		});

		await expect(
			recoverOrphanedCloudCompanyExecutions({
				userData,
				profileId: PROFILE_ID,
				companyRoot,
				hostInstanceId: RESTARTED_HOST_INSTANCE_ID,
				exclusiveHost: true,
				liveCheckoutIds: new Set([live.checkoutId]),
			}),
		).resolves.toEqual({ discarded: 0, reviewable: 1 });
		const reviews = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		expect(reviews.map((review) => review.checkoutId)).toEqual([orphaned.checkoutId]);
		expect(readFileSync(join(live.checkoutRoot, "analysis.md"), "utf-8")).toBe("base\n");
		await discardCleanCloudCompanyExecution(live);
	});

	it("discards an orphaned clean checkout and requires the exact reviewed proposal identity", async () => {
		const { userData, companyRoot } = fixture();
		createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: HOST_INSTANCE_ID,
		});
		await expect(
			recoverOrphanedCloudCompanyExecutions({
				userData,
				profileId: PROFILE_ID,
				companyRoot,
				hostInstanceId: RESTARTED_HOST_INSTANCE_ID,
				exclusiveHost: true,
			}),
		).resolves.toEqual({ discarded: 1, reviewable: 0 });

		const checkout = createCloudCompanyExecutionCheckout({
			userData,
			profileId: PROFILE_ID,
			companyRoot,
			hostInstanceId: RESTARTED_HOST_INSTANCE_ID,
		});
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "agent\n", "utf-8");
		commitCanonical(companyRoot, "analysis.md", "founder\n");
		await promoteCloudCompanyExecution(checkout);
		const [review] = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		if (!review) throw new Error("reviewable execution was not listed");
		writeFileSync(join(review.checkoutRoot, "analysis.md"), "new review bytes\n", "utf-8");
		await quarantineCloudCompanyExecution(review);
		await expect(acceptReviewedCloudCompanyExecution(review)).rejects.toThrow("review the current version first");
		expect(
			findRecoverableCloudCompanyExecution(
				userData,
				PROFILE_ID,
				review.checkoutId,
				review.proposalHead,
				review.expectedCanonicalHead,
			),
		).toBeUndefined();
	});
});
