import {
	type CloudCodingRepository,
	nextSurfaceSessionLifecycleState,
	type SurfaceChangeStatus,
	type SurfaceSessionState,
} from "@qorpera/contracts";
import type { CodeHostJob } from "./code-host-jobs.ts";
import {
	CodeHostChangeConflict,
	type CodeHostChangeRange,
	cherryPickChangeUnits,
	type RebaseSessionChangesResult,
	rebaseSessionChanges,
} from "./code-host-surfaces.ts";

export interface PeerOpenSessionInput {
	readonly sessionId: string;
	readonly workerId: string;
	readonly remainingChanges: readonly CodeHostChangeRange[];
}

export interface SurfaceChangeApprovalRequest {
	readonly surfaceId: string;
	readonly sessionId: string;
	readonly workerId: string;
	readonly repository: CloudCodingRepository;
	readonly expectMainSha?: string;
	readonly autoPublish: boolean;
	readonly sessionState: SurfaceSessionState;
	readonly sessionHasActiveChat: boolean;
	readonly allSessionChangeStatuses: readonly { readonly changeId: string; readonly status: SurfaceChangeStatus }[];
	readonly approvedChanges: readonly CodeHostChangeRange[];
	readonly siblingRemainingChanges: readonly CodeHostChangeRange[];
	readonly peerSessions: readonly PeerOpenSessionInput[];
}

export interface SurfaceChangeApprovalPorts {
	publishSurface?: (surfaceId: string, mainSha: string) => Promise<void>;
}

export type SurfaceChangeApprovalOutcome =
	| {
			readonly status: "landed";
			readonly mainBefore: string;
			readonly mainAfter: string;
			readonly landedCommits: readonly { readonly changeId: string; readonly commitSha: string }[];
			readonly nextSessionState: SurfaceSessionState;
			readonly siblingRebase: RebaseSessionChangesResult | null;
			readonly peerSync: readonly { readonly sessionId: string; readonly result: RebaseSessionChangesResult }[];
			readonly published: boolean;
	  }
	| {
			readonly status: "conflicted";
			readonly changeId: string;
			readonly conflictPaths: readonly string[];
	  };

// WHY: Runs selective cherry-pick landing, sibling/peer rebasing, lifecycle evaluation, and optional auto-publish in one deterministic workflow.
export async function approveAndSyncSurfaceChanges(
	job: CodeHostJob,
	request: SurfaceChangeApprovalRequest,
	ports: SurfaceChangeApprovalPorts = {},
): Promise<SurfaceChangeApprovalOutcome> {
	let landed: Awaited<ReturnType<typeof cherryPickChangeUnits>>;
	try {
		landed = await cherryPickChangeUnits(job, {
			repository: request.repository,
			changes: request.approvedChanges,
			...(request.expectMainSha ? { expectMainSha: request.expectMainSha } : {}),
		});
	} catch (error) {
		if (error instanceof CodeHostChangeConflict) {
			return {
				status: "conflicted",
				changeId: error.changeId,
				conflictPaths: error.paths,
			};
		}
		throw error;
	}

	// WHY: Once cherryPickChangeUnits advances refs/heads/main, isolate non-abort rebase errors so one peer session never fails an already-landed merge.
	let siblingRebase: RebaseSessionChangesResult | null = null;
	if (request.siblingRemainingChanges.length > 0) {
		const allowedBranchTips = [
			request.siblingRemainingChanges[request.siblingRemainingChanges.length - 1]!.headSha,
			...request.approvedChanges.map((change) => change.headSha),
		];
		try {
			siblingRebase = await rebaseSessionChanges(job, {
				repository: request.repository,
				workerId: request.workerId,
				ontoSha: landed.mainAfter,
				remainingChanges: request.siblingRemainingChanges,
				updateBranchRef: true,
				allowedBranchTips,
			});
		} catch (error) {
			if (job.signal.aborted) throw error;
			siblingRebase = {
				status: "deferred",
				ontoSha: landed.mainAfter,
				reason: "worktree_dirty",
				restored: [],
			};
		}
	}

	const peerSync: { sessionId: string; result: RebaseSessionChangesResult }[] = [];
	for (const peer of request.peerSessions) {
		if (peer.remainingChanges.length === 0) continue;
		let result: RebaseSessionChangesResult;
		try {
			result = await rebaseSessionChanges(job, {
				repository: request.repository,
				workerId: peer.workerId,
				ontoSha: landed.mainAfter,
				remainingChanges: peer.remainingChanges,
				updateBranchRef: true,
				allowedBranchTips: [peer.remainingChanges[peer.remainingChanges.length - 1]!.headSha],
			});
		} catch (error) {
			if (job.signal.aborted) throw error;
			result = {
				status: "deferred",
				ontoSha: landed.mainAfter,
				reason: "worktree_dirty",
				restored: [],
			};
		}
		peerSync.push({ sessionId: peer.sessionId, result });
	}

	const approvedSet = new Set(request.approvedChanges.map((item) => item.changeId));
	const updatedStatuses = request.allSessionChangeStatuses.map((item) => {
		if (approvedSet.has(item.changeId)) return { status: "merged" as const };
		if (siblingRebase?.status === "conflicted" && siblingRebase.conflictedChangeId === item.changeId) {
			return { status: "conflicted" as const };
		}
		return { status: item.status };
	});

	const nextSessionState = nextSurfaceSessionLifecycleState({
		state: request.sessionState,
		hasActiveChat: request.sessionHasActiveChat,
		changes: updatedStatuses,
	});

	let published = false;
	if (request.autoPublish && ports.publishSurface) {
		await ports.publishSurface(request.surfaceId, landed.mainAfter);
		published = true;
	}

	return {
		status: "landed",
		mainBefore: landed.mainBefore,
		mainAfter: landed.mainAfter,
		landedCommits: landed.landedCommits,
		nextSessionState,
		siblingRebase,
		peerSync,
		published,
	};
}
