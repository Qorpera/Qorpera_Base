import {
	parseStudioTourDocument,
	readSurfaceTalk,
	type StudioBinaryRef,
	type StudioPatchOp,
	SURFACE_TALK_FILE,
	studioTourCaptionTexts,
	surfaceTalkSpokenLines,
} from "@qorpera/contracts";
import { captionHash, explainerSaid } from "./cloud-app-kit-explainer.ts";
import { GeminiCapReachedError, GeminiKeyRevokedError } from "./cloud-gemini-tool-session.ts";
import {
	DEFAULT_GEMINI_TTS_VOICE,
	type GeminiTtsModel,
	type GeminiTtsSpeechResult,
	type GeminiTtsVoice,
	isGeminiTtsModel,
	isGeminiTtsVoice,
} from "./cloud-gemini-tts.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { StudioChatGptVoiceBatchResult } from "./cloud-studio-voice-recorder.ts";
import type { SurfacePatchToolPort } from "./cloud-surface-tools.ts";
import { CLOUD_VOICE_NAMES, type CloudVoiceName, isCloudVoiceName } from "./cloud-voice-channel.ts";

const MAX_UNIQUE_CAPTIONS = 120;
const MAX_CLIPS_PER_CALL = 48;
const SYNTHESIS_CONCURRENCY = 3;
const CAPTION_HASH_RE = /^[0-9a-f]{8}$/;
const CLIP_AUDIO_EXTS = new Set(["wav", "mp4", "m4a", "mp3", "webm"]);
const CLIP_MAX_SECONDS = 60;

export interface StudioExplainerClipRecord {
	readonly caption: string;
	readonly file: string;
	readonly seconds: number;
}

export interface StudioNarrateToolOptions {
	readonly sessionId: string;
	readonly folderRoot: string;
	readonly voiceModel: string;
	readonly voiceName: string;
	readonly readStudioText: (relativePath: string, signal: AbortSignal) => Promise<string | null>;
	readonly stageBytes: (bytes: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<StudioBinaryRef>;
	readonly surfacePatch: SurfacePatchToolPort;
	readonly synthesizeGemini?: (input: {
		readonly model: GeminiTtsModel;
		readonly voiceName: GeminiTtsVoice;
		readonly text: string;
		readonly signal: AbortSignal;
	}) => Promise<GeminiTtsSpeechResult>;
	readonly synthesizeChatGptVoice?: (input: {
		readonly callId?: string;
		readonly voiceName?: CloudVoiceName;
		readonly captions: readonly { readonly hash: string; readonly text: string }[];
		readonly signal: AbortSignal;
	}) => Promise<StudioChatGptVoiceBatchResult>;
	readonly onStagedOps?: (ops: readonly StudioPatchOp[]) => void;
}

interface NarrateExplainerArgs {
	readonly scenesPath: string;
	readonly title: string;
	readonly summary: string;
	readonly voiceName?: string;
}

function normalizeRelativeScenesPath(raw: unknown, folderRoot: string): string {
	if (typeof raw !== "string") throw new CloudToolArgumentRefusal("scenesPath must be a string");
	let trimmed = raw.trim().replace(/^\/+/, "");
	const prefix = `${folderRoot.replace(/^\/+|\/+$/g, "")}/`;
	if (prefix.length > 1 && trimmed.startsWith(prefix)) {
		trimmed = trimmed.slice(prefix.length);
	}
	if (!trimmed || trimmed.length > 256 || trimmed.includes("\\") || trimmed.includes("\0")) {
		throw new CloudToolArgumentRefusal("scenesPath is invalid");
	}
	const parts = trimmed.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new CloudToolArgumentRefusal("scenesPath must be a clean relative path inside the interface folder");
	}
	const kind = narratedKind(trimmed);
	if (kind === undefined) {
		throw new CloudToolArgumentRefusal(
			`scenesPath must point to a .js scenes file, tour.json or a talk's ${SURFACE_TALK_FILE} (for example breakdowns/ux/scenes.js, tour.json or talks/what-we-found/${SURFACE_TALK_FILE})`,
		);
	}
	return trimmed;
}

