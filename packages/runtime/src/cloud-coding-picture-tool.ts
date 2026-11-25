import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { type JsonValue, UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	sha256Hex,
} from "./cloud-company-folder-client.ts";
import {
	cloudFolderRefusal,
	OPERATION_KEY,
	operationKey,
	TOOL_VERSION,
	unavailable,
	version,
} from "./cloud-folder-file-tools.ts";
import { FolderImageRefusal, type FolderImageView, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
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
import { fitsOneResult } from "./cloud-worker-tools.ts";

export const CODING_MAKE_PICTURE_SCHEMA = "qorpera.coding-picture/v1";
export const MAX_CODING_PICTURE_PATH_BYTES = 512;

const MIB = 1024 * 1024;
const REMEMBERED_CALLS = 256;
const REMEMBERED_PICTURES = 4;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PNG_BASENAME = /^(.+)\.png$/i;
const PATH_REFUSAL =
	"path must be a relative workspace path ending in .png (no leading /, no .., no backslash, no .git segment, at most 512 bytes).";

export const CODING_MAKE_PICTURE_DESCRIPTION = [
	"Generate one bespoke PNG image (a product concept, hero scene, lifestyle shot, illustration, diagram, or UI artwork) and save it directly into the repository worktree at relative path; missing parent directories under the worktree are created automatically.",
	"Never pass a generated image off as a photo of a real person, real place, or competitor's real product; where an interface displays a generated concept image, label it honestly when appropriate.",
	"The tool returns the generated PNG inline so you can inspect it immediately. If it does not match the layout, lighting, or composition you need, call make_picture again with a refined prompt, a new operationKey, and the previous result's version as expectedVersion to replace it.",
	`path must be a relative workspace path ending in .png (for example assets/hero.png). Maximum size is ${MAX_CLOUD_PICTURE_BYTES / MIB} MiB. Each generation uses the member's ChatGPT plan allowance, so generate the purposeful visuals the design needs.`,
].join("\n");

const SAVED_NEXT =
	"Saved in the repository worktree. Inspect the image above; if it needs changes, call make_picture again with a better prompt, a new operationKey, and this version as expectedVersion. If an immediate shell command does not see the new file yet, wait a moment for the workspace mount to refresh.";

function pictureRefusal(error: unknown): never {
	if (error instanceof CloudPictureUnavailable)
		throw new CloudToolRefusal(
			"PICTURES_UNAVAILABLE: this run's login cannot make pictures (they require a Codex sign-in to ChatGPT); nothing was made or saved. Continue without a generated image or inform the member.",
		);
	if (!(error instanceof CloudPictureFailure)) throw error;
	const minutes = Math.round(CLOUD_PICTURE_MS / 60_000);
	const words: Record<CloudPictureFailure["reason"], string> = {
		picture_limit: `PICTURE_LIMIT_REACHED: the member's ChatGPT has no pictures left for now${
			error.resetsAt === undefined ? "" : `, until about ${new Date(error.resetsAt * 1000).toISOString()}`
		}; nothing was saved. Do not retry before then: continue without the picture or tell the member.`,
		usage_limit:
			"USAGE_LIMIT_REACHED: the member's ChatGPT usage limit stopped the picture; nothing was saved. Try again later or continue without it.",
		spend_cap:
			"GEMINI_SPEND_CAP_REACHED: the member's monthly Gemini API spend cap was reached; nothing was saved. Continue without the picture and note this briefly.",
		billing_required:
			"GEMINI_BILLING_REQUIRED: the member's Gemini API key does not have billing or credits enabled for image generation; nothing was saved. Continue without the picture and note this briefly.",
		refused:
			"PICTURE_REFUSED: the picture generator refused this prompt or could not draw it; nothing was saved. Revise the prompt (remove real people, brands, or disallowed content) and call again with a new operationKey; if it fails again, continue without it.",
		free_plan:
			"NO_PICTURE_FREE_PLAN: this member's ChatGPT plan is Free, which cannot generate pictures. Nothing was saved. Continue without a generated picture and note this briefly.",
		no_picture:
			"NO_PICTURE: no picture was returned by the image tool. Nothing was saved. Revise the prompt and retry once with a new operationKey; if it fails again, continue without one.",
		timeout: `PICTURE_TIMEOUT: no picture returned within ${minutes} minutes; nothing was saved. Retry once with a new operationKey; if it fails again, continue without it.`,
		invalid:
			"PICTURE_UNUSABLE: the generator returned invalid PNG data; nothing was saved. Retry once with a new operationKey.",
		too_large: `PICTURE_TOO_LARGE: the picture exceeded ${MAX_CLOUD_PICTURE_BYTES / MIB} MiB; nothing was saved. Ask for a simpler composition with a new operationKey.`,
		busy: "PICTURE_BUSY: another picture is already being generated in this run; call again once it finishes.",
		failed:
			"PICTURE_FAILED: the picture could not be generated right now; nothing was saved. Retry once with a new operationKey; if it fails again, continue without it.",
	};
	throw new CloudToolRefusal(words[error.reason]);
}

export function parseCodingPicturePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.trim() !== value ||
		Buffer.byteLength(value, "utf8") > MAX_CODING_PICTURE_PATH_BYTES ||
		Buffer.from(value).toString("utf8") !== value ||
		CONTROL_CHAR.test(value) ||
		value.startsWith("/") ||
		value.includes("\\")
	)
		throw new CloudToolArgumentRefusal(PATH_REFUSAL);
	const parts = value.split("/");
	if (
		parts.some(
			(part) => part === "" || part === "." || part === ".." || part.trim() === "" || part.toLowerCase() === ".git",
		)
	)
		throw new CloudToolArgumentRefusal(PATH_REFUSAL);
	const base = parts[parts.length - 1] ?? "";
	const match = PNG_BASENAME.exec(base);
	if (!match || !match[1] || match[1].trim() === "") throw new CloudToolArgumentRefusal(PATH_REFUSAL);
	return value;
}

