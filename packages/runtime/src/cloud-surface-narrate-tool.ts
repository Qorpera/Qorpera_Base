import type { StudioBinaryRef, StudioPatchOp } from "@qorpera/contracts";
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
import type { SurfacePatchToolPort } from "./cloud-surface-tools.ts";
import { CLOUD_VOICE_NAMES } from "./cloud-voice-channel.ts";

const MAX_UNIQUE_CAPTIONS = 120;
const MAX_CLIPS_PER_CALL = 48;
const SYNTHESIS_CONCURRENCY = 3;
const CAPTION_HASH_RE = /^[0-9a-f]{8}$/;
const SAFE_CLIP_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

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
	if (!trimmed.toLowerCase().endsWith(".js")) {
		throw new CloudToolArgumentRefusal(
			"scenesPath must point to a .js scenes file (for example breakdowns/ux/scenes.js)",
		);
	}
	return trimmed;
}

function dirOf(relativePath: string): string {
	const slash = relativePath.lastIndexOf("/");
	return slash < 0 ? "" : relativePath.slice(0, slash);
}

function joinRel(dir: string, rel: string): string {
	return dir ? `${dir}/${rel}` : rel;
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
	const list = Array.isArray(parsed)
		? parsed
		: parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				Array.isArray((parsed as { clips?: unknown }).clips)
			? (parsed as { clips: unknown[] }).clips
			: [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const caption = typeof rec.caption === "string" ? rec.caption.trim().toLowerCase() : "";
		const file = typeof rec.file === "string" ? rec.file.trim() : "";
		const seconds = typeof rec.seconds === "number" ? rec.seconds : Number.NaN;
		if (
			!CAPTION_HASH_RE.test(caption) ||
			!SAFE_CLIP_FILE_RE.test(file) ||
			!Number.isFinite(seconds) ||
			seconds <= 0 ||
			seconds > 3600
		) {
			continue;
		}
		if (!out.has(caption)) out.set(caption, { caption, file, seconds });
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
		description:
			"Synthesize spoken narration clips for an animated breakdown's scenes.js using the member's configured Voice model and voice profile, and stage the audio clips plus voice/clips.json into the interface's Preview. Only captions missing clips are synthesized; existing clips are reused by caption hash.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["scenesPath"],
			properties: {
				scenesPath: {
					type: "string",
					minLength: 4,
					maxLength: 256,
					description:
						"Relative path to scenes.js inside this interface folder (e.g. breakdowns/buyer-ux/scenes.js).",
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
			const captions = extractExplainerCaptionEntries(scenesJs);
			if (captions.length === 0) {
				throw new CloudToolRefusal(
					'NO_CAPTIONS: no s.say("...") captions were found in scenes.js; add spoken captions and stage scenes.js first',
				);
			}
			if (captions.length > MAX_UNIQUE_CAPTIONS) {
				throw new CloudToolRefusal(
					`TOO_MANY_CAPTIONS: scenes.js has ${captions.length} unique captions (max ${MAX_UNIQUE_CAPTIONS}); trim the breakdown to one focused story`,
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
				const validChatgpt = args.voiceName
					? (CLOUD_VOICE_NAMES as readonly string[]).includes(args.voiceName)
					: true;
				if (!validChatgpt) {
					throw new CloudToolArgumentRefusal(
						`voiceName must be one of ${CLOUD_VOICE_NAMES.join(", ")} for ${options.voiceModel}`,
					);
				}
				return {
					kind: "text",
					value: JSON.stringify({
						ok: false,
						state: "unsupported_in_studio",
						voiceModel: options.voiceModel,
						voiceName: args.voiceName ?? options.voiceName,
						spokenNow: 0,
						reused,
						left: missing.length,
						total: captions.length,
						message:
							"ChatGPT Voice requires a running company machine and is not available in Studio sessions. The breakdown still plays cleanly with on-screen captions; switch Settings → Default models → Voice to a Gemini TTS model for instant Studio narration.",
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
			let stopReason: "cap_reached" | "revoked" | null = null;
			let nextIndex = 0;

			const worker = async (): Promise<void> => {
				while (!signal.aborted && stopReason === null) {
					const idx = nextIndex++;
					if (idx >= batch.length) return;
					const caption = batch[idx]!;
					try {
						const speech = await options.synthesizeGemini!({
							model: options.voiceModel as GeminiTtsModel,
							voiceName: resolvedVoice,
							text: caption.text,
							signal,
						});
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
							clip: { caption: caption.hash, file, seconds: speech.seconds },
							op: { op: "write_file", path: clipPath, file: closedRef },
						});
					} catch (error) {
						if (error instanceof GeminiCapReachedError) {
							stopReason = "cap_reached";
							return;
						}
						if (error instanceof GeminiKeyRevokedError) {
							stopReason = "revoked";
							return;
						}
						throw error;
					}
				}
			};

			await Promise.all(Array.from({ length: Math.min(SYNTHESIS_CONCURRENCY, batch.length) }, () => worker()));

			if (recorded.size === 0) {
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
				content: `${JSON.stringify(finalClips, null, 2)}\n`,
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
			return {
				kind: "text",
				value: JSON.stringify({
					ok: true,
					state: stopReason ?? (left === 0 ? "spoken" : "partly_spoken"),
					voiceModel: options.voiceModel,
					voiceName: resolvedVoice,
					spokenNow: recorded.size,
					reused,
					left,
					total: captions.length,
					changeId: staged.changeId,
					scenesPath: args.scenesPath,
					clipsPath,
				}),
			};
		},
	};
}