type NarratedKind = "scenes" | "tour" | "talk";

function narratedKind(relativePath: string): NarratedKind | undefined {
	const name = relativePath.toLowerCase().split("/").at(-1) ?? "";
	if (name === "tour.json") return "tour";
	if (name === SURFACE_TALK_FILE) return "talk";
	return name.endsWith(".js") ? "scenes" : undefined;
}

function talkCaptionEntries(path: string, text: string): readonly { readonly hash: string; readonly text: string }[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new CloudToolRefusal(`INVALID_TALK: ${path} is not valid JSON`);
	}
	const read = readSurfaceTalk(parsed);
	if (!read.talk) {
		const problems = read.problems.join("; ").replace(/[^\u0020-\u007e]/g, "?");
		throw new CloudToolRefusal(
			`INVALID_TALK: ${path} does not pass the talk check, so it gets no voice: ${problems.length > 700 ? `${problems.slice(0, 697)}...` : problems}`,
		);
	}
	if (read.talk.state !== "made") {
		throw new CloudToolRefusal(
			`TALK_NOT_MADE: ${path} has no pictures yet; a talk gets its voice after the founder has seen it with captions and asked for the voice`,
		);
	}
	const seen = new Set<string>();
	return surfaceTalkSpokenLines(read.talk).flatMap((line) => {
		const hash = captionHash(line.trim());
		if (seen.has(hash)) return [];
		seen.add(hash);
		return [{ hash, text: line.trim() }];
	});
}

function dirOf(relativePath: string): string {
	const slash = relativePath.lastIndexOf("/");
	return slash < 0 ? "" : relativePath.slice(0, slash);
}

function joinRel(dir: string, rel: string): string {
	return dir ? `${dir}/${rel}` : rel;
}

function isCaptionClipFile(caption: string, file: string): boolean {
	const dot = file.lastIndexOf(".");
	if (dot <= 0) return false;
	return file.slice(0, dot) === caption && CLIP_AUDIO_EXTS.has(file.slice(dot + 1));
}

function parseExistingClips(text: string | null): Map<string, StudioExplainerClipRecord> {
	const out = new Map<string, StudioExplainerClipRecord>();
	if (!text) return out;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return out;
	}
	const list =
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		Array.isArray((parsed as { clips?: unknown }).clips)
			? (parsed as { clips: unknown[] }).clips
			: [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const caption = typeof rec.caption === "string" ? rec.caption : "";
		const file = typeof rec.file === "string" ? rec.file : "";
		const seconds = typeof rec.seconds === "number" ? rec.seconds : Number.NaN;
		if (
			!CAPTION_HASH_RE.test(caption) ||
			!isCaptionClipFile(caption, file) ||
			!Number.isFinite(seconds) ||
			seconds <= 0 ||
			seconds > CLIP_MAX_SECONDS
		) {
			continue;
		}
		if (!out.has(caption)) out.set(caption, { caption, file, seconds: Math.round(seconds * 100) / 100 });
	}
	return out;
}

export function extractExplainerCaptionEntries(
	scenesJs: string,
): readonly { readonly hash: string; readonly text: string }[] {
	const said = explainerSaid(scenesJs);
	const out: { readonly hash: string; readonly text: string }[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		const text = raw.trim();
		if (!text) return;
		const hash = captionHash(text);
		if (seen.has(hash)) return;
		seen.add(hash);
		out.push({ hash, text });
	};
	for (const item of said) {
		if (item.languages) {
			for (const text of Object.values(item.languages)) push(text);
		} else {
			push(item.text);
		}
	}
	return out;
}