function codingPictureOutcomeNext(unit: CloudCompanyFolderUnitResult): string {
	const reason = unit.reason ?? "";
	if (unit.outcome === "saved") return SAVED_NEXT;
	if (reason === "exists")
		return "CODING_PICTURE_EXISTS: nothing was written; a file already exists at that path. Choose a new path, or pass the file's version as expectedVersion with a new operationKey to replace it.";
	if (unit.outcome === "conflict")
		return `CODING_PICTURE_VERSION_CHANGED: nothing was written; the file ${reason === "missing" ? "was removed" : "changed"} since your expectedVersion. Choose a new path or call again with the current version and a new operationKey.`;
	if (reason === "parent_missing")
		return "CODING_PICTURE_PARENT_MISSING: nothing was written; a parent path is not a folder. Choose a valid relative path inside the repository worktree with a new operationKey.";
	if (unit.outcome === "denied")
		return "CODING_PICTURE_ACCESS_DENIED: you may not write that path; nothing was written.";
	return `Nothing was written (${reason || "refused"}): choose a valid relative workspace path and retry with a new operationKey.`;
}

interface CodingPictureRequest {
	readonly operationKey: string;
	readonly path: string;
	readonly prompt: string;
	readonly expectedVersion: string | null;
}

export function createCodingPictureTool(options: {
	readonly folder: CloudCompanyFolderClient;
	readonly worktreeArea: string;
	readonly operations: CloudNativeToolOperations;
	readonly pictures: CloudPictureChannel;
}): CloudNativeTool {
	const { folder, worktreeArea, operations, pictures } = options;
	const answered = new Map<string, { readonly call: string; reply: CloudToolContent | null }>();
	const remember = (key: string, call: string, reply: CloudToolContent | null): void => {
		answered.delete(key);
		answered.set(key, { call, reply });
		while (answered.size > REMEMBERED_CALLS) answered.delete(answered.keys().next().value as string);
		let pictured = 0;
		for (const entry of [...answered.values()].reverse()) {
			if (!entry.reply?.image) continue;
			if (++pictured <= REMEMBERED_PICTURES) continue;
			const { image: _image, ...answer } = entry.reply;
			entry.reply = answer;
		}
	};
	const read = async (target: string, signal: AbortSignal): Promise<CloudCompanyFolderEntry | null> => {
		try {
			return (await folder.read(target, signal)).entry;
		} catch (error) {
			return unavailable(error, "saved");
		}
	};
	return {
		name: "make_picture" satisfies CloudRuntimeToolOperation,
		source: "worker",
		images: true,
		refused: cloudFolderRefusal,
		description: CODING_MAKE_PICTURE_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "path", "prompt"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				path: {
					type: "string",
					maxLength: MAX_CODING_PICTURE_PATH_BYTES,
					description: "Relative workspace path ending in .png (for example assets/hero.png).",
				},
				prompt: {
					type: "string",
					minLength: 1,
					maxLength: MAX_CLOUD_PICTURE_PROMPT_BYTES,
					description:
						"Detailed description of the subject, framing, lighting, mood, color palette, and background.",
				},
				expectedVersion: {
					type: ["string", "null"],
					pattern: UUID_PATTERN.source,
					description:
						"Omit for a new file; to replace an existing file created earlier, pass the version returned by the previous make_picture call.",
				},
			},
		},
		parseArguments(value) {
			const keys = ["operationKey", "path", "prompt", "expectedVersion"];
			if (
				value === null ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.keys(value).some((key) => !keys.includes(key)) ||
				!["operationKey", "path", "prompt"].every((key) => Object.hasOwn(value, key))
			)
				throw new CloudToolArgumentRefusal(
					"make_picture takes operationKey, path, and prompt, plus optional expectedVersion, and nothing else",
				);
			const relativePath = parseCodingPicturePath(value.path);
			try {
				parseCloudCompanyPath(`${worktreeArea}/${relativePath}`);
			} catch {
				throw new CloudToolArgumentRefusal(PATH_REFUSAL);
			}
			let prompt: string;
			try {
				prompt = cloudPictureInput({ prompt: value.prompt as string }).prompt;
			} catch {
				throw new CloudToolArgumentRefusal(
					`prompt must be plain text of 1 to ${MAX_CLOUD_PICTURE_PROMPT_BYTES} bytes (line breaks allowed)`,
				);
			}
			return {
				operationKey: operationKey(value.operationKey),
				path: relativePath,
				prompt,
				expectedVersion: value.expectedVersion === undefined ? null : version(value.expectedVersion, true),
			};
		},
		async execute(value, context) {
			const request = value as unknown as CodingPictureRequest;
			if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
			context.observation?.update({ inputBytes: Buffer.byteLength(request.prompt) });
			const call = sha256Hex(
				Buffer.from(
					cloudToolJsonText({
						path: request.path,
						expectedVersion: request.expectedVersion,
						prompt: request.prompt,
					}),
					"utf8",
				),
			);
			const earlier = answered.get(request.operationKey);
			if (earlier) {
				if (earlier.call !== call)
					throw new CloudToolRefusal(
						"OPERATION_KEY_USED: this operationKey was used for another picture in this run; nothing was made. Use a new operationKey for a new picture.",
					);
				if (earlier.reply === null) throw new Error("An earlier call of this picture has an unconfirmed outcome");
				return { ...earlier.reply };
			}
			const rootEntry = await read(worktreeArea, context.signal);
			if (rootEntry?.kind !== "folder")
				throw new CloudToolRefusal(
					"CODING_WORKTREE_UNAVAILABLE: nothing was made; the session worktree folder is not ready in the company folder yet. Retry after the workspace finishes initializing.",
				);
			const segments = request.path.split("/");
			const missingDirs: string[] = [];
			for (let index = 0; index < segments.length - 1; index += 1) {
				const dirPath = `${worktreeArea}/${segments.slice(0, index + 1).join("/")}`;
				const entry = await read(dirPath, context.signal);
				if (entry === null) {
					missingDirs.push(dirPath);
				} else if (entry.kind !== "folder") {
					throw new CloudToolRefusal(
						"CODING_PICTURE_PARENT_NOT_A_FOLDER: nothing was made; a parent segment of path is a file or link, not a folder. Choose a different path.",
					);
				}
			}
			const fullPath = `${worktreeArea}/${request.path}`;
			const existing = await read(fullPath, context.signal);
			if (existing?.kind === "folder")
				throw new CloudToolRefusal(
					"CODING_PICTURE_NOT_A_FILE: nothing was made; that path is a folder. Give a file path ending in .png.",
				);
			if (existing?.kind === "symlink")
				throw new CloudToolRefusal(
					"CODING_PICTURE_IS_A_LINK: nothing was made; that path is a link, and make_picture never follows or replaces links. Choose another path.",
				);
			let made: CloudPictureMade;
			try {
				made = await pictures.make({ prompt: request.prompt }, context.signal);
			} catch (error) {
				return pictureRefusal(error);
			}
			if (made.png.byteLength > MAX_CLOUD_PICTURE_BYTES) pictureRefusal(new CloudPictureFailure("too_large"));
			let view: FolderImageView;
			try {
				view = await oneImageAtATime(context.signal, async () => folderImageView(made.png));
			} catch (error) {
				if (!(error instanceof FolderImageRefusal)) throw error;
				return pictureRefusal(new CloudPictureFailure("invalid"));
			}
			if (view.format !== "png") pictureRefusal(new CloudPictureFailure("invalid"));
			const fileSha256 = sha256Hex(made.png);
			const revised =
				made.revisedPrompt !== undefined && made.revisedPrompt !== request.prompt
					? Buffer.byteLength(made.revisedPrompt) <= MAX_CLOUD_PICTURE_PROMPT_BYTES && !made.revisedPromptCut
						? { revisedPrompt: made.revisedPrompt }
						: { revisedPromptCut: true as const }
					: {};
			let content: CloudToolContent;
			try {
				content = await operations.execute({
					operation: {
						tool: "make_picture",
						toolVersion: TOOL_VERSION,
						logicalOperationKey: request.operationKey,
						arguments: {
							path: request.path,
							expectedVersion: request.expectedVersion,
							promptSha256: sha256Hex(Buffer.from(request.prompt, "utf8")),
						},
						target: { path: fullPath },
						requiresCompanyRevision: true,
					},
					authorize: async () => {},
					refused: cloudFolderRefusal,
					perform: async (_operation, { receiptId, signal }) => {
						const key = `make_picture:${sha256Hex(Buffer.from(request.operationKey, "utf8"))}`;
						const units: CloudCompanyFolderUnit[] = [
							...missingDirs.map((dir): CloudCompanyFolderUnit => ({ op: "mkdir", path: dir })),
							{
								op: "write",
								path: fullPath,
								content: { bytes: made.png, mediaType: "image/png" },
								...(request.expectedVersion === null ? {} : { expectedVersion: request.expectedVersion }),
							},
						];
						const committed = await folder.commit(key, units, { receiptId }, signal);
						const result = committed.units[committed.units.length - 1];
						if (!result) throw new Error("Company folder commit answered no unit");
						const answer: Record<string, JsonValue> = {
							schema: CODING_MAKE_PICTURE_SCHEMA,
							state:
								result.outcome === "saved"
									? "applied"
									: result.outcome === "waiting_for_review"
										? "proposed"
										: "not_applied",
							operationKey: request.operationKey,
							path: request.path,
							version: result.outcome === "saved" ? result.version : null,
							receiptId,
							outcome: result.outcome,
							...(result.reason ? { reason: result.reason } : {}),
							...(result.problems.length
								? {
										problems: result.problems.map((problem) => ({
											code: problem.code,
											message: problem.message,
										})),
									}
								: {}),
							kind: "image",
							mediaType: "image/png",
							bytes: made.png.byteLength,
							fileSha256,
							width: view.width,
							height: view.height,
							shownWidth: view.shownWidth,
							shownHeight: view.shownHeight,
							imageSha256: view.sha256,
							...(made.transparent === undefined ? {} : { transparent: made.transparent }),
							next: codingPictureOutcomeNext(result),
						};
						if (fitsOneResult(cloudToolJsonText({ ...answer, ...revised }))) Object.assign(answer, revised);
						else if (Object.keys(revised).length > 0) answer.revisedPromptCut = true;
						return {
							content: { kind: "json", value: answer },
							folderCommitId: committed.commitId,
							...(result.outcome === "waiting_for_review" ? { proposed: true as const } : {}),
						};
					},
					signal: context.signal,
					...(context.observation ? { observation: context.observation } : {}),
				});
			} catch (error) {
				if (!(error instanceof CloudToolRefusal)) remember(request.operationKey, call, null);
				throw error;
			}
			if (content.kind !== "json" || content.value === null || typeof content.value !== "object")
				throw new Error("A picture's answer is not its JSON");
			const answer = content.value as Record<string, JsonValue>;
			const shown =
				(answer.state === "applied" || answer.state === "proposed") &&
				answer.fileSha256 === fileSha256 &&
				answer.imageSha256 === view.sha256 &&
				fitsOneResult(cloudToolJsonText(answer));
			const plain: CloudToolContent = { kind: "json", value: answer };
			const reply = shown ? { ...plain, image: { png: view.png, sha256: view.sha256 } } : plain;
			remember(request.operationKey, call, reply);
			return reply;
		},
	};
}
