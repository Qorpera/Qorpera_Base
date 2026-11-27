import { type CloudCodingRepository, parseCodeChecksText, type SurfacePreviewConflict } from "@qorpera/contracts";
import { type CodeChecksRun, codeChecksTail } from "./code-checks.ts";
import { type CodeHostJob, CodeHostJobFailure } from "./code-host-jobs.ts";
import { type CodeHostChangeRange, composePreviewTree } from "./code-host-surfaces.ts";
import { CODE_SITE_MAX_FILES, CODE_SITE_MAX_FOLDERS, type CodeSiteProblem } from "./code-site.ts";
import { parseCodingJson } from "./coding-setup.ts";
import { NATIVE_SITE_MAX_FILES, type SiteManifestPayload } from "./site-blob-upload.ts";

export interface SurfacePreviewRecipe {
	readonly run: string;
	readonly cwd: string;
	readonly folder: string;
	readonly timeoutSeconds: number;
}

export interface SurfaceAppSpec {
	readonly kind: "server" | "hybrid";
	readonly port: number;
	readonly healthPath: string;
	readonly dockerfile: string | null;
	readonly idleTimeoutSec: number;
	readonly memoryMb: number;
	readonly vcpuLimit: number;
	readonly spaFallback: string | null;
	readonly folder: string;
	readonly recipe: SurfacePreviewRecipe | null;
}

export type SurfaceAppSpecRead =
	| { readonly kind: "none" }
	| { readonly kind: "app"; readonly app: SurfaceAppSpec }
	| { readonly kind: "invalid"; readonly detail: string };

export type SurfacePreviewRecipeRead =
	| { readonly kind: "none" }
	| { readonly kind: "recipe"; readonly recipe: SurfacePreviewRecipe }
	| { readonly kind: "invalid"; readonly detail: string };

export type SurfacePreviewPlan =
	| { readonly kind: "static" }
	| { readonly kind: "build"; readonly recipe: SurfacePreviewRecipe }
	| { readonly kind: "app"; readonly app: SurfaceAppSpec }
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

const SITE_LIMIT_PROBLEMS: ReadonlySet<CodeSiteProblem["code"]> = new Set([
	"SITE_TOO_MANY_FILES",
	"SITE_TOO_MANY_FOLDERS",
	"SITE_FILE_TOO_LARGE",
	"SITE_TOO_LARGE",
	"SITE_FILE_NAME",
]);

export function previewSiteProblemDetail(
	problem: CodeSiteProblem,
	folder: string | null,
	options?: { readonly native?: boolean },
): string {
	const native = options?.native === true;
	const path = problem.path === null || /[\r\n]/.test(problem.path) ? null : problem.path;
	const named = (what: string) => (path === null ? what : `${what}: ${path}`);
	let what: string;
	switch (problem.code) {
		case "SITE_FOLDER_MISSING":
			what = "is not there";
			break;
		case "SITE_NO_INDEX":
			what = "has no index.html at its top";
			break;
		case "SITE_TOO_MANY_FILES":
			what = `has more than ${native ? NATIVE_SITE_MAX_FILES : CODE_SITE_MAX_FILES} web files`;
			break;
		case "SITE_TOO_MANY_FOLDERS":
			what = `has web files in more than ${CODE_SITE_MAX_FOLDERS} folders`;
			break;
		case "SITE_FILE_TOO_LARGE":
			what = named(native ? "has a file over 100 MB" : "has a file over 10 MB");
			break;
		case "SITE_TOO_LARGE":
			what = native ? "is over 512 MB" : "is over 25 MB";
			break;
		case "SITE_FILE_NAME":
			what = native
				? named("has a file whose name a site cannot serve")
				: `${named("has a file whose name a site cannot serve")} (each part of a path takes only letters, digits, dots, hyphens and underscores, and starts with a letter, a digit or an underscore)`;
			break;
		case "SITE_HOLDS_SECRET":
			what = "holds the value of one of the company's secrets";
			break;
		case "SITE_LINKS_FROM_ROOT":
			what = named("has links that start with /");
			break;
	}
	const where = folder === null ? "The site" : `The build's output in "${folder}"`;
	return previewBuildDetail(
		SITE_LIMIT_PROBLEMS.has(problem.code) ? PREVIEW_BUILD_TOO_LARGE : PREVIEW_BUILD_FAILED,
		`${where} ${what}. [code=${problem.code}]`,
	);
}

export interface SurfacePreviewBuiltManifest {
	readonly manifestSha256: string;
	readonly manifest: SiteManifestPayload;
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly hasCredentialInputs: boolean;
}

export type SurfacePreviewBuildOutcome =
	| {
			readonly outcome: "built";
			readonly builtTreeSha: string | null;
			readonly native?: SurfacePreviewBuiltManifest;
	  }
	| { readonly outcome: "failed"; readonly errorDetail: string };

const PREVIEW_BUILD_RUN_SHOWN = 200;

function withTail(head: string, tail: string): string {
	const room = PREVIEW_BUILD_DETAIL_CHARS - [...head].length - 1;
	if (tail === "" || room < 40) return head;
	const lines = tail.split("\n");
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const size = [...(lines[index] as string)].length + 1;
		if (used + size > room) break;
		kept.unshift(lines[index] as string);
		used += size;
	}
	return kept.length === 0 ? head : `${head}\n${kept.join("\n")}`;
}

