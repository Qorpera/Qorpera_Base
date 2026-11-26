import { APP_ICONS_FOLDER } from "@qorpera/cloud-client/app-icons";
import {
	isSurfaceOptionGroupKey,
	isUuid,
	type JsonValue,
	type StudioBinaryRef,
	SURFACE_LAYOUT_PATH,
	SURFACE_MAX_CHANGE_SUMMARY_CHARS,
	SURFACE_MAX_CHANGE_TITLE_CHARS,
	SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
} from "@qorpera/contracts";
import { FolderImageRefusal, type FolderImageView, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import {
	CLOUD_PICTURE_MS,
	type CloudPictureChannel,
	CloudPictureFailure,
	type CloudPictureMade,
	CloudPictureUnavailable,
	cloudPictureInput,
	MAX_CLOUD_PICTURE_BYTES,
	MAX_CLOUD_PICTURE_PROMPT_BYTES,
} from "./cloud-picture-channel.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import type { SurfacePatchSessionTracker, SurfacePatchToolPort } from "./cloud-surface-tools.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

export const STUDIO_MAKE_PICTURE_SCHEMA = "qorpera.studio-picture/v1";

const MIB = 1024 * 1024;
const MAX_STUDIO_PICTURE_PATH_CHARS = 256;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PNG_BASENAME = /^(.+)\.png$/i;

export interface StudioPictureToolOptions {
	readonly sessionId: string;
	readonly folderRoot: string;
	readonly stageBytes: (bytes: Uint8Array, mediaType: string, signal: AbortSignal) => Promise<StudioBinaryRef>;
	readonly surfacePatch: SurfacePatchToolPort;
	readonly pictures: CloudPictureChannel;
	readonly patchTracker?: SurfacePatchSessionTracker;
}

interface StudioPictureArgs {
	readonly path: string;
	readonly prompt: string;
	readonly title?: string;
	readonly summary?: string;
	readonly changeId?: string;
	readonly createNew: boolean;
	readonly optionGroup?: string;
	readonly optionGroupTitle?: string;
}

function readablePictureTitle(relPath: string): string {
	const base = relPath.split("/").pop() ?? "";
	const stem = base
		.replace(/\.png$/i, "")
		.replace(/[-_]+/g, " ")
		.trim();
	const label = stem ? `Add ${stem}` : "Add product visual";
	return label.slice(0, SURFACE_MAX_CHANGE_TITLE_CHARS);
}

export function normalizeStudioPicturePath(raw: unknown, folderRoot: string): string {
	if (typeof raw !== "string") throw new CloudToolArgumentRefusal("path must be a string");
	if (raw.includes("\\") || raw.includes("\0") || CONTROL_CHAR.test(raw)) {
		throw new CloudToolArgumentRefusal(
			"path must be a relative path under this interface folder ending in .png (for example pictures/hero.png)",
		);
	}
	let trimmed = raw.trim().replace(/^\/+/, "");
	const prefix = `${folderRoot.replace(/^\/+|\/+$/g, "")}/`;
	if (prefix.length > 1 && trimmed.startsWith(prefix)) {
		trimmed = trimmed.slice(prefix.length);
	}
	if (!trimmed || trimmed.length > MAX_STUDIO_PICTURE_PATH_CHARS) {
		throw new CloudToolArgumentRefusal(
			"path must be a relative path under this interface folder ending in .png (for example pictures/hero.png)",
		);
	}
	const parts = trimmed.split("/");
	if (parts.some((part) => !part || part === "." || part === ".." || part.trim() === "")) {
		throw new CloudToolArgumentRefusal(
			"path must be a clean relative path inside the interface folder ending in .png",
		);
	}
	if (trimmed.toLowerCase() === SURFACE_LAYOUT_PATH.toLowerCase()) {
		throw new CloudToolArgumentRefusal("path cannot overwrite layout.json");
	}
	if (parts[0]?.toLowerCase() === APP_ICONS_FOLDER) {
		throw new CloudToolArgumentRefusal(
			"icons/ is reserved for SVG icons; put generated pictures in pictures/ or assets/",
		);
	}
	const base = parts[parts.length - 1] ?? "";
	const match = PNG_BASENAME.exec(base);
	if (!match || !match[1] || match[1].trim() === "") {
		throw new CloudToolArgumentRefusal("path must end in .png");
	}
	return trimmed;
}

function studioPictureRefusal(error: unknown): never {
	if (error instanceof CloudPictureUnavailable) {
		throw new CloudToolRefusal(
			"PICTURES_UNAVAILABLE: image generation is not available in this session; nothing was made or staged. Continue without the picture or tell the founder.",
		);
	}
	if (!(error instanceof CloudPictureFailure)) throw error;
	const minutes = Math.round(CLOUD_PICTURE_MS / 60_000);
	const words: Record<CloudPictureFailure["reason"], string> = {
		picture_limit: `PICTURE_LIMIT_REACHED: the member's image provider has no pictures left for now${
			error.resetsAt === undefined ? "" : `, until about ${new Date(error.resetsAt * 1000).toISOString()}`
		}; nothing was staged. Continue without the picture or tell the founder.`,
		usage_limit:
			"USAGE_LIMIT_REACHED: the member's ChatGPT usage limit stopped image generation; nothing was staged. Try again later or continue without it.",
		spend_cap:
			"GEMINI_SPEND_CAP_REACHED: the member's monthly Gemini API spend cap was reached; nothing was staged. Continue without the picture and let the founder know in one line.",
		billing_required:
			"GEMINI_BILLING_REQUIRED: the member's Gemini API key does not have billing or credits enabled for image generation; nothing was staged. Continue without the picture and let the founder know in one line.",
		refused:
			"PICTURE_REFUSED: the image generator refused this prompt or could not draw it; nothing was staged. Adjust the prompt (avoid real people, brands, or restricted content) and try again once; if it fails again, continue without it.",
		free_plan:
			"NO_PICTURE_FREE_PLAN: the member's ChatGPT plan is Free, which does not include image generation. Nothing was staged. Continue without a generated picture and note this briefly.",
		no_picture:
			"NO_PICTURE: no image was returned by the generator; nothing was staged. Adjust the prompt and try again once; if it fails again, continue without it.",
		timeout: `PICTURE_TIMEOUT: no image came back within ${minutes} minutes; nothing was staged. Try again once; if it fails again, continue without it.`,
		invalid: "PICTURE_UNUSABLE: the generator returned invalid image bytes; nothing was staged. Try again once.",
		too_large: `PICTURE_TOO_LARGE: the generated image exceeded ${MAX_CLOUD_PICTURE_BYTES / MIB} MiB; nothing was staged. Ask for a simpler composition.`,
		busy: "PICTURE_BUSY: another image is already being generated in this session; call again once it finishes.",
		failed:
			"PICTURE_FAILED: the image could not be generated right now; nothing was staged. Try again once; if it fails again, continue without it.",
	};
	throw new CloudToolRefusal(words[error.reason]);
}

export function createStudioPictureTool(options: StudioPictureToolOptions): CloudNativeTool {
	const parseArgs = (value: unknown): StudioPictureArgs => {
		const allowed = [
			"path",
			"prompt",
			"title",
			"summary",
			"changeId",
			"createNew",
			"optionGroup",
			"optionGroupTitle",
		];
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => !allowed.includes(key)) ||
			!Object.hasOwn(value, "path") ||
			!Object.hasOwn(value, "prompt")
		) {
			throw new CloudToolArgumentRefusal(
				"make_picture takes path and prompt, plus optional title, summary, changeId, createNew, optionGroup, and optionGroupTitle",
			);
		}
		const rec = value as Record<string, unknown>;
		const relPath = normalizeStudioPicturePath(rec.path, options.folderRoot);
		let prompt: string;
		try {
			prompt = cloudPictureInput({ prompt: rec.prompt as string }).prompt;
		} catch {
			throw new CloudToolArgumentRefusal(
				`prompt must be plain text of 1 to ${MAX_CLOUD_PICTURE_PROMPT_BYTES} bytes (line breaks allowed)`,
			);
		}
		const title =
			rec.title === undefined
				? undefined
				: typeof rec.title === "string" &&
						rec.title.trim().length > 0 &&
						rec.title.trim().length <= SURFACE_MAX_CHANGE_TITLE_CHARS
					? rec.title.trim()
					: null;
		if (title === null) {
			throw new CloudToolArgumentRefusal(`title must be 1..${SURFACE_MAX_CHANGE_TITLE_CHARS} characters`);
		}
		const summary =
			rec.summary === undefined
				? undefined
				: typeof rec.summary === "string" &&
						rec.summary.trim().length > 0 &&
						rec.summary.trim().length <= SURFACE_MAX_CHANGE_SUMMARY_CHARS
					? rec.summary.trim()
					: null;
		if (summary === null) {
			throw new CloudToolArgumentRefusal(`summary must be 1..${SURFACE_MAX_CHANGE_SUMMARY_CHARS} characters`);
		}
		const changeId =
			rec.changeId === undefined
				? undefined
				: typeof rec.changeId === "string" && isUuid(rec.changeId.trim())
					? rec.changeId.trim().toLowerCase()
					: null;
		if (changeId === null) {
			throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
		}
		const createNew = rec.createNew === undefined ? false : typeof rec.createNew === "boolean" ? rec.createNew : null;
		if (createNew === null) {
			throw new CloudToolArgumentRefusal("createNew must be a boolean");
		}
		if (changeId && createNew) {
			throw new CloudToolArgumentRefusal(
				"Pass either changeId to update an existing change in place or createNew: true to add a separate new change, not both.",
			);
		}
		const optionGroup =
			rec.optionGroup === undefined
				? undefined
				: typeof rec.optionGroup === "string" && isSurfaceOptionGroupKey(rec.optionGroup.trim())
					? rec.optionGroup.trim()
					: null;
		if (optionGroup === null) {
			throw new CloudToolArgumentRefusal("optionGroup must be a lowercase slug");
		}
		const optionGroupTitle =
			rec.optionGroupTitle === undefined
				? undefined
				: typeof rec.optionGroupTitle === "string" &&
						rec.optionGroupTitle.trim().length > 0 &&
						rec.optionGroupTitle.trim().length <= SURFACE_MAX_OPTION_GROUP_TITLE_CHARS
					? rec.optionGroupTitle.trim()
					: null;
		if (optionGroupTitle === null) {
			throw new CloudToolArgumentRefusal(
				`optionGroupTitle must be 1..${SURFACE_MAX_OPTION_GROUP_TITLE_CHARS} characters`,
			);
		}
		if (optionGroupTitle && !optionGroup) {
			throw new CloudToolArgumentRefusal("optionGroupTitle requires optionGroup");
		}
		return {
			path: relPath,
			prompt,
			...(title !== undefined ? { title } : {}),
			...(summary !== undefined ? { summary } : {}),
			...(changeId ? { changeId } : {}),
			createNew,
			...(optionGroup ? { optionGroup } : {}),
			...(optionGroupTitle ? { optionGroupTitle } : {}),
		};
	};

	const resolveTitleAndSummary = (
		args: StudioPictureArgs,
		targetChangeId: string | null,
	): { readonly title: string; readonly summary: string } => {
		const existing = targetChangeId ? options.patchTracker?.getChangeMeta(targetChangeId) : undefined;
		return {
			title: args.title ?? existing?.title ?? readablePictureTitle(args.path),
			summary: args.summary ?? existing?.summary ?? "Added a generated visual for Preview.",
		};
	};

	return {
		name: "make_picture" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		images: true,
		description: [
			"Generate one bespoke PNG image using the member's configured image model and stage it as a Preview file inside this interface folder at relative path (for example pictures/hero.png).",
			"The tool returns the generated image inline so you can inspect it immediately. When attaching a picture to an existing staged change or option, pass its changeId and omit title and summary so the change keeps its existing title and summary.",
			`path must end in .png under this interface folder (max ${MAX_CLOUD_PICTURE_BYTES / MIB} MiB). Never pass a generated picture off as a photo of a real person, real place, or competitor's real product.`,
		].join("\n"),
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "prompt"],
			properties: {
				path: {
					type: "string",
					minLength: 5,
					maxLength: MAX_STUDIO_PICTURE_PATH_CHARS,
					description: "Relative .png path inside this interface folder (for example pictures/hero.png).",
				},
				prompt: {
					type: "string",
					minLength: 1,
					maxLength: MAX_CLOUD_PICTURE_PROMPT_BYTES,
					description: "Detailed visual description of subject, framing, lighting, palette, and background.",
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_TITLE_CHARS,
					description:
						"Short founder-facing change title shown in Changes. Omit when attaching to changeId to preserve its title.",
				},
				summary: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_CHANGE_SUMMARY_CHARS,
					description:
						"Concise founder-facing summary of the staged picture. Omit when attaching to changeId to preserve its summary.",
				},
				changeId: {
					type: "string",
					description:
						"Optional open change UUID to update in place when regenerating or adding a visual to an existing change.",
				},
				createNew: {
					type: "boolean",
					description:
						"Set true when intentionally staging a separate new change alongside existing open changes in this session.",
				},
				optionGroup: {
					type: "string",
					description: "Optional option-group slug when staging competing visual directions.",
				},
				optionGroupTitle: {
					type: "string",
					minLength: 1,
					maxLength: SURFACE_MAX_OPTION_GROUP_TITLE_CHARS,
					description: "Optional option-group heading shown in Changes.",
				},
			},
		},
		parseArguments(value) {
			const args = parseArgs(value);
			const targetChangeId = options.patchTracker
				? options.patchTracker.resolveTargetChangeId({
						explicitChangeId: args.changeId ?? null,
						createNew: args.createNew,
						optionGroup: args.optionGroup ?? null,
					})
				: (args.changeId ?? null);
			const { title, summary } = resolveTitleAndSummary(args, targetChangeId);
			return {
				path: args.path,
				prompt: args.prompt,
				title,
				summary,
				...(targetChangeId ? { changeId: targetChangeId } : {}),
				...(args.createNew ? { createNew: true } : {}),
				...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
				...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
			};
		},
		async execute(rawArgs, context: CloudToolContext) {
			const args = parseArgs(rawArgs);
			const targetChangeId = options.patchTracker
				? options.patchTracker.resolveTargetChangeId({
						explicitChangeId: args.changeId ?? null,
						createNew: args.createNew,
						optionGroup: args.optionGroup ?? null,
					})
				: (args.changeId ?? null);
			const { title, summary } = resolveTitleAndSummary(args, targetChangeId);
			context.observation?.update({ inputBytes: Buffer.byteLength(args.prompt) });
			let made: CloudPictureMade;
			try {
				made = await options.pictures.make({ prompt: args.prompt }, context.signal);
			} catch (error) {
				return studioPictureRefusal(error);
			}
			if (made.png.byteLength > MAX_CLOUD_PICTURE_BYTES) {
				studioPictureRefusal(new CloudPictureFailure("too_large"));
			}
			let view: FolderImageView;
			try {
				view = await oneImageAtATime(context.signal, async () => folderImageView(made.png));
			} catch (error) {
				if (!(error instanceof FolderImageRefusal)) throw error;
				return studioPictureRefusal(new CloudPictureFailure("invalid"));
			}
			if (view.format !== "png") {
				studioPictureRefusal(new CloudPictureFailure("invalid"));
			}
			const ref = await options.stageBytes(made.png, "image/png", context.signal);
			const closedRef: StudioBinaryRef = {
				manifestSha256: ref.manifestSha256,
				fileSha256: ref.fileSha256,
				bytes: ref.bytes,
				mediaType: ref.mediaType,
			};
			const ops = [{ op: "write_file" as const, path: args.path, file: closedRef }];
			const staged = await options.surfacePatch.stageSurfacePatch(
				options.sessionId,
				{
					title,
					summary,
					ops,
					notePaths: [],
					finishSession: false,
					...(targetChangeId ? { changeId: targetChangeId } : {}),
					...(args.optionGroup ? { optionGroup: args.optionGroup } : {}),
					...(args.optionGroupTitle ? { optionGroupTitle: args.optionGroupTitle } : {}),
				},
				context,
			);
			options.patchTracker?.recordStaged({
				targetChangeId,
				resultChangeId: staged.changeId,
				ops,
				optionGroup: args.optionGroup ?? null,
				title,
				summary,
			});
			const revised =
				made.revisedPrompt !== undefined && made.revisedPrompt !== args.prompt
					? Buffer.byteLength(made.revisedPrompt) <= MAX_CLOUD_PICTURE_PROMPT_BYTES && !made.revisedPromptCut
						? { revisedPrompt: made.revisedPrompt }
						: { revisedPromptCut: true as const }
					: {};
			const answer: Record<string, JsonValue> = {
				schema: STUDIO_MAKE_PICTURE_SCHEMA,
				ok: true,
				kind: "picture",
				changeId: staged.changeId,
				seq: staged.seq,
				path: args.path,
				mediaType: "image/png",
				bytes: made.png.byteLength,
				fileSha256: closedRef.fileSha256,
				width: view.width,
				height: view.height,
				shownWidth: view.shownWidth,
				shownHeight: view.shownHeight,
				imageSha256: view.sha256,
				...(made.transparent === undefined ? {} : { transparent: made.transparent }),
				next: "Staged for Preview. Inspect the image above; to replace it in place, call make_picture again with a refined prompt and this changeId.",
			};
			if (fitsOneResult(cloudToolJsonText({ ...answer, ...revised }))) {
				Object.assign(answer, revised);
			} else if (Object.keys(revised).length > 0) {
				answer.revisedPromptCut = true;
			}
			return {
				kind: "json",
				value: answer,
				image: { png: view.png, sha256: view.sha256 },
			};
		},
	};
}
