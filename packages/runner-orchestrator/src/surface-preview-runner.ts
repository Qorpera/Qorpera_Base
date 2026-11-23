import { type CloudCodingRepository, parseCodeChecksText, type SurfacePreviewConflict } from "@qorpera/contracts";
import { type CodeHostJob, CodeHostJobFailure } from "./code-host-jobs.ts";
import { type CodeHostChangeRange, composePreviewTree } from "./code-host-surfaces.ts";
import { parseCodingJson } from "./coding-setup.ts";

export interface SurfacePreviewRecipe {
	readonly run: string;
	readonly cwd: string;
	readonly folder: string;
	readonly timeoutSeconds: number;
}

export type SurfacePreviewRecipeRead =
	| { readonly kind: "none" }
	| { readonly kind: "recipe"; readonly recipe: SurfacePreviewRecipe }
	| { readonly kind: "invalid"; readonly detail: string };

export type SurfacePreviewPlan =
	| { readonly kind: "static" }
	| { readonly kind: "build"; readonly recipe: SurfacePreviewRecipe }
	| { readonly kind: "invalid"; readonly detail: string };

export const PREVIEW_BUILD_FAILED = "PREVIEW_BUILD_FAILED";
export const PREVIEW_BUILD_TOO_LARGE = "PREVIEW_BUILD_TOO_LARGE";
export const PREVIEW_BUILD_NO_MACHINE = "PREVIEW_BUILD_NO_MACHINE";
export const PREVIEW_BUILD_NO_HOURS = "PREVIEW_BUILD_NO_HOURS";
export type PreviewBuildCode =
	| typeof PREVIEW_BUILD_FAILED
	| typeof PREVIEW_BUILD_TOO_LARGE
	| typeof PREVIEW_BUILD_NO_MACHINE
	| typeof PREVIEW_BUILD_NO_HOURS;

export const PREVIEW_BUILD_DETAIL_CHARS = 1000;
const INVALID_PROBLEMS_SHOWN = 5;

export function previewBuildDetail(code: PreviewBuildCode, text: string): string {
	const whole = `${code}\n${text}`;
	return [...whole].length <= PREVIEW_BUILD_DETAIL_CHARS
		? whole
		: [...whole].slice(0, PREVIEW_BUILD_DETAIL_CHARS).join("");
}

function declaresBuild(checksText: string): boolean {
	try {
		const root = parseCodingJson(checksText.startsWith("﻿") ? checksText.slice(1) : checksText, false);
		if (!root || typeof root !== "object" || Array.isArray(root)) return false;
		const preview = (root as Record<string, unknown>).preview;
		if (!preview || typeof preview !== "object" || Array.isArray(preview)) return false;
		const run = (preview as Record<string, unknown>).run;
		return typeof run !== "string" || run.trim() !== "true";
	} catch {
		return false;
	}
}

export function readSurfacePreviewRecipe(checksText: string | null): SurfacePreviewRecipeRead {
	if (checksText === null) return { kind: "none" };
	const parsed = parseCodeChecksText(checksText);
	if (!parsed.ok) {
		if (!declaresBuild(checksText)) return { kind: "none" };
		const problems = parsed.problems
			.slice(0, INVALID_PROBLEMS_SHOWN)
			.map((problem) => `${problem.at || "/"}: ${problem.message}`)
			.join("; ");
		return {
			kind: "invalid",
			detail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`.qorpera/checks.json declares a preview build but is not valid, so nothing was built: ${problems}`,
			),
		};
	}
	const preview = parsed.preview;
	if (!preview || preview.run.trim() === "true") return { kind: "none" };
	return {
		kind: "recipe",
		recipe: {
			run: preview.run,
			cwd: preview.cwd,
			folder: preview.folder ?? parsed.site?.folder ?? ".",
			timeoutSeconds: preview.timeoutSeconds,
		},
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