export function previewBuildOutcome(run: CodeChecksRun, recipe: SurfacePreviewRecipe): SurfacePreviewBuildOutcome {
	const command = [...recipe.run.replace(/\s+/g, " ").trim()];
	const shownRun =
		command.length <= PREVIEW_BUILD_RUN_SHOWN
			? command.join("")
			: `${command.slice(0, PREVIEW_BUILD_RUN_SHOWN).join("")}…`;
	if (run.state === "passed") {
		if (run.site?.state === "made") return { outcome: "built", builtTreeSha: run.site.tree };
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`The build "${shownRun}" passed, but its output in "${recipe.folder}" could not be taken. [code=${run.site?.state === "missed" ? run.site.code : "CODE_SITE_NONE"}]`,
			),
		};
	}
	if (run.state === "site_refused")
		return { outcome: "failed", errorDetail: previewSiteProblemDetail(run.problem, recipe.folder) };
	if (run.state === "not_run") {
		return {
			outcome: "failed",
			errorDetail: previewBuildDetail(
				run.code.endsWith("COMPUTER_HOURS_EXHAUSTED") ? PREVIEW_BUILD_NO_HOURS : PREVIEW_BUILD_NO_MACHINE,
				`The build "${shownRun}" did not run: ${run.code.endsWith("COMPUTER_HOURS_EXHAUSTED") ? "the company ran out of computer hours" : run.why === "copy" ? "the composed commit could not be copied into the coding machine" : "the coding machine could not run it"}. [code=${run.code}]`,
			),
		};
	}
	const failed = run.failed;
	const exit = failed.exitCode === null ? "ended without an exit code" : `exited with code ${failed.exitCode}`;
	const limit = failed.atLimit ? `, at its limit of ${recipe.timeoutSeconds} s` : "";
	const killed = failed.exitCode === 137 && !failed.atLimit ? " (killed, often for lack of memory)" : "";
	const log = failed.persistedLog ? ` Full log: ${failed.persistedLog}.` : "";
	const text = `The build "${shownRun}" in "${recipe.cwd}" ${exit} after ${Math.round(failed.ms / 1000)} s${limit}${killed}.${log} End of its output:`;
	return {
		outcome: "failed",
		errorDetail: withTail(previewBuildDetail(PREVIEW_BUILD_FAILED, text), codeChecksTail(failed.tail)),
	};
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

function declaresServerOrHybridSite(checksText: string): boolean {
	try {
		const root = parseCodingJson(checksText.startsWith("﻿") ? checksText.slice(1) : checksText, false);
		if (!root || typeof root !== "object" || Array.isArray(root)) return false;
		const site = (root as Record<string, unknown>).site;
		if (!site || typeof site !== "object" || Array.isArray(site)) return false;
		const kind = (site as Record<string, unknown>).kind;
		return kind === "server" || kind === "hybrid";
	} catch {
		return false;
	}
}

export function readSurfaceAppSpec(checksText: string | null): SurfaceAppSpecRead {
	if (checksText === null) return { kind: "none" };
	const parsed = parseCodeChecksText(checksText);
	if (!parsed.ok) {
		if (!declaresServerOrHybridSite(checksText)) return { kind: "none" };
		const problems = parsed.problems
			.slice(0, INVALID_PROBLEMS_SHOWN)
			.map((problem) => `${problem.at || "/"}: ${problem.message}`)
			.join("; ");
		return {
			kind: "invalid",
			detail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				`.qorpera/checks.json declares a server or hybrid site but is not valid, so nothing was deployed: ${problems}`,
			),
		};
	}
	const site = parsed.site;
	if (!site || (site.kind !== "server" && site.kind !== "hybrid")) return { kind: "none" };
	let recipe: SurfacePreviewRecipe | null = null;
	if (site.kind === "hybrid") {
		const readRecipe = readSurfacePreviewRecipe(checksText);
		if (readRecipe.kind === "invalid") return readRecipe;
		if (readRecipe.kind === "recipe") recipe = readRecipe.recipe;
	}
	return {
		kind: "app",
		app: {
			kind: site.kind,
			port: site.port ?? 3000,
			healthPath: site.healthPath ?? "/",
			dockerfile: site.dockerfile ?? null,
			idleTimeoutSec: site.idleTimeoutSec ?? 900,
			memoryMb: site.memoryMb ?? 512,
			vcpuLimit: site.vcpuLimit ?? 1,
			spaFallback: site.spaFallback ?? null,
			folder: site.folder,
			recipe,
		},
	};
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
	const folder = preview.folder ?? parsed.site?.folder ?? null;
	if (folder === null)
		return {
			kind: "invalid",
			detail: previewBuildDetail(
				PREVIEW_BUILD_FAILED,
				'.qorpera/checks.json has a preview recipe but names no folder, so nothing was built. Add "folder" to "preview": the folder the build writes, counted from the repository root (for example "dist", or "web/dist" when "cwd" is "web").',
			),
		};
	return {
		kind: "recipe",
		recipe: { run: preview.run, cwd: preview.cwd, folder, timeoutSeconds: preview.timeoutSeconds },
	};
}

export interface SurfacePreviewBuildRequest {
	readonly previewId: string;
	readonly surfaceId: string;
	readonly shortHostId: string;
	readonly repository: CloudCodingRepository;
	readonly baseSha?: string;
	readonly reconciledCommitSha?: string;
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
			...(request.reconciledCommitSha ? { reconciledCommitSha: request.reconciledCommitSha } : {}),
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