export function createNarrateExplainerTool(options: StudioNarrateToolOptions): CloudNativeTool {
	const parseArgs = (value: unknown): NarrateExplainerArgs => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new CloudToolArgumentRefusal("narrate_explainer arguments must be an object");
		}
		const rec = value as Record<string, unknown>;
		const scenesPath = normalizeRelativeScenesPath(rec.scenesPath, options.folderRoot);
		const title =
			rec.title === undefined
				? "Narrate breakdown"
				: typeof rec.title === "string" && rec.title.trim().length > 0 && rec.title.trim().length <= 120
					? rec.title.trim()
					: null;
		if (title === null) throw new CloudToolArgumentRefusal("title must be 1..120 characters");
		const summary =
			rec.summary === undefined
				? "Recorded spoken narration clips for the animated breakdown."
				: typeof rec.summary === "string" && rec.summary.trim().length > 0 && rec.summary.trim().length <= 500
					? rec.summary.trim()
					: null;
		if (summary === null) throw new CloudToolArgumentRefusal("summary must be 1..500 characters");
		const voiceName =
			rec.voiceName === undefined
				? undefined
				: typeof rec.voiceName === "string" && rec.voiceName.trim().length > 0 && rec.voiceName.trim().length <= 64
					? rec.voiceName.trim()
					: null;
		if (voiceName === null) throw new CloudToolArgumentRefusal("voiceName must be 1..64 characters");
		return {
			scenesPath,
			title,
			summary,
			...(voiceName ? { voiceName } : {}),
		};
	};
	return {
		name: "narrate_explainer",
		source: "runtime",
		description: `Synthesize spoken narration clips for an animated breakdown (scenes.js), a guided Studio voice tour (tour.json) or a talk (talks/<name>/${SURFACE_TALK_FILE}) using the member's configured Voice model and voice profile, and stage the audio clips plus voice/clips.json into the interface's Preview. Only captions missing clips are synthesized; existing clips are reused by caption hash. A talk is recorded only after the founder has asked for its voice; its captions always stay on.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["scenesPath"],
			properties: {
				scenesPath: {
					type: "string",
					minLength: 4,
					maxLength: 256,
					description: `Relative path to scenes.js, tour.json or a talk's ${SURFACE_TALK_FILE} inside this interface folder (e.g. breakdowns/buyer-ux/scenes.js, tour.json or talks/what-we-found/${SURFACE_TALK_FILE}).`,
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: 120,
					description: "Short change title shown in Changes (default: Narrate breakdown).",
				},
				summary: {
					type: "string",
					minLength: 1,
					maxLength: 500,
					description: "Concise founder-facing summary of the staged narration.",
				},
				voiceName: {
					type: "string",
					minLength: 1,
					maxLength: 64,
					description:
						"Optional voice profile override for the active voice model; omit to use the member's default voice.",
				},
			},
		},
		parseArguments(value) {
			const args = parseArgs(value);
			return {
				scenesPath: args.scenesPath,
				title: args.title,
				summary: args.summary,
				...(args.voiceName ? { voiceName: args.voiceName } : {}),
			};
		},
		async execute(rawArgs, context: CloudToolContext) {
			const args = parseArgs(rawArgs);
			const signal = context.signal;
			const scenesJs = await options.readStudioText(args.scenesPath, signal);
			if (!scenesJs || !scenesJs.trim()) {
				throw new CloudToolRefusal(
					`SCENES_NOT_FOUND: ${args.scenesPath} was not found; stage it with stage_surface_patch before calling narrate_explainer`,
				);
			}
			const kind = narratedKind(args.scenesPath);
			const isTour = kind === "tour";
			const captions =
				kind === "talk"
					? talkCaptionEntries(args.scenesPath, scenesJs)
					: isTour
						? (() => {
								const doc = parseStudioTourDocument(scenesJs);
								if (!doc) {
									throw new CloudToolRefusal(
										`INVALID_TOUR: ${args.scenesPath} is not a valid tour.json document with spoken beats`,
									);
								}
								return studioTourCaptionTexts(doc).map((text) => ({ hash: captionHash(text), text }));
							})()
						: extractExplainerCaptionEntries(scenesJs);
			if (captions.length === 0) {
				throw new CloudToolRefusal(
					isTour || kind === "talk"
						? `NO_CAPTIONS: no spoken "say" lines were found in ${args.scenesPath}; add them and stage the file first`
						: 'NO_CAPTIONS: no s.say("...") captions were found in scenes.js; add spoken captions and stage scenes.js first',
				);
			}
			if (captions.length > MAX_UNIQUE_CAPTIONS) {
				throw new CloudToolRefusal(
					`TOO_MANY_CAPTIONS: ${args.scenesPath} has ${captions.length} unique captions (max ${MAX_UNIQUE_CAPTIONS}); trim it to one focused story`,
				);
			}

			const dir = dirOf(args.scenesPath);
			const clipsPath = joinRel(dir, "voice/clips.json");
			const existing = parseExistingClips(await options.readStudioText(clipsPath, signal));
			const missing = captions.filter((entry) => !existing.has(entry.hash));
			const reused = captions.length - missing.length;

			if (missing.length === 0) {
				return {
					kind: "text",
					value: JSON.stringify({
						ok: true,
						state: "spoken",
						voiceModel: options.voiceModel,
						voiceName: args.voiceName ?? options.voiceName,
						spokenNow: 0,
						reused,
						left: 0,
						total: captions.length,
						scenesPath: args.scenesPath,
						clipsPath,
					}),
				};
			}

			if (!isGeminiTtsModel(options.voiceModel)) {
				const requestedVoice = args.voiceName ?? options.voiceName;
				if (args.voiceName && !isCloudVoiceName(args.voiceName)) {
					throw new CloudToolArgumentRefusal(
						`voiceName must be one of ${CLOUD_VOICE_NAMES.join(", ")} for ${options.voiceModel}`,
					);
				}
				const resolvedChatGptVoice: CloudVoiceName | undefined = isCloudVoiceName(requestedVoice)
					? requestedVoice
					: undefined;
				if (!options.synthesizeChatGptVoice) {
					return {
						kind: "text",
						value: JSON.stringify({
							ok: false,
							state: "unsupported_in_studio",
							voiceModel: options.voiceModel,
							voiceName: resolvedChatGptVoice ?? requestedVoice,
							spokenNow: 0,
							reused,
							left: missing.length,
							total: captions.length,
							message:
								"ChatGPT Voice is unavailable in this session because no connected Codex voice lane is active. The walkthrough plays with captions alone; connect a Codex/ChatGPT subscription voice or switch Settings → Default models → Voice to a Gemini TTS model.",
						}),
					};
				}
				const batch = missing.slice(0, MAX_CLIPS_PER_CALL);
				const voiceResult = await options.synthesizeChatGptVoice({
					callId: context.callId,
					...(resolvedChatGptVoice ? { voiceName: resolvedChatGptVoice } : {}),
					captions: batch,
					signal,
				});
				if (signal.aborted) throw signal.reason;
				const recorded = new Map<
					string,
					{ readonly clip: StudioExplainerClipRecord; readonly op: StudioPatchOp }
				>();
				for (const item of voiceResult.clips) {
					const ref = await options.stageBytes(item.audio, item.mediaType, signal);
					const closedRef: StudioBinaryRef = {
						manifestSha256: ref.manifestSha256,
						fileSha256: ref.fileSha256,
						bytes: ref.bytes,
						mediaType: ref.mediaType,
					};
					const file = `${item.hash}.${item.fileExtension}`;
					const clipPath = joinRel(dir, `voice/${file}`);
					recorded.set(item.hash, {
						clip: {
							caption: item.hash,
							file,
							seconds: Math.min(CLIP_MAX_SECONDS, Math.max(0.01, Math.round(item.seconds * 100) / 100)),
						},
						op: { op: "write_file", path: clipPath, file: closedRef },
					});
				}
				if (recorded.size === 0) {
					return {
						kind: "text",
						value: JSON.stringify({
							ok: false,
							state: voiceResult.stopReason ?? "unavailable",
							voiceModel: options.voiceModel,
							voiceName: resolvedChatGptVoice ?? requestedVoice,
							spokenNow: 0,
							reused,
							left: missing.length,
							total: captions.length,
							message:
								voiceResult.stopReason === "limit_reached"
									? "The connected ChatGPT voice usage limit was reached before recording new clips. Try again after the reset."
									: `ChatGPT Voice could not record clips (${voiceResult.errorMessage ?? "voice unavailable"}). The walkthrough plays with captions alone.`,
							...(voiceResult.silent?.length ? { silent: voiceResult.silent } : {}),
						}),
					};
				}
				const finalClips: StudioExplainerClipRecord[] = [];
				const ops: StudioPatchOp[] = [];
				for (const caption of captions) {
					const added = recorded.get(caption.hash);
					if (added) {
						finalClips.push(added.clip);
						ops.push(added.op);
						continue;
					}
					const kept = existing.get(caption.hash);
					if (kept) finalClips.push(kept);
				}
				ops.push({
					op: "write_text",
					path: clipsPath,
					content: `${JSON.stringify({ clips: finalClips }, null, 2)}\n`,
				});
				const staged = await options.surfacePatch.stageSurfacePatch(
					options.sessionId,
					{
						title: args.title,
						summary: args.summary,
						ops,
						notePaths: [],
						finishSession: false,
					},
					context,
				);
				options.onStagedOps?.(ops);
				const left = captions.length - finalClips.length;
				const state =
					voiceResult.stopReason === "limit_reached"
						? "limit_reached"
						: voiceResult.stopReason === "error" || left > 0
							? "partly_spoken"
							: "spoken";
				return {
					kind: "text",
					value: JSON.stringify({
						ok: true,
						state,
						voiceModel: options.voiceModel,
						voiceName: resolvedChatGptVoice ?? requestedVoice,
						spokenNow: recorded.size,
						reused,
						left,
						total: captions.length,
						scenesPath: args.scenesPath,
						clipsPath,
						changeId: staged.changeId,
						...(voiceResult.silent?.length ? { silent: voiceResult.silent } : {}),
					}),
				};
			}

			const chosenVoice = args.voiceName ?? options.voiceName;
			const resolvedVoice: GeminiTtsVoice = isGeminiTtsVoice(chosenVoice)
				? chosenVoice
				: args.voiceName
					? (() => {
							throw new CloudToolArgumentRefusal(
								`voiceName "${args.voiceName}" is not a valid voice profile for ${options.voiceModel}`,
							);
						})()
					: DEFAULT_GEMINI_TTS_VOICE;

			if (!options.synthesizeGemini) {
				return {
					kind: "text",
					value: JSON.stringify({
						ok: false,
						state: "unavailable",
						voiceModel: options.voiceModel,
						voiceName: resolvedVoice,
						spokenNow: 0,
						reused,
						left: missing.length,
						total: captions.length,
						message:
							"Voice narration is unavailable in this session because no active Gemini API key could be opened. The breakdown plays with captions alone.",
					}),
				};
			}

			const batch = missing.slice(0, MAX_CLIPS_PER_CALL);
			const recorded = new Map<string, { readonly clip: StudioExplainerClipRecord; readonly op: StudioPatchOp }>();
			let stopReason: "cap_reached" | "revoked" | "error" | null = null;
			let firstError: unknown;
			let nextIndex = 0;
			const batchAbort = new AbortController();
			const onOuterAbort = () => batchAbort.abort();
			if (signal.aborted) {
				batchAbort.abort();
			} else {
				signal.addEventListener("abort", onOuterAbort, { once: true });
			}

			const worker = async (): Promise<void> => {
				while (!batchAbort.signal.aborted && stopReason === null) {
					const idx = nextIndex++;
					if (idx >= batch.length) return;
					const caption = batch[idx]!;
					try {
						const speech = await options.synthesizeGemini!({
							model: options.voiceModel as GeminiTtsModel,
							voiceName: resolvedVoice,
							text: caption.text,
							signal: batchAbort.signal,
						});
						if (signal.aborted) return;
						const ref = await options.stageBytes(speech.audio, speech.mediaType, signal);
						const closedRef: StudioBinaryRef = {
							manifestSha256: ref.manifestSha256,
							fileSha256: ref.fileSha256,
							bytes: ref.bytes,
							mediaType: ref.mediaType,
						};
						const file = `${caption.hash}.${speech.fileExtension}`;
						const clipPath = joinRel(dir, `voice/${file}`);
						recorded.set(caption.hash, {
							clip: {
								caption: caption.hash,
								file,
								seconds: Math.min(CLIP_MAX_SECONDS, Math.max(0.01, Math.round(speech.seconds * 100) / 100)),
							},
							op: { op: "write_file", path: clipPath, file: closedRef },
						});
					} catch (error) {
						if (error instanceof GeminiCapReachedError) {
							stopReason = "cap_reached";
							batchAbort.abort();
							return;
						}
						if (error instanceof GeminiKeyRevokedError) {
							stopReason = "revoked";
							batchAbort.abort();
							return;
						}
						if (stopReason === null) {
							stopReason = "error";
							firstError = error;
							batchAbort.abort();
						}
						return;
					}
				}
			};

			try {
				await Promise.all(Array.from({ length: Math.min(SYNTHESIS_CONCURRENCY, batch.length) }, () => worker()));
			} finally {
				signal.removeEventListener("abort", onOuterAbort);
			}

			if (signal.aborted) {
				throw signal.reason ?? firstError ?? new Error("Narration aborted");
			}

			if (recorded.size === 0) {
				if (stopReason === "error" && firstError !== undefined) {
					throw firstError;
				}
				return {
					kind: "text",
					value: JSON.stringify({
						ok: false,
						state: stopReason ?? "unavailable",
						voiceModel: options.voiceModel,
						voiceName: resolvedVoice,
						spokenNow: 0,
						reused,
						left: missing.length,
						total: captions.length,
						message:
							stopReason === "cap_reached"
								? "Your monthly Gemini API spend cap was reached before any narration clip could be recorded. The breakdown plays with captions alone."
								: "Your Gemini API key is unavailable or revoked. The breakdown plays with captions alone.",
					}),
				};
			}

			const finalClips: StudioExplainerClipRecord[] = [];
			const ops: StudioPatchOp[] = [];
			for (const caption of captions) {
				const added = recorded.get(caption.hash);
				if (added) {
					finalClips.push(added.clip);
					ops.push(added.op);
					continue;
				}
				const kept = existing.get(caption.hash);
				if (kept) finalClips.push(kept);
			}
			ops.push({
				op: "write_text",
				path: clipsPath,
				content: `${JSON.stringify({ clips: finalClips }, null, 2)}\n`,
			});

			const staged = await options.surfacePatch.stageSurfacePatch(
				options.sessionId,
				{
					title: args.title,
					summary: args.summary,
					ops,
					notePaths: [],
					finishSession: false,
				},
				context,
			);
			options.onStagedOps?.(ops);

			const left = captions.length - finalClips.length;
			const state =
				stopReason === "error" ? "partly_spoken" : (stopReason ?? (left === 0 ? "spoken" : "partly_spoken"));
			return {
				kind: "text",
				value: JSON.stringify({
					ok: true,
					state,
					voiceModel: options.voiceModel,
					voiceName: resolvedVoice,
					spokenNow: recorded.size,
					reused,
					left,
					total: captions.length,
					changeId: staged.changeId,
					scenesPath: args.scenesPath,
					clipsPath,
					...(stopReason === "error"
						? { error: firstError instanceof Error ? firstError.message : "Speech synthesis stopped early" }
						: {}),
				}),
			};
		},
	};
}
