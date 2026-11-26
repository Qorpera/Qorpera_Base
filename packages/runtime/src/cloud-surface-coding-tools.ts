import { type SurfaceFolderContents, surfaceFolderRoots } from "@qorpera/cloud-client/surface-folder-files";
import {
	IDENTITY_TOKENS_CSS_PATH,
	type StudioBinaryRef,
	type StudioPatchOp,
	SURFACE_LAYOUT_PATH,
} from "@qorpera/contracts";
import type { CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
import { type CloudCompanyDataDoor, cloudDataTools } from "./cloud-data-tools.ts";
import { cloudFolderFileTools } from "./cloud-folder-file-tools.ts";
import { type CloudFolderSearch, cloudFolderSearchTool } from "./cloud-folder-search-tool.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import type { CloudNativeTool } from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudPictureChannel } from "./cloud-picture-channel.ts";
import { SURFACE_STARTER_SKILLS } from "./cloud-platform-skills.ts";
import { type CloudStudioSkillReader, cloudStudioSkill } from "./cloud-skill-tools.ts";
import { recordStudioChatGptVoiceClips, type StudioChatGptVoiceMachine } from "./cloud-studio-voice-recorder.ts";
import { createStageSurfaceArtifactTool } from "./cloud-surface-artifact-tool.ts";
import { createCodingViewAttachmentTool } from "./cloud-surface-images.ts";
import {
	createInspectSurfaceTool,
	type StudioInspectBinaryMeta,
	type StudioInspectLocalAsset,
	studioInspectAsker,
} from "./cloud-surface-inspect-tool.ts";
import { createComposeSurfaceLayoutTool } from "./cloud-surface-layout-tool.ts";
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
	createSurfacePatchSessionTracker,
	type SurfaceLayoutStaging,
	type SurfacePatchToolPort,
} from "./cloud-surface-tools.ts";
import { buildSurfaceTurnBrief, type SurfaceCodingTurnBinding } from "./cloud-surface-turn-context.ts";
import type { CloudVoiceName } from "./cloud-voice-channel.ts";

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
const READ_ONLY_DATA_TOOLS: ReadonlySet<string> = new Set(["data_describe", "data_query"]);
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
		codingMachine?: StudioChatGptVoiceMachine,
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
	readonly folderSearch?: CloudFolderSearch;
	readonly companyData?: CloudCompanyDataDoor;
	readonly pictures?: CloudPictureChannel;
	readonly isClaudeTurn: boolean;
	readonly newDisk: boolean;
	readonly signal: AbortSignal;
}): Promise<PreparedSurfaceCodingWorkspace> {
	const { workspaceKind, surfaceSession, folder, folderSearch, companyData, pictures, isClaudeTurn, newDisk, signal } =
		options;
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
				hasCompanySearch: Boolean(folder && folderSearch),
				hasReadOnlyData: Boolean(folder && companyData),
			}),
			finishToolName,
		);
		const codexInstructions = [
			baseInstructions,
			"This session runs on a coding machine where the entire company folder (every active Interface listed under Company Interfaces) is mounted read-only at /company and /tmp is writable for scripts and analysis.",
			"Never try to mutate published Company Files under /company directly; inspect them read-only via company_search, company_read, company_list, data_describe, data_query, or shell commands under /company, and stage every proposed action via stage_surface_ops_action.",
			"Every turn MUST end with coding_finish (omitting headSha) or coding_ask when a founder decision is required; never end with plain text alone.",
			...(newDisk ? [NEW_DISK_SURFACE_NOTE] : []),
		].join(" ");
		const claudeSystemNote = [
			baseInstructions,
			"Your native tools (Bash, Read, Grep, Glob) run on the coding machine with the entire company folder (every active Interface listed under Company Interfaces) mounted read-only at /company and /tmp writable for scripts and analysis.",
			"Never try to mutate /company directly from Bash, Edit, or Write; stage every proposed action through mcp__qorpera__stage_surface_ops_action, inspect company files via Read or mcp__qorpera__company_search/company_read/company_list, and query company databases read-only via mcp__qorpera__data_describe/data_query.",
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
				const searchTools =
					folder && folderSearch
						? [cloudFolderSearchTool({ search: folderSearch, folder, runId: identity.runId })]
						: [];
				const dataTools =
					folder && companyData
						? cloudDataTools({ folder, door: companyData, apply: false }).filter((tool) =>
								READ_ONLY_DATA_TOOLS.has(tool.name),
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
					...searchTools,
					...dataTools,
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
	const baseContentsFiles: Readonly<Record<string, string>> = contents ? { ...contents.files } : {};
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
	const stagedBytesBySha = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: string }>();
	const stagedBinaries = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: string }>();
	const stagedOpsByChangeId = new Map<string, StudioPatchOp[]>();
	const replacedInTurnChangeIds = new Set<string>();
	const optionGroupByChangeId = new Map<string, string | null>(
		sessionOpenChanges.map((ch) => [ch.changeId, ch.optionGroupKey ?? null]),
	);
	const localSourceByPath = new Map<string, StudioInspectLocalAsset>();
	const localSourceByChangeId = new Map<string, Map<string, StudioInspectLocalAsset>>();
	const rawStageBytes = surfaceSession.stageBytes ?? surfaceSession.narrateExplainer?.stageBytes;
	const trackedStageBytes = rawStageBytes
		? async (bytes: Uint8Array, mediaType: string, reqSignal: AbortSignal): Promise<StudioBinaryRef> => {
				const ref = await rawStageBytes(bytes, mediaType, reqSignal);
				stagedBytesBySha.set(ref.fileSha256, { bytes, mediaType });
				return ref;
			}
		: undefined;
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
			const targetId = request.changeId ?? result.changeId;
			const prevGroup = optionGroupByChangeId.get(targetId) ?? null;
			const resolvedGroup = request.optionGroup ?? prevGroup;
			optionGroupByChangeId.set(result.changeId, resolvedGroup);
			if (request.replaceAll) {
				replacedInTurnChangeIds.add(result.changeId);
				localSourceByChangeId.delete(result.changeId);
			}
			const prevChangeOps = request.replaceAll ? [] : (stagedOpsByChangeId.get(result.changeId) ?? []);
			stagedOpsByChangeId.set(result.changeId, [...prevChangeOps, ...request.ops]);
			const perChangeLocal = localSourceByChangeId.get(result.changeId);
			if (perChangeLocal) {
				for (const op of request.ops) {
					const rel = normalizeStudioRelativePath(op.path, folderRoot);
					if (rel) perChangeLocal.delete(`${folderRoot}/${rel}`);
				}
			}
			const includeInDefault = !resolvedGroup || result.changeId === replyChangeId;
			if (includeInDefault) {
				applyStudioTextOps(stagedText, request.ops, folderRoot);
				for (const op of request.ops) {
					const rel = normalizeStudioRelativePath(op.path, folderRoot);
					if (!rel) continue;
					const full = `${folderRoot}/${rel}`;
					localSourceByPath.delete(full);
					if (op.op === "delete" || op.op === "write_text" || op.op === "merge_json") {
						stagedBinaries.delete(rel);
					} else if (op.op === "write_file") {
						stagedText.delete(rel);
						const cached = stagedBytesBySha.get(op.file.fileSha256);
						if (cached) stagedBinaries.set(rel, cached);
						else stagedBinaries.delete(rel);
					}
				}
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
			hasCompanySearch: Boolean(folder && folderSearch),
			hasReadOnlyData: Boolean(folder),
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
		"This session runs on a coding machine where the entire company folder (every active Interface listed under Company Interfaces) is mounted read-only at /company and /tmp is writable for scripts, Node/Python tooling, 3D GLB model generation (use Blender if installed, or Python/Node glTF 2.0 scripts), and headless Chromium visual verification.",
		`Never try to write directly into /company/${folderRoot}/ from shell commands (the mount refuses direct writes); use company_search to find files across the whole company, data_describe and data_query to inspect company databases under /company/data/, company_read and company_list to read files with active Preview overlays, stage every change under ${folderRoot}/ via stage_surface_patch, and write working notes under ${notesRoot}/ via company_write.`,
		...(isInternalReconciliation
			? [
					"When finished staging the combined resolution via stage_surface_patch, call coding_finish with a concise summary (omitting headSha). Never call coding_ask.",
				]
			: [
					`Visual, 3D, and inspection tools: keep the native Studio starter tabs and blocks rather than replacing Overview with a custom module iframe. Use compose_surface_layout to add, update, remove, or reorder tabs and blocks (including interactive chart blocks)${hasMakePicture ? ", use make_picture for bespoke concept renders" : ""}, use stage_surface_artifact to stage visual or binary files generated in /tmp (PNG/JPG/WebP, SVG, HTML, PDF, multi-part PBR GLB 3D models, MP3/WAV) straight into Preview (omitting title and summary when attaching to an existing changeId so you preserve its title and summary), and call inspect_surface (passing changeId when checking an optionGroup variant) after staging to visually audit the rendered page before calling coding_finish.`,
					"Every turn MUST end with coding_finish (with operationKey, summary, and optional notePaths; omit headSha) or coding_ask when a founder decision is required; never end with plain text alone.",
				]),
		...(newDisk ? [NEW_DISK_SURFACE_NOTE] : []),
	].join("\n\n");
	const claudeSystemNote = [
		rewriteSurfaceReplyMentions(rawStudioInstructions, "mcp__qorpera__coding_finish"),
		"Your native tools (Bash, Read, Grep, Glob) run on the coding machine with the entire company folder (every active Interface listed under Company Interfaces) mounted read-only at /company and /tmp writable for scripts, Node/Python, 3D GLB model generation (using Blender when installed, or Python/Node glTF 2.0 scripts), and headless Chromium visual verification.",
		`Never try to modify /company directly with Bash, Edit, or Write (the mount refuses direct writes). Use mcp__qorpera__company_search to search across the whole company, mcp__qorpera__data_describe and mcp__qorpera__data_query to inspect company databases read-only, mcp__qorpera__company_read and mcp__qorpera__company_list when you need active Preview overlay contents, stage every file change under ${folderRoot}/ through mcp__qorpera__stage_surface_patch, and write working notes under ${notesRoot}/ through mcp__qorpera__company_write.`,
		...(isInternalReconciliation
			? [
					"When finished staging the combined resolution via mcp__qorpera__stage_surface_patch, call mcp__qorpera__coding_finish with operationKey and a concise summary. Never call coding_ask.",
				]
			: [
					`Visual, 3D, and inspection tools: keep the native Studio starter tabs and blocks rather than replacing Overview with a custom module iframe. Use mcp__qorpera__compose_surface_layout to add, update, remove, or reorder tabs and blocks (including interactive chart blocks)${hasMakePicture ? ", use mcp__qorpera__make_picture for bespoke concept renders" : ""}, use mcp__qorpera__stage_surface_artifact to stage visual or binary files generated in /tmp (PNG/JPG/WebP, SVG, HTML, PDF, multi-part PBR GLB 3D models, MP3/WAV) straight into Preview (omitting title and summary when attaching to an existing changeId so you preserve its title and summary), and call mcp__qorpera__inspect_surface (passing changeId when checking an optionGroup variant) after staging to inspect a real rendered screenshot before calling mcp__qorpera__coding_finish.`,
					"Every turn MUST end with mcp__qorpera__coding_finish (with operationKey, summary, and optional notePaths) or mcp__qorpera__coding_ask when a founder decision is required; ending with plain text alone fails the turn.",
				]),
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
		buildTools: (identity, operations, codingMachine) => {
			const patchTracker = createSurfacePatchSessionTracker({
				openChanges: sessionOpenChanges,
				replyChangeId,
				isInternalReconciliation,
				folderRoot,
			});
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
					tracker: patchTracker,
				},
			);
			const voicePort = surfaceSession.narrateExplainer;
			const synthesizeChatGptVoice =
				voicePort?.synthesizeChatGptVoice ??
				(voicePort?.voiceChannel && codingMachine
					? ({
							callId,
							voiceName: chatVoice,
							captions,
							signal: reqSignal,
						}: {
							readonly callId?: string;
							readonly voiceName?: CloudVoiceName;
							readonly captions: readonly { readonly hash: string; readonly text: string }[];
							readonly signal: AbortSignal;
						}) =>
							recordStudioChatGptVoiceClips({
								voice: voicePort.voiceChannel!,
								machine: codingMachine,
								callId: callId ?? "narrate",
								...(chatVoice ? { voiceName: chatVoice } : {}),
								captions,
								signal: reqSignal,
							})
					: undefined);
			const narrateTool =
				!isInternalReconciliation && voicePort
					? [
							createNarrateExplainerTool({
								sessionId: surfaceSession.sessionId,
								folderRoot,
								voiceModel: surfaceSession.voiceModel?.trim() || "chatgpt-voice",
								voiceName: surfaceSession.voiceName?.trim() || "cove",
								readStudioText,
								stageBytes: voicePort.stageBytes,
								surfacePatch: trackedSurfacePatch,
								...(voicePort.synthesizeGemini ? { synthesizeGemini: voicePort.synthesizeGemini } : {}),
								...(synthesizeChatGptVoice ? { synthesizeChatGptVoice } : {}),
								onStagedOps: (ops) => applyStudioTextOps(stagedText, ops, folderRoot),
							}),
						]
					: [];
			const pictureTool =
				hasMakePicture && pictures && trackedStageBytes
					? [
							createStudioPictureTool({
								sessionId: surfaceSession.sessionId,
								folderRoot,
								stageBytes: trackedStageBytes,
								surfacePatch: trackedSurfacePatch,
								pictures,
								patchTracker,
							}),
						]
					: [];
			const readCurrentLayoutTextStrict = async (reqSignal: AbortSignal): Promise<string | null> => {
				if (stagedText.has(SURFACE_LAYOUT_PATH)) return stagedText.get(SURFACE_LAYOUT_PATH) ?? null;
				if (!effectiveFolderReader) {
					throw new Error("SURFACE_FOLDER_UNAVAILABLE");
				}
				return folderText(
					effectiveFolderReader,
					`${folderRoot}/${SURFACE_LAYOUT_PATH}`,
					MAX_STAGED_LAYOUT_READ_BYTES,
					reqSignal,
				);
			};
			const composeLayoutTool =
				!isInternalReconciliation && view.page !== "report"
					? [
							createComposeSurfaceLayoutTool({
								sessionId: surfaceSession.sessionId,
								starter: view.page === "layout" ? view.starter : "custom",
								readCurrentLayoutText: readCurrentLayoutTextStrict,
								surfacePatch: trackedSurfacePatch,
								patchTracker,
							}),
						]
					: [];
			const stageArtifactTool =
				!isInternalReconciliation && codingMachine && trackedStageBytes
					? [
							createStageSurfaceArtifactTool({
								sessionId: surfaceSession.sessionId,
								folderRoot,
								machine: codingMachine,
								stageBytes: trackedStageBytes,
								surfacePatch: trackedSurfacePatch,
								patchTracker,
								onStagedSource: ({ destPath, sourcePath, fileSha256, changeId }) => {
									const rel = normalizeStudioRelativePath(destPath, folderRoot);
									if (!rel) return;
									const full = `${folderRoot}/${rel}`;
									const asset: StudioInspectLocalAsset = { sourcePath, sha256: fileSha256 };
									let perChange = localSourceByChangeId.get(changeId);
									if (!perChange) {
										perChange = new Map<string, StudioInspectLocalAsset>();
										localSourceByChangeId.set(changeId, perChange);
									}
									perChange.set(full, asset);
									const group = optionGroupByChangeId.get(changeId) ?? null;
									if (!group || changeId === replyChangeId) {
										localSourceByPath.set(full, asset);
									}
								},
							}),
						]
					: [];
			const inspectSurfaceTool =
				!isInternalReconciliation && codingMachine
					? [
							createInspectSurfaceTool({
								machine: codingMachine,
								...(folder
									? {
											ask: studioInspectAsker(cloudDataTools({ folder, door: companyData, apply: false })),
										}
									: {}),
								loadSnapshot: async (reqSignal, inspectOptions) => {
									const files: Record<string, string> = { ...baseContentsFiles };
									const knownBinaries: Record<string, StudioInspectBinaryMeta> = {};
									for (const [fullPath, ref] of Object.entries(contents?.binaries ?? {})) {
										knownBinaries[fullPath] = {
											bytes: ref.bytes,
											mediaType: ref.mediaType,
											inCompanyMount: true,
										};
									}
									const targetChangeId = inspectOptions?.changeId;
									const replacedTargetPrior =
										targetChangeId && replacedInTurnChangeIds.has(targetChangeId)
											? sessionOpenChanges.find((ch) => ch.changeId === targetChangeId)
											: undefined;
									const excludePriorFromOwn = Boolean(
										replacedTargetPrior &&
											(!replacedTargetPrior.optionGroupKey ||
												replacedTargetPrior.changeId === replyChangeId),
									);
									let readOverlay = turnReadOverlay;
									if (excludePriorFromOwn && baseReaderForPatch) {
										const remainingOpen = sessionOpenChanges.filter((ch) => ch.changeId !== targetChangeId);
										const filteredOwn = remainingOpen.some((ch) => ch.kind === "folder_patch")
											? createSurfaceSessionOwnOverlay({
													folderRoot,
													sessionOpenChanges: remainingOpen,
													baseReader: baseReaderForPatch,
													replyChangeId,
												})
											: null;
										if (filteredOwn) await filteredOwn.prepare(reqSignal);
										readOverlay = chainFolderPreviewOverlays(externalPreviewOverlay, filteredOwn);
									}
									if (readOverlay) {
										const overlayCandidates = new Set<string>([
											`${folderRoot}/${SURFACE_LAYOUT_PATH}`,
											IDENTITY_TOKENS_CSS_PATH,
										]);
										for (const change of [...previewBaseChanges, ...sessionOpenChanges]) {
											for (const p of change.affectedPaths) {
												const clean = p.replace(/^\/+|\/+$/g, "");
												if (!clean) continue;
												overlayCandidates.add(
													clean.startsWith(`${folderRoot}/`) ? clean : `${folderRoot}/${clean}`,
												);
											}
										}
										for (const candidate of overlayCandidates) {
											const looked = await readOverlay.lookup(candidate, reqSignal);
											if (looked?.kind === "file") {
												files[candidate] = looked.content;
												delete knownBinaries[candidate];
											} else if (looked?.kind === "deleted") {
												delete files[candidate];
												delete knownBinaries[candidate];
											}
										}
									}
									for (const change of previewBaseChanges) {
										for (const op of change.patchManifest ?? []) {
											const rel = normalizeStudioRelativePath(op.path, folderRoot);
											if (!rel) continue;
											const full = `${folderRoot}/${rel}`;
											if (op.op === "write_file") {
												delete files[full];
												knownBinaries[full] = {
													bytes: op.file.bytes,
													mediaType: op.file.mediaType,
													inCompanyMount: false,
												};
											} else if (op.op === "delete" || op.op === "write_text" || op.op === "merge_json") {
												delete knownBinaries[full];
											}
										}
									}
									for (const change of sessionOpenChanges) {
										if (change.optionGroupKey && change.changeId !== replyChangeId) continue;
										if (excludePriorFromOwn && change.changeId === targetChangeId) continue;
										for (const op of change.patchManifest ?? []) {
											const rel = normalizeStudioRelativePath(op.path, folderRoot);
											if (!rel) continue;
											const full = `${folderRoot}/${rel}`;
											if (op.op === "write_file") {
												delete files[full];
												knownBinaries[full] = {
													bytes: op.file.bytes,
													mediaType: op.file.mediaType,
													inCompanyMount: false,
												};
											} else if (op.op === "delete" || op.op === "write_text" || op.op === "merge_json") {
												delete knownBinaries[full];
											}
										}
									}
									for (const [rel, val] of stagedText) {
										const full = `${folderRoot}/${rel}`;
										delete knownBinaries[full];
										if (val === null) delete files[full];
										else files[full] = val;
									}
									const binaries: Record<string, { readonly bytes: Uint8Array; readonly mediaType: string }> =
										{};
									for (const [rel, entry] of stagedBinaries) {
										const full = `${folderRoot}/${rel}`;
										delete files[full];
										binaries[full] = entry;
										knownBinaries[full] = {
											bytes: entry.bytes.byteLength,
											mediaType: entry.mediaType,
											inCompanyMount: false,
										};
									}
									const localAssetPaths: Record<string, StudioInspectLocalAsset> = {};
									for (const [full, asset] of localSourceByPath) {
										localAssetPaths[full] = asset;
									}
									if (targetChangeId) {
										const priorOpen = sessionOpenChanges.find((ch) => ch.changeId === targetChangeId);
										const replacedInTurn = replacedInTurnChangeIds.has(targetChangeId);
										const turnOps = stagedOpsByChangeId.get(targetChangeId) ?? [];
										const combinedOps = [
											...(replacedInTurn ? [] : (priorOpen?.patchManifest ?? [])),
											...turnOps,
										];
										if (combinedOps.length > 0) {
											const variantText = new Map<string, string | null>();
											for (const [full, content] of Object.entries(files)) {
												const rel = normalizeStudioRelativePath(full, folderRoot);
												if (rel) variantText.set(rel, content);
											}
											applyStudioTextOps(variantText, combinedOps, folderRoot);
											for (const op of combinedOps) {
												const rel = normalizeStudioRelativePath(op.path, folderRoot);
												if (!rel) continue;
												const full = `${folderRoot}/${rel}`;
												if (op.op === "write_file") {
													delete files[full];
													delete localAssetPaths[full];
													const cached = stagedBytesBySha.get(op.file.fileSha256);
													if (cached) binaries[full] = cached;
													else delete binaries[full];
													knownBinaries[full] = {
														bytes: op.file.bytes,
														mediaType: op.file.mediaType,
														inCompanyMount: false,
													};
												} else {
													delete binaries[full];
													delete knownBinaries[full];
													delete localAssetPaths[full];
													const updated = variantText.get(rel);
													if (updated === null || updated === undefined) delete files[full];
													else files[full] = updated;
												}
											}
										}
										const changeLocal = localSourceByChangeId.get(targetChangeId);
										if (changeLocal) {
											for (const [full, asset] of changeLocal) {
												localAssetPaths[full] = asset;
											}
										}
									}
									return {
										surfaceTitle: surfaceSession.surfaceTitle,
										folderRoot,
										starter: view.page === "layout" ? view.starter : "custom",
										files,
										binaries,
										knownBinaries,
										localAssetPaths,
									};
								},
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
						surfaceFilePolicy: {
							mode: "surface_worker",
							writableRoots,
							stagedRoots,
							savesQuestions:
								!isInternalReconciliation && view.page === "layout" && view.starter === "analytics",
						},
						...(turnReadOverlay ? { previewOverlay: turnReadOverlay } : {}),
					}).filter((tool) => STUDIO_FOLDER_TOOLS.has(tool.name))
				: [];
			const searchTools =
				folder && folderSearch
					? [cloudFolderSearchTool({ search: folderSearch, folder, runId: identity.runId })]
					: [];
			const dataTools = folder
				? cloudDataTools({ folder, door: companyData, apply: false }).filter((tool) =>
						READ_ONLY_DATA_TOOLS.has(tool.name),
					)
				: [];
			const skillTools = surfaceSession.readSkillTools ? surfaceSession.readSkillTools(operations, identity) : [];
			return [
				stagePatchTool,
				...composeLayoutTool,
				...stageArtifactTool,
				...inspectSurfaceTool,
				...narrateTool,
				...pictureTool,
				...viewAttachmentTool,
				...folderTools,
				...searchTools,
				...dataTools,
				...skillTools,
			];
		},
	};
}
