/*
 * make_picture (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3c; Jonas, 13 November 2026: "I would also turn on agents
 * generating images of course"): an agent makes one picture from a prompt, and it is saved as a PNG file in the company
 * folder, as company_write saves a file.
 *
 * - The picture is made through the run's picture lane (cloud-picture-channel.ts): a side thread of the run's own Codex,
 *   on the run's own sign-in, the one thread of the run with Codex's image tool on. The lane is attached only for a
 *   Codex login's run, and the company runtime offers this tool only there.
 * - Where it may be saved is company_write's rule: the folder core decides at the commit, a protected path parks the
 *   change for review, a missing folder is refused. Before anything is spent, the tool refuses a path whose folder is
 *   not there and a path that is a folder or a link. A file already there is replaced only under the version the
 *   agent gives (`expectedVersion`), checked at the commit as company_write's is, so a repeat of a call that was saved
 *   reaches its receipt (it makes a picture it then throws away).
 * - Under `apps/<name>/` the owner check is save_app's: a picture in another agent's or a member's app is reviewed as
 *   delegation (`prepare` says so); an app's `icons/` hold save_app's SVGs and take no picture.
 * - Every picture is held to an app's bound for one picture (12 MiB), must decode as a PNG, and goes in as one binary
 *   unit, `image/png`, under the call's receipt. The picture is made before the receipt: a failure is a refusal that
 *   began nothing (a receipt left executing would stop every later change of the run).
 * - The answer is company_write's with the picture's facts, and the picture itself follows it, fitted as company_read
 *   fits an image (cloud-folder-images.ts), when it was saved or parked for review and is the one just made.
 */

