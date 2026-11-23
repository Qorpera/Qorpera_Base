import type { CloudCodingRepository, SurfacePreviewConflict } from "@qorpera/contracts";
import { type CodeHostJob, CodeHostJobFailure } from "./code-host-jobs.ts";
import { type CodeHostChangeRange, composePreviewTree } from "./code-host-surfaces.ts";
import { parseCodingJson } from "./coding-setup.ts";

export interface FastPreviewRecipe {
	readonly run: string;
	readonly cwd: string;
	readonly timeoutSeconds: number;
	readonly folder: string;
}

const DEFAULT_PREVIEW_TIMEOUT_SECONDS = 180;
const SKIPPED_PREVIEW_CHECK_NAMES = /^(?:test|tests|unit|e2e|lint|typecheck|format|check)$/i;

// WHY: Extracts a fast build command from .qorpera/checks.json so interactive preview toggles skip slow lint/e2e suites.
export function parseFastPreviewRecipe(checksJsonText: string): FastPreviewRecipe | null {
	let parsed: unknown;
	try {
		parsed = parseCodingJson(checksJsonText, false);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const root = parsed as Record<string, unknown>;
	const siteRaw = root.site;
	const siteFolder =
		siteRaw &&
		typeof siteRaw === "object" &&
		!Array.isArray(siteRaw) &&
		typeof (siteRaw as Record<string, unknown>).folder === "string"
			? ((siteRaw as Record<string, unknown>).folder as string).trim()
			: null;

	const previewRaw = root.preview;
	if (previewRaw && typeof previewRaw === "object" && !Array.isArray(previewRaw)) {
		const p = previewRaw as Record<string, unknown>;
		const run = typeof p.run === "string" ? p.run.trim() : "";
		const folder = typeof p.folder === "string" ? p.folder.trim() : (siteFolder ?? "dist");
		const cwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : ".";
		const timeoutSeconds =
			typeof p.timeoutSeconds === "number" && Number.isSafeInteger(p.timeoutSeconds) && p.timeoutSeconds >= 10
				? Math.min(p.timeoutSeconds, 600)
				: DEFAULT_PREVIEW_TIMEOUT_SECONDS;
		if (run && folder) return { run, cwd, timeoutSeconds, folder };
	}

	if (!siteFolder || !Array.isArray(root.checks)) return null;
	const checks = root.checks.filter(
		(item): item is Record<string, unknown> =>
			Boolean(item) &&
			typeof item === "object" &&
			!Array.isArray(item) &&
			typeof (item as Record<string, unknown>).run === "string",
	);
	const buildCheck =
		checks.find((item) => typeof item.name === "string" && /build/i.test(item.name)) ??
		[...checks]
			.reverse()
			.find((item) => typeof item.name !== "string" || !SKIPPED_PREVIEW_CHECK_NAMES.test(item.name));
	if (!buildCheck) return null;
	return {
		run: (buildCheck.run as string).trim(),
		cwd: typeof buildCheck.cwd === "string" && buildCheck.cwd.trim() ? buildCheck.cwd.trim() : ".",
		timeoutSeconds:
			typeof buildCheck.timeoutSeconds === "number" && Number.isSafeInteger(buildCheck.timeoutSeconds)
				? Math.min(Math.max(buildCheck.timeoutSeconds, 10), 600)
				: DEFAULT_PREVIEW_TIMEOUT_SECONDS,
		folder: siteFolder,
	};
}

export interface SurfacePreviewBuildRequest {
	readonly previewId: string;
	readonly surfaceId: string;
	readonly shortHostId: string;
	readonly repository: CloudCodingRepository;
	readonly baseSha?: string;
	readonly exploration?: {
		readonly sessionId: string;
		readonly baseSha: string;
		readonly headSha: string;
	};
	readonly changes: readonly Pick<CodeHostChangeRange, "changeId" | "parentSha" | "headSha">[];
}

export interface SurfacePreviewBuildCompletion {
	readonly status: "ready" | "conflicted" | "failed";
	readonly compositeTreeSha?: string;
	readonly siteVersionId?: string | null;
	readonly conflictReport?: SurfacePreviewConflict | null;
	readonly errorDetail?: string | null;
}

export interface SurfacePreviewRunnerPorts {
	buildAndUploadPreview(input: {
		readonly previewId: string;
		readonly surfaceId: string;
		readonly shortHostId: string;
		readonly compositeCommitSha: string;
		readonly compositeTreeSha: string;
		readonly previewRef: string | null;
	}): Promise<{ readonly siteVersionId: string }>;
	completePreview(previewId: string, completion: SurfacePreviewBuildCompletion): Promise<void>;
}

export async function buildCompositeSurfacePreview(
	job: CodeHostJob,
	request: SurfacePreviewBuildRequest,
	ports: SurfacePreviewRunnerPorts,
): Promise<SurfacePreviewBuildCompletion> {
	try {
		const composed = await composePreviewTree(job, {
			repository: request.repository,
			...(request.baseSha ? { baseSha: request.baseSha } : {}),
			...(request.exploration ? { exploration: request.exploration } : {}),
			changes: request.changes,
		});

		if (composed.status === "conflicted") {
			const completion: SurfacePreviewBuildCompletion = {
				status: "conflicted",
				compositeTreeSha: composed.lastCleanTreeSha,
				conflictReport: {
					changeIds: [...composed.appliedChangeIds, composed.conflictingChangeId],
					paths: [...composed.conflictPaths],
				},
				errorDetail: null,
			};
			await ports.completePreview(request.previewId, completion);
			return completion;
		}

		const uploaded = await ports.buildAndUploadPreview({
			previewId: request.previewId,
			surfaceId: request.surfaceId,
			shortHostId: request.shortHostId,
			compositeCommitSha: composed.compositeCommitSha,
			compositeTreeSha: composed.compositeTreeSha,
			previewRef: composed.previewRef,
		});

		const completion: SurfacePreviewBuildCompletion = {
			status: "ready",
			compositeTreeSha: composed.compositeTreeSha,
			siteVersionId: uploaded.siteVersionId,
			conflictReport: null,
			errorDetail: null,
		};
		await ports.completePreview(request.previewId, completion);
		return completion;
	} catch (error) {
		// WHY: A preempted preview job yielded to higher-priority company work; never mark it permanently failed.
		if ((error instanceof CodeHostJobFailure && error.code === "CODE_HOST_JOB_YIELDED") || job.signal.aborted) {
			throw error;
		}
		const detail = error instanceof Error ? error.message.slice(0, 1000) : "Preview build failed";
		const completion: SurfacePreviewBuildCompletion = {
			status: "failed",
			errorDetail: detail,
		};
		await ports.completePreview(request.previewId, completion);
		return completion;
	}
}
