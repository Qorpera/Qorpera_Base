import {
	type CloudCodingRepository,
	nextSurfaceSessionLifecycleState,
	type SurfaceChangeStatus,
	type SurfaceSessionState,
} from "@qorpera/contracts";
import { type CodeHostJob, CodeHostJobFailure, CodeHostRefusal } from "./code-host-jobs.ts";
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
	readonly recordedChangeHeadShas?: readonly string[];
	readonly remainingChanges: readonly CodeHostChangeRange[];
}

export interface SurfaceChangeApprovalRequest {
	readonly surfaceId: string;
	readonly sessionId: string;
	readonly workerId: string;
	readonly sessionBranchHeadSha?: string | null;
	readonly recordedChangeHeadShas?: readonly string[];
	readonly repository: CloudCodingRepository;
	readonly expectMainSha?: string;
	readonly reconciledCommitSha?: string;
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

function rebaseErrorCode(error: unknown): string {
	if (error instanceof CodeHostRefusal || error instanceof CodeHostJobFailure) return error.code;
	return error instanceof Error && error.name ? error.name : "UNKNOWN";
}

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
			...(request.reconciledCommitSha ? { reconciledCommitSha: request.reconciledCommitSha } : {}),
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
	const approvedHeads = new Set(request.approvedChanges.map((change) => change.headSha));
	const needsBranchReset = Boolean(request.sessionBranchHeadSha && !approvedHeads.has(request.sessionBranchHeadSha));
	if (request.siblingRemainingChanges.length > 0 || needsBranchReset) {
		const allowedBranchTips = [
			...new Set([
				...(request.siblingRemainingChanges.length > 0
					? [request.siblingRemainingChanges[request.siblingRemainingChanges.length - 1]!.headSha]
					: []),
				...request.approvedChanges.map((change) => change.headSha),
				...(request.recordedChangeHeadShas ?? []),
			]),
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
				reason: "rebase_failed",
				errorCode: rebaseErrorCode(error),
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
				allowedBranchTips: [
					...new Set([
						peer.remainingChanges[peer.remainingChanges.length - 1]!.headSha,
						...(peer.recordedChangeHeadShas ?? []),
					]),
				],
			});
		} catch (error) {
			if (job.signal.aborted) throw error;
			result = {
				status: "deferred",
				ontoSha: landed.mainAfter,
				reason: "rebase_failed",
				errorCode: rebaseErrorCode(error),
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