import { APP_ICONS_FOLDER } from "@qorpera/cloud-client/app-icons";
import { companyPathKey, osRelative } from "@qorpera/cloud-client/company-state-files";
import {
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_MAX_FILES,
	APP_MEDIA_KINDS,
	APP_VIDEOS_MAX_BYTES,
	APPS_FOLDER,
	appFileKind,
	appPath,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { type JsonValue, UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderUnit,
	sha256,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { APP_LIST_LIMIT, appFileSizes } from "./cloud-folder-app-tools.ts";
import {
	cloudFolderRefusal,
	mutationText,
	OPERATION_KEY,
	operationKey,
	path,
	TOOL_VERSION,
	unavailable,
	version,
} from "./cloud-folder-file-tools.ts";
import { FolderImageRefusal, type FolderImageView, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
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

const MIB = 1024 * 1024;
/** The calls a run's make_picture remembers, by operationKey, for the run's life: the newest this many, each with its
 * answer (or that its outcome is unconfirmed), and the picture itself for the newest few. A repeat of the same call is
 * answered from here and makes no picture: the receipt would answer it the same way, but only after a picture was
 * made, since the ledger has no read of a completed operation by key that starts nothing. */
const REMEMBERED_CALLS = 256;
const REMEMBERED_PICTURES = 4;
/** The room an app's pictures and videos must have left before a picture for it is made: what one picture takes in
 * practice (gpt-image's 1536x1024 PNG was 1.87 MB on the Mac trial of 13 November 2026), with some to spare. A picture
 * that comes back larger than the room left is refused before it is saved. */
const APP_PICTURE_ROOM_BYTES = 4 * MIB;

/** What make_picture tells the agent (at most 4096 bytes, as every tool's description). */
export const CLOUD_MAKE_PICTURE_DESCRIPTION =
	"Make one picture of something that does not exist yet, such as the company's own product idea, a scene, a look or an illustration for an app, and save it as a PNG file at path in the company folder. One picture per call. " +
	"A real thing is shown by its real picture, never a generated one: for a real product, person or place, or a competitor's product, save a screenshot of the maker's own picture instead. Never pass a generated picture off as a photo of something real: where an app shows one, it says drawn or illustration. " +
	"Write the prompt as a short description that says the subject, the view, the light and the background; for a thing that will stand on a page, ask for a plain or transparent-looking background. " +
	"The answer shows you the picture: look at it, and when it is not good enough, call again with a better prompt and a new operationKey, giving the answer's version as expectedVersion to replace it. " +
	"Pictures for an app go into the app's folder, such as apps/<name>/pictures/, before the save_app that shows them. " +
	`path ends in .png, and its folder must exist (COMPANY_FILE_PARENT_MISSING otherwise; make it with company_mkdir). Leave expectedVersion out for a new file, or give the version company_read reported to replace one; a changed version is COMPANY_FILE_VERSION_CHANGED and nothing is saved. A picture is at most ${MAX_CLOUD_PICTURE_BYTES / MIB} MiB. ` +
	"Each picture uses the member's own ChatGPT plan, which limits how many it makes: make the ones the work needs. Keep operationKey for the same call, and use a new one for any other. The result's state is applied only when it was saved.";

/** What follows a saved picture's answer. */
const SAVED_NEXT =
	"Saved. Look at the picture: if it is not good enough, call again with a better prompt, a new operationKey and this version as expectedVersion.";

/** A path among the company's pages and tables, whose change shows in the run's conversation with Undo (I10). */
const pagesPath = (path: string): boolean => /^(?:interfaces|tables)\//.test(osRelative(companyPathKey(path)) ?? "");

/** A refusal before anything was saved: the call's own words for each reason no picture came back. */
function pictureRefusal(error: unknown): never {
	if (error instanceof CloudPictureUnavailable)
		throw new CloudToolRefusal(
			"PICTURES_UNAVAILABLE: this run's login cannot make pictures (they are made on a Codex sign-in to ChatGPT); nothing was made or saved. Go on without the picture, or tell the member.",
		);
	if (!(error instanceof CloudPictureFailure)) throw error;
	const minutes = Math.round(CLOUD_PICTURE_MS / 60_000);
	const words: Record<CloudPictureFailure["reason"], string> = {
		picture_limit: `PICTURE_LIMIT_REACHED: the member's ChatGPT has no pictures left for now${
			error.resetsAt === undefined ? "" : `, until about ${new Date(error.resetsAt * 1000).toISOString()}`
		}; nothing was saved. Do not try again before then: go on without the picture, or tell the member.`,
		usage_limit:
			"USAGE_LIMIT_REACHED: the member's ChatGPT usage limit stopped the picture; nothing was saved. Try again later, or go on without it.",
		refused:
			"PICTURE_REFUSED: the picture generator refused this prompt or could not draw it; nothing was saved. Change the prompt (leave out real people, brands and anything unsafe) and call again with a new operationKey; if it fails again, go on without it.",
		free_plan:
			"NO_PICTURE_FREE_PLAN: this member's ChatGPT plan is Free, which makes no pictures. Nothing was saved. Go on without a generated picture, and tell the member in one line that their plan makes no pictures.",
		no_picture:
			"NO_PICTURE: no picture was made: the image tool was not used, and why is not known (the prompt may have been declined, or this sign-in may make no pictures). Nothing was saved. Change the prompt (leave out real people, brands and anything unsafe) and call once more with a new operationKey; if no picture comes again, go on without one and tell the member in one line.",
		timeout: `PICTURE_TIMEOUT: no picture came back within ${minutes} minutes; nothing was saved. Call again once with a new operationKey; if it fails again, go on without it.`,
		invalid:
			"PICTURE_UNUSABLE: what the generator gave back is not a usable PNG; nothing was saved. Call again once with a new operationKey.",
		too_large: `PICTURE_TOO_LARGE: the picture is larger than ${MAX_CLOUD_PICTURE_BYTES / MIB} MiB, more than any picture may be; nothing was saved. Ask for a simpler picture with a new operationKey.`,
		busy: "PICTURE_BUSY: another picture is being made in this run; call again once it is done.",
		failed:
			"PICTURE_FAILED: the picture could not be made now; nothing was saved. Call again once with a new operationKey; if it fails again, go on without it.",
	};
	throw new CloudToolRefusal(words[error.reason]);
}

interface PictureRequest {
	readonly operationKey: string;
	readonly path: string;
	readonly prompt: string;
	readonly expectedVersion: string | null;
	/** Read before the review (prepare): the picture goes into another agent's or a member's app. */
	readonly foreignOwner?: true;
}

/** make_picture of a folder-v2 run whose login makes pictures. `operations` takes the receipt of its change;
 * `pictures` is the run's picture lane, which the session attaches. */
export function cloudPictureTool(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
	pictures: CloudPictureChannel;
}): CloudNativeTool {
	const { folder, operations, identity, pictures } = options;
	const owner = identity.staffAgentId.toLowerCase();
	// The calls this run answered past their receipt, by operationKey (REMEMBERED_CALLS): `reply` null for one whose
	// outcome is unconfirmed. Oldest first.
	const answered = new Map<string, { readonly call: string; reply: CloudToolContent | null }>();
	const remember = (key: string, call: string, reply: CloudToolContent | null): void => {
		answered.delete(key);
		answered.set(key, { call, reply });
		while (answered.size > REMEMBERED_CALLS) answered.delete(answered.keys().next().value as string);
		// Only the newest few keep their picture: up to 1 MiB each.
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
	/** An app's room for a picture at `app.inner`, as save_app counts the app from a listing of it: whether one more
	 * file fits beside its files (the one at that path, which the picture replaces, not counted), and the bytes its
	 * pictures and videos have left. Listed before the picture is made, and again before it is saved. */
	const appRoom = async (
		app: NonNullable<ReturnType<typeof appPath>>,
		signal: AbortSignal,
	): Promise<{ oneMoreFile: boolean; mediaLeft: number }> => {
		const root = `${APPS_FOLDER}/${app.name}`;
		const listed = await folder
			.list(root, { recursive: true, limit: APP_LIST_LIMIT }, signal)
			.catch((error) => unavailable(error, "saved"));
		const sizes = appFileSizes(listed.entries, root);
		sizes.delete(app.inner.toLowerCase());
		const media = [...sizes].reduce(
			(sum, [inner, bytes]) => (APP_MEDIA_KINDS.has(appFileKind(inner)) ? sum + bytes : sum),
			0,
		);
		return {
			oneMoreFile: listed.next === null && sizes.size + 1 <= APP_MAX_FILES,
			mediaLeft: APP_VIDEOS_MAX_BYTES - media,
		};
	};
	return {
		name: "make_picture" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		images: true,
		description: CLOUD_MAKE_PICTURE_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "path", "prompt"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				path: { type: "string", maxLength: 4096, description: "Where the PNG goes in the company folder." },
				prompt: {
					type: "string",
					minLength: 1,
					maxLength: MAX_CLOUD_PICTURE_PROMPT_BYTES,
					description: "What to draw, in words: the subject, the view, the light and the background.",
				},
				expectedVersion: { type: ["string", "null"], pattern: UUID_PATTERN.source },
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
					"make_picture takes operationKey, path and prompt, and may take expectedVersion, and nothing else",
				);
			const target = path(value.path, false);
			if (!target.toLowerCase().endsWith(".png"))
				throw new CloudToolArgumentRefusal("path must end in .png: the picture is saved as a PNG");
			const app = appPath(target);
			if (app?.inner.toLowerCase().startsWith(`${APP_ICONS_FOLDER}/`))
				throw new CloudToolArgumentRefusal(
					"an app's icons are SVG drawings that save_app writes: put the picture in another folder of the app, such as pictures/",
				);
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
				path: target,
				prompt,
				expectedVersion: value.expectedVersion === undefined ? null : version(value.expectedVersion, true),
			};
		},
		// A picture in another agent's or a member's app changes that app, as save_app does: it is reviewed as delegation.
		// Read before the review, so its effect class is the one that runs.
		async prepare(value, context) {
			const request = value as unknown as PictureRequest;
			const app = appPath(request.path);
			if (!app) return value;
			let stored: Awaited<ReturnType<CloudCompanyFolderClient["readText"]>> = null;
			try {
				stored = await folder.readText(
					`${APPS_FOLDER}/${app.name}/${APP_MANIFEST}`,
					APP_MANIFEST_MAX_BYTES,
					context.signal,
				);
			} catch (error) {
				if (!(error instanceof CloudCompanyPathNotText)) unavailable(error, "saved");
			}
			const parsed = stored ? parseAppManifest(stored.text) : null;
			return parsed?.ok === true && parsed.manifest.owner !== owner
				? ({ ...request, foreignOwner: true } as unknown as JsonValue)
				: value;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as unknown as PictureRequest;
			// A commit no one can complete would fence this run's later operations: refuse before anything is spent.
			if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
			context.observation?.update({ inputBytes: Buffer.byteLength(request.prompt) });
			// A repeat of a call this run already answered (its answer was lost on the way) costs no second picture.
			const call = sha256(
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
				// Its outcome stays as unconfirmed as the receipt would leave it, without another picture.
				if (earlier.reply === null) throw new Error("An earlier call of this picture has an unconfirmed outcome");
				// A saved or parked picture among the company's pages is noted again, as a repeat of company_write's change
				// is: the note of the call before may have failed, and SQL notes each commit once.
				const state = (earlier.reply.value as Record<string, JsonValue> | null)?.state;
				if ((state === "applied" || state === "proposed") && pagesPath(request.path))
					await folder.noteInterfaceChanges(context.signal);
				return { ...earlier.reply };
			}
			// What would refuse the picture anyway is checked before it is made: the member's plan pays for each one.
			const parent = request.path.split("/").slice(0, -1).join("/");
			if (parent !== "") {
				const into = await read(parent, context.signal);
				if (into === null)
					throw new CloudToolRefusal(
						"COMPANY_FILE_PARENT_MISSING: nothing was made; the folder this path goes in does not exist. When it is where the picture belongs, create it with company_mkdir first (outermost first) and call again; otherwise save the picture in a folder that exists.",
					);
				if (into.kind !== "folder")
					throw new CloudToolRefusal(
						"COMPANY_FILE_PARENT_MISSING: nothing was made; what this path goes in is a file or a link, not a folder. Save the picture in a folder.",
					);
			}
			// A picture for an app goes in only while the app has room for it, as save_app counts the app's files: one
			// more file, and a picture's room among its pictures and videos.
			const app = appPath(request.path);
			if (app) {
				const room = await appRoom(app, context.signal);
				if (!room.oneMoreFile || room.mediaLeft < APP_PICTURE_ROOM_BYTES)
					throw new CloudToolRefusal(
						`APP_TOO_LARGE: nothing was made; the app ${app.name} has no room for another picture (an app holds at most ${APP_MAX_FILES} files and ${APP_VIDEOS_MAX_BYTES / MIB} MiB of pictures and videos). Remove pictures it no longer shows with company_delete first, or save this one outside the app.`,
					);
			}
			const at = await read(request.path, context.signal);
			if (at?.kind === "folder")
				throw new CloudToolRefusal(
					"COMPANY_FILE_NOT_A_FILE: nothing was made; that path is a folder. Give the picture a file's path ending in .png.",
				);
			if (at?.kind === "symlink")
				throw new CloudToolRefusal(
					"COMPANY_FILE_IS_A_LINK: nothing was made; that path is a link, and make_picture never follows or replaces one. Choose another path.",
				);
			let made: CloudPictureMade;
			try {
				made = await pictures.make({ prompt: request.prompt }, context.signal);
			} catch (error) {
				return pictureRefusal(error);
			}
			if (made.png.byteLength > MAX_CLOUD_PICTURE_BYTES) pictureRefusal(new CloudPictureFailure("too_large"));
			// The picture decodes as a PNG, or it is not saved; the model sees it fitted as company_read fits an image.
			let view: FolderImageView;
			try {
				view = await oneImageAtATime(context.signal, async () => folderImageView(made.png));
			} catch (error) {
				if (!(error instanceof FolderImageRefusal)) throw error;
				return pictureRefusal(new CloudPictureFailure("invalid"));
			}
			if (view.format !== "png") pictureRefusal(new CloudPictureFailure("invalid"));
			const fileSha256 = sha256(made.png);
			// The picture model's own words for the prompt, when they differ: never more than a description's bound (the lane
			// cuts them there), and left out when the answer would not reach the model whole with them (below).
			const revised =
				made.revisedPrompt !== undefined && made.revisedPrompt !== request.prompt
					? Buffer.byteLength(made.revisedPrompt) <= MAX_CLOUD_PICTURE_PROMPT_BYTES && !made.revisedPromptCut
						? { revisedPrompt: made.revisedPrompt }
						: { revisedPromptCut: true as const }
					: {};
			// The app is listed again once the picture is made, as late as a refusal can still begin nothing: another run may
			// have filled it during the generation. The commit checks the target's version only, so the moment between this
			// listing and the commit stays open, as it does between save_app's own listing and commit.
			if (app) {
				const room = await appRoom(app, context.signal);
				if (!room.oneMoreFile || made.png.byteLength > room.mediaLeft) {
					const full = room.oneMoreFile
						? `at ${made.png.byteLength} bytes it is more than the ${Math.max(0, room.mediaLeft)} bytes left for pictures and videos`
						: `one more file would pass the ${APP_MAX_FILES} an app holds`;
					throw new CloudToolRefusal(
						`APP_TOO_LARGE: the picture was made but not saved; the app ${app.name} has no room for it now, as it changed while the picture was made or was full already: ${full}. Remove pictures it no longer shows with company_delete first, or save it outside the app.`,
					);
				}
			}
			let content: CloudToolContent;
			try {
				content = await operations.execute({
					operation: {
						tool: "make_picture",
						toolVersion: TOOL_VERSION,
						logicalOperationKey: request.operationKey,
						// The call, not the picture: a repeat of the same call is the same operation, and replays its receipt.
						arguments: {
							path: request.path,
							expectedVersion: request.expectedVersion,
							promptSha256: sha256(Buffer.from(request.prompt, "utf8")),
						},
						target: { path: request.path },
						requiresCompanyRevision: true,
					},
					// The folder core decides at the commit, under this call's receipt.
					authorize: async () => {},
					refused: cloudFolderRefusal,
					perform: async (_operation, { receiptId, signal }) => {
						// The commit's operation key for the model's: fixed length, and distinct per tool.
						const key = `make_picture:${sha256(Buffer.from(request.operationKey, "utf8"))}`;
						const unit: CloudCompanyFolderUnit = {
							op: "write",
							path: request.path,
							content: { bytes: made.png, mediaType: "image/png" },
							...(request.expectedVersion === null ? {} : { expectedVersion: request.expectedVersion }),
						};
						const committed = await folder.commit(key, [unit], { receiptId }, signal);
						const result = committed.units[0];
						if (!result) throw new Error("Company folder commit answered no unit");
						const answer: Record<string, JsonValue> = {
							...(JSON.parse(
								mutationText(
									"company_write",
									{ operationKey: request.operationKey, path: request.path },
									receiptId,
									result,
								),
							) as Record<string, JsonValue>),
							kind: "picture",
							mediaType: "image/png",
							bytes: made.png.byteLength,
							fileSha256,
							width: view.width,
							height: view.height,
							shownWidth: view.shownWidth,
							shownHeight: view.shownHeight,
							imageSha256: view.sha256,
							...(made.transparent === undefined ? {} : { transparent: made.transparent }),
							...(result.outcome === "saved" ? { next: SAVED_NEXT } : {}),
						};
						// The answer must reach the model whole, since its picture follows it and the context view reads the picture's
						// hash from it; the revised prompt goes first when it would not fit (an envelope past the bound is cut, and a
						// stored result past 48 KiB fails its receipt).
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
				// Past its receipt's begin the outcome may be unknown: a repeat stays so, and makes no picture. A refusal began
				// nothing, and a repeat may be answered otherwise.
				if (!(error instanceof CloudToolRefusal)) remember(request.operationKey, call, null);
				throw error;
			}
			if (content.kind !== "json" || content.value === null || typeof content.value !== "object")
				throw new Error("A picture's answer is not its JSON");
			const answer = content.value as Record<string, JsonValue>;
			// The picture follows its answer when it was saved or parked for review and is the one made now: an answer from
			// the receipt (the call made in an earlier attempt of the run) names the picture saved then.
			const shown =
				(answer.state === "applied" || answer.state === "proposed") &&
				answer.fileSha256 === fileSha256 &&
				answer.imageSha256 === view.sha256 &&
				fitsOneResult(cloudToolJsonText(answer));
			const plain: CloudToolContent = { kind: "json", value: answer };
			const reply = shown ? { ...plain, image: { png: view.png, sha256: view.sha256 } } : plain;
			remember(request.operationKey, call, reply);
			// A picture that is part of the company's pages shows in the run's conversation with Undo, as company_write's
			// change does (Interfaces I10).
			if (pagesPath(request.path)) await folder.noteInterfaceChanges(context.signal);
			return reply;
		},
	};
}
