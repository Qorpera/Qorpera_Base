import { type SurfaceFolderContents, surfaceFolderRoots } from "@qorpera/cloud-client/surface-folder-files";
import { SURFACE_LAYOUT_PATH } from "@qorpera/contracts";
import type { CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
import { cloudFolderFileTools } from "./cloud-folder-file-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudPictureChannel } from "./cloud-picture-channel.ts";
import { SURFACE_STARTER_SKILLS } from "./cloud-platform-skills.ts";
import { type CloudStudioSkillReader, cloudStudioSkill } from "./cloud-skill-tools.ts";
import { createCodingViewAttachmentTool } from "./cloud-surface-images.ts";
import { createNarrateExplainerTool } from "./cloud-surface-narrate-tool.ts";
import { createStudioPictureTool } from "./cloud-surface-picture-tool.ts";
import {
	chainFolderPreviewOverlays,
	createSurfaceFolderPreviewOverlay,
	createSurfaceSessionOwnOverlay,
} from "./cloud-surface-preview-overlay.ts";
import {
	applyStudioTextOps,
	buildFolderSurfaceInstructions,
	buildOpsSurfaceInstructions,
	cloudStudioFileReader,
	collectFolderPatchBaseFiles,
	folderText,
	normalizeStudioRelativePath,
	readRawOptionalFolderText,
	type SurfaceSessionTurnInput,
	surfaceStudioPageView,
} from "./cloud-surface-session-runner.ts";
import {
	createStageSurfaceOpsActionTool,
	createStageSurfacePatchTool,
	type SurfaceLayoutStaging,
	type SurfacePatchToolPort,
} from "./cloud-surface-tools.ts";
import { buildSurfaceTurnBrief, type SurfaceCodingTurnBinding } from "./cloud-surface-turn-context.ts";

export type CodingWorkspaceKind = "git_repo" | "surface_folder" | "surface_ops";

const MAX_STUDIO_TEXT_READ_BYTES = 262_144;
const MAX_STAGED_LAYOUT_READ_BYTES = 1024 * 1024;
const STUDIO_FOLDER_TOOLS: ReadonlySet<string> = new Set([
	"company_read",
	"company_list",
	"company_write",
	"company_edit",
	"company_mkdir",
]);
const OPS_FOLDER_TOOLS: ReadonlySet<string> = new Set(["company_read", "company_list"]);
const NEW_DISK_SURFACE_NOTE =
	"machine.newDisk is true: your machine got a new disk since your previous turn started. Only /company was kept, so home and cache folders and anything installed outside /company start fresh.";

export function isCodingWorkspaceKind(value: unknown): value is CodingWorkspaceKind {
	return value === "git_repo" || value === "surface_folder" || value === "surface_ops";
}

export function isSurfaceWorkspaceKind(kind: CodingWorkspaceKind): kind is "surface_folder" | "surface_ops" {
	return kind === "surface_folder" || kind === "surface_ops";
}

export interface PreparedSurfaceCodingWorkspace {
	readonly instructions: string;
	readonly claudeSystemNote: string;
	readonly turnBrief: string;
	readonly turnCorrection: string;
	readonly buildTools: (
		identity: CloudNativeToolIdentity,
		operations: CloudNativeToolOperations,
	) => readonly CloudNativeTool[];
}

function normalizeFolderRoot(raw: string): string {
	return raw.trim().replace(/^\/+|\/+$/g, "");
}

function rewriteSurfaceReplyMentions(text: string, finishTool: string): string {
	return text.replaceAll("surface_reply", finishTool).replaceAll("surface_ask", finishTool.replace("finish", "ask"));
}

function toSurfaceTurnInput(binding: SurfaceCodingTurnBinding, folderRoot: string | null): SurfaceSessionTurnInput {
	return {
		sessionId: binding.sessionId,
		surfaceId: binding.sessionId,
		companyId: "",
		surfaceSlug: binding.surfaceSlug,
		surfaceTitle: binding.surfaceTitle,
		...(binding.surfaceKind ? { surfaceKind: binding.surfaceKind } : {}),
		...(binding.surfaceIcon !== undefined ? { surfaceIcon: binding.surfaceIcon } : {}),
		...(binding.surfaceIsGlobal !== undefined ? { surfaceIsGlobal: binding.surfaceIsGlobal } : {}),
		...(binding.surfaceArchetype !== undefined ? { surfaceArchetype: binding.surfaceArchetype } : {}),
		...(binding.openLayoutOps !== undefined ? { openLayoutOps: binding.openLayoutOps } : {}),
		...(binding.openScenesOps !== undefined ? { openScenesOps: binding.openScenesOps } : {}),
		sourceKind: binding.sourceKind ?? (folderRoot ? "folder" : "native_ops"),
		prompt: binding.fullPrompt ?? "",
		state: binding.isInternalReconciliation ? "reconciling" : "queued",
		...(binding.isInternalReconciliation ? { isInternal: true } : {}),
		folderRoot,
		...(binding.voiceModel !== undefined ? { voiceModel: binding.voiceModel } : {}),
		...(binding.voiceName !== undefined ? { voiceName: binding.voiceName } : {}),
		...(binding.imageModel !== undefined ? { imageModel: binding.imageModel } : {}),
	};
}

export async function prepareSurfaceCodingWorkspace(options: {
	readonly workspaceKind: "surface_folder" | "surface_ops";
	readonly surfaceSession: SurfaceCodingTurnBinding;
	readonly folder?: CloudCompanyFolderClient;
	readonly pictures?: CloudPictureChannel;
	readonly isClaudeTurn: boolean;
	readonly newDisk: boolean;
	readonly signal: AbortSignal;
}): Promise<PreparedSurfaceCodingWorkspace> {
	const { workspaceKind, surfaceSession, folder, pictures, isClaudeTurn, newDisk, signal } = options;
	const isInternalReconciliation = surfaceSession.isInternalReconciliation === true;
	const sessionOpenChanges = surfaceSession.sessionOpenChanges ?? [];
	const previewBaseChanges = surfaceSession.previewBaseChanges ?? [];
	const replyChangeId = surfaceSession.replyChangeId?.trim() || null;
	const attachments = surfaceSession.memberImages ?? [];
	const finishToolName = isClaudeTurn ? "mcp__qorpera__coding_finish" : "coding_finish";

	if (workspaceKind === "surface_ops") {
		const stageSurfaceOpsAction = surfaceSession.stageSurfaceOpsAction;
		if (!stageSurfaceOpsAction) {
			throw new Error("CODING_SURFACE_OPS_PORT_MISSING");
		}
		const baseInstructions = buildOpsSurfaceInstructions(toSurfaceTurnInput(surfaceSession, null));
		const turnBrief = rewriteSurfaceReplyMentions(
			buildSurfaceTurnBrief({
				...surfaceSession,
				sourceKind: "native_ops",
			}),
			finishToolName,
		);
		const codexInstructions = [
			baseInstructions,
			"This session runs on a coding machine where /company is mounted read-only and /tmp is writable for scripts and analysis.",
			"Never try to mutate published Company Files under /company directly; inspect them read-only via company_read/company_list or shell commands and stage every proposed action via stage_surface_ops_action.",
			"Every turn MUST end with coding_finish (omitting headSha) or coding_ask when a founder decision is required; never end with plain text alone.",
			...(newDisk ? [NEW_DISK_SURFACE_NOTE] : []),
		].join(" ");
		const claudeSystemNote = [
			baseInstructions,
			"Your native tools (Bash, Read, Grep, Glob) run on the coding machine with /company mounted read-only and /tmp writable for scripts and analysis.",
			"Never try to mutate /company directly from Bash, Edit, or Write; stage every proposed action through mcp__qorpera__stage_surface_ops_action (and inspect company files via Read or mcp__qorpera__company_read/company_list).",
			"Every turn MUST end with mcp__qorpera__coding_finish (with operationKey and summary) or mcp__qorpera__coding_ask when a founder decision is required; ending with plain text alone fails the turn.",
			...(newDisk ? [NEW_DISK_SURFACE_NOTE] : []),
		].join("\n");
		const turnCorrection =
			"Your turn ended without coding_finish or coding_ask. Make sure any proposed action is staged with stage_surface_ops_action, then call coding_finish with a concise founder-facing summary (or coding_ask if a founder decision is needed). This is the last turn of this run.";
		return {
			instructions: codexInstructions,
			claudeSystemNote,
			turnBrief,
			turnCorrection,
			buildTools: (identity, operations) => {
				const readOnlyFolderTools = folder
					? cloudFolderFileTools({ folder, operations, identity }).filter((tool) =>
							OPS_FOLDER_TOOLS.has(tool.name),
						)
					: [];
				const viewAttachmentTool =
					surfaceSession.viewAttachment && attachments.length > 0
						? [createCodingViewAttachmentTool(attachments, surfaceSession.viewAttachment)]
						: [];
				return [
					createStageSurfaceOpsActionTool(
						surfaceSession.sessionId,
						{ stageSurfaceOpsAction },
						{ openChanges: sessionOpenChanges, replyChangeId, isInternalReconciliation },
					),
					...viewAttachmentTool,
					...readOnlyFolderTools,
				];
			},
		};
	}

	const stageSurfacePatch = surfaceSession.stageSurfacePatch;
	if (!stageSurfacePatch) {
		throw new Error("CODING_SURFACE_PATCH_PORT_MISSING");
	}
	const folderRoot = normalizeFolderRoot(
		surfaceSession.folderRoot ??
			(surfaceSession.surfaceSlug === "identity" ? "identity" : surfaceSession.surfaceSlug),
	);
	const notesRoot = `QorperaOS/surfaces/${surfaceSession.surfaceSlug}/notes`;
	const writableRoots = isInternalReconciliation ? [] : [notesRoot];
	const stagedRoots = [folderRoot];

	const externalPreviewOverlay =
		!isInternalReconciliation && folder && previewBaseChanges.length > 0
			? createSurfaceFolderPreviewOverlay({
					folderRoot,
					previewBaseChanges,
					previewReconciliations: surfaceSession.previewReconciliations ?? [],
					liveReader: folder,
				})
			: null;
	const previewOverlayStatus = externalPreviewOverlay ? await externalPreviewOverlay.prepare(signal) : null;
	const baseReaderForPatch = externalPreviewOverlay && folder ? externalPreviewOverlay.wrapTextReader(folder) : folder;
	const ownSessionOverlay =
		!isInternalReconciliation &&
		baseReaderForPatch &&
		sessionOpenChanges.some((change) => change.kind === "folder_patch")
			? createSurfaceSessionOwnOverlay({
					folderRoot,
					sessionOpenChanges,
					baseReader: baseReaderForPatch,
					replyChangeId,
				})
			: null;
	const ownOverlayStatus = ownSessionOverlay ? await ownSessionOverlay.prepare(signal) : null;
	const turnReadOverlay = chainFolderPreviewOverlays(externalPreviewOverlay, ownSessionOverlay);
	const effectiveFolderReader = turnReadOverlay && folder ? turnReadOverlay.wrapTextReader(folder) : folder;

	let contents: SurfaceFolderContents | null = null;
	if (folder) {
		try {
			const readStudio = cloudStudioFileReader(folder);
			contents = await readStudio(surfaceFolderRoots({ folderRoot, slug: surfaceSession.surfaceSlug }), signal);
		} catch (error) {
			if (signal.aborted) throw error;
			contents = null;
		}
	}
	if (contents && turnReadOverlay) {
		const layoutPath = `${folderRoot}/${SURFACE_LAYOUT_PATH}`;
		const overlaidLayout = await turnReadOverlay.lookup(layoutPath, signal);
		if (overlaidLayout?.kind === "file") {
			contents = {
				...contents,
				files: { ...contents.files, [layoutPath]: overlaidLayout.content },
			};
		} else if (overlaidLayout?.kind === "deleted") {
			const nextFiles = { ...contents.files };
			delete nextFiles[layoutPath];
			contents = { ...contents, files: nextFiles };
		}
	}
	signal.throwIfAborted();
	const turnInput = toSurfaceTurnInput(surfaceSession, folderRoot);
	const view = surfaceStudioPageView(turnInput, folderRoot, contents);
	const readSkill: CloudStudioSkillReader | undefined = folder
		? (path, maxBytes, readSignal) => folderText(folder, path, maxBytes, readSignal)
		: undefined;
	const skill =
		view.page === "layout" ? await cloudStudioSkill(SURFACE_STARTER_SKILLS[view.starter], readSkill, signal) : null;

	const stagedText = new Map<string, string | null>();
	if (surfaceSession.openScenesOps && surfaceSession.openScenesOps.length > 0) {
		applyStudioTextOps(stagedText, surfaceSession.openScenesOps, folderRoot);
	}
	const trackedSurfacePatch: SurfacePatchToolPort = {
		async stageSurfacePatch(sessionIdArg, request, context) {
			let effectiveRequest = request;
			if (!isInternalReconciliation && request.baseFiles === undefined && baseReaderForPatch) {
				const baseFiles = await collectFolderPatchBaseFiles(
					baseReaderForPatch,
					folderRoot,
					request.ops,
					context.signal,
				);
				if (baseFiles) {
					effectiveRequest = { ...request, baseFiles };
				}
			}
			const result = await stageSurfacePatch(sessionIdArg, effectiveRequest, context);
			const targetOpen = request.changeId
				? sessionOpenChanges.find((ch) => ch.changeId === request.changeId)
				: undefined;
			if (!request.optionGroup && (!targetOpen?.optionGroupKey || targetOpen.changeId === replyChangeId)) {
				applyStudioTextOps(stagedText, request.ops, folderRoot);
			}
			return result;
		},
	};
	const readStudioText = async (relativePath: string, reqSignal: AbortSignal): Promise<string | null> => {
		const rel = normalizeStudioRelativePath(relativePath, folderRoot);
		if (!rel) return null;
		if (stagedText.has(rel)) return stagedText.get(rel) ?? null;
		if (!effectiveFolderReader) return null;
		return readRawOptionalFolderText(
			effectiveFolderReader,
			`${folderRoot}/${rel}`,
			MAX_STUDIO_TEXT_READ_BYTES,
			reqSignal,
		);
	};
	const layoutStaging: SurfaceLayoutStaging | undefined = baseReaderForPatch
		? {
				folderRoot,
				waitingOps: surfaceSession.openLayoutOps ?? null,
				readLayout: (readSignal) =>
					folderText(
						baseReaderForPatch,
						`${folderRoot}/${SURFACE_LAYOUT_PATH}`,
						MAX_STAGED_LAYOUT_READ_BYTES,
						readSignal,
					),
			}
		: undefined;
	const hasMakePicture =
		!isInternalReconciliation &&
		Boolean(pictures && (!isClaudeTurn || pictures.attached) && surfaceSession.stageBytes);
	const rawStudioInstructions = buildFolderSurfaceInstructions(turnInput, folderRoot, notesRoot, view, skill, {
		chainMode: surfaceSession.chainMode === true,
		hasOmittedBases: (surfaceSession.omittedBaseChanges?.length ?? 0) > 0,
		hasMakePicture,
	});
	const turnBrief = rewriteSurfaceReplyMentions(
		buildSurfaceTurnBrief({
			...surfaceSession,
			sourceKind: "folder",
			folderRoot,
			previewOverlayStatus: previewOverlayStatus?.status ?? null,
			previewSkippedPaths: previewOverlayStatus?.skippedPaths ?? null,
			sessionOverlayStatus: ownOverlayStatus?.status ?? null,
			sessionOverlaySkippedPaths: ownOverlayStatus?.skippedPaths ?? null,
		}),
		finishToolName,
	);
	const codexInstructions = [
		rewriteSurfaceReplyMentions(rawStudioInstructions, "coding_finish"),
		"This session runs on a coding machine where /company is mounted read-only and /tmp is writable for scripts, Node/Python tooling, and Chromium/Playwright visual verification.",
		`Never try to write directly into /company/${folderRoot}/ from shell commands (the mount refuses direct writes); use company_read and company_list to read files with active Preview overlays, stage every change under ${folderRoot}/ via stage_surface_patch, and write working notes under ${notesRoot}/ via company_write.`,
		isInternalReconciliation
			? "When finished staging the combined resolution via stage_surface_patch, call coding_finish with a concise summary (omitting headSha). Never call coding_ask."
			: "Every turn MUST end with coding_finish (with operationKey, summary, and optional notePaths; omit headSha) or coding_ask when a founder decision is required; never end with plain text alone.",
		...(newDisk ? [NEW_DISK_SURFACE_NOTE] : []),
	].join("\n\n");
	const claudeSystemNote = [
		rewriteSurfaceReplyMentions(rawStudioInstructions, "mcp__qorpera__coding_finish"),
		"Your native tools (Bash, Read, Grep, Glob) run on the coding machine with /company mounted read-only and /tmp writable for scripts, Node/Python, Blender, and Chromium/Playwright visual verification.",
		`Never try to modify /company directly with Bash, Edit, or Write (the mount refuses direct writes). Use mcp__qorpera__company_read and mcp__qorpera__company_list when you need active Preview overlay contents, stage every file change under ${folderRoot}/ through mcp__qorpera__stage_surface_patch, and write working notes under ${notesRoot}/ through mcp__qorpera__company_write.`,
		isInternalReconciliation
			? "When finished staging the combined resolution via mcp__qorpera__stage_surface_patch, call mcp__qorpera__coding_finish with operationKey and a concise summary. Never call coding_ask."
			: "Every turn MUST end with mcp__qorpera__coding_finish (with operationKey, summary, and optional notePaths) or mcp__qorpera__coding_ask when a founder decision is required; ending with plain text alone fails the turn.",
		...(newDisk ? [NEW_DISK_SURFACE_NOTE] : []),
	].join("\n\n");
	const turnCorrection = isInternalReconciliation
		? "Your automatic reconciliation turn ended without calling coding_finish. Make sure you called stage_surface_patch with the combined resolution covering every overlapping path, then call coding_finish now with a brief summary. This is the last turn of this run."
		: "Your turn ended without calling coding_finish or coding_ask. Make sure your deliverables are staged via stage_surface_patch, then call coding_finish now with a concise founder-facing summary (or coding_ask if a founder decision is required). This is the last turn of this run.";

	return {
		instructions: codexInstructions,
		claudeSystemNote,
		turnBrief,
		turnCorrection,
		buildTools: (identity, operations) => {
			const stagePatchTool = createStageSurfacePatchTool(
				surfaceSession.sessionId,
				trackedSurfacePatch,
				layoutStaging,
				{
					deferSessionCompletion: true,
					allowMultipleDeliverables: isInternalReconciliation,
					openChanges: sessionOpenChanges,
					replyChangeId,
					isInternalReconciliation,
				},
			);
			const narrateTool =
				!isInternalReconciliation && surfaceSession.narrateExplainer
					? [
							createNarrateExplainerTool({
								sessionId: surfaceSession.sessionId,
								folderRoot,
								voiceModel: surfaceSession.voiceModel?.trim() || "chatgpt-voice",
								voiceName: surfaceSession.voiceName?.trim() || "cove",
								readStudioText,
								stageBytes: surfaceSession.narrateExplainer.stageBytes,
								surfacePatch: trackedSurfacePatch,
								...(surfaceSession.narrateExplainer.synthesizeGemini
									? { synthesizeGemini: surfaceSession.narrateExplainer.synthesizeGemini }
									: {}),
								onStagedOps: (ops) => applyStudioTextOps(stagedText, ops, folderRoot),
							}),
						]
					: [];
			const pictureTool =
				hasMakePicture && pictures && surfaceSession.stageBytes
					? [
							createStudioPictureTool({
								sessionId: surfaceSession.sessionId,
								folderRoot,
								stageBytes: surfaceSession.stageBytes,
								surfacePatch: trackedSurfacePatch,
								pictures,
							}),
						]
					: [];
			const viewAttachmentTool =
				surfaceSession.viewAttachment && attachments.length > 0
					? [createCodingViewAttachmentTool(attachments, surfaceSession.viewAttachment)]
					: [];
			const folderTools = folder
				? cloudFolderFileTools({
						folder,
						operations,
						identity,
						surfaceFilePolicy: { mode: "surface_worker", writableRoots, stagedRoots },
						...(turnReadOverlay ? { previewOverlay: turnReadOverlay } : {}),
					}).filter((tool) => STUDIO_FOLDER_TOOLS.has(tool.name))
				: [];
			const skillTools = surfaceSession.readSkillTools ? surfaceSession.readSkillTools(operations, identity) : [];
			return [stagePatchTool, ...narrateTool, ...pictureTool, ...viewAttachmentTool, ...folderTools, ...skillTools];
		},
	};
}
