/*
 * The interface app tools of a folder-v2 run (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3; Jonas, 5 November 2026):
 * an agent makes a small web page, kept as files in `apps/<name>/` of the Company File, to show members what it made,
 * and members open it beside the chat.
 * - `save_app` creates an app (its folder, its `app.toml` and its files) or changes its manifest and files, in one
 *   change set under the call's receipt. It applies at once (review class internal): the files are the agent's own work.
 *   It checks the name, the manifest, each file's kind and size and the app's totals before anything is written; it
 *   sets `owner` and `posted = false` on a new app and never changes either after.
 * - `post_app` sets `posted`, which shows the app in every member's apps drawer or takes it away: delegation, which the
 *   automatic review sees (cloud-action-review.ts). It rewrites that one line of `app.toml`, every other byte as written.
 * `company_write` and `company_edit` check an `app.toml` the same way and refuse a change of `posted`
 * (cloud-folder-file-tools.ts, `appManifestCheck`).
 */

import { createHash } from "node:crypto";
import { AGENT_COLOURS } from "@qorpera/cloud-client/company-state-shared";
import {
	APP_DEFAULT_ENTRY,
	APP_FILE_MAX_BYTES,
	APP_FILE_TYPES,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_MAX_BYTES,
	APP_MAX_FILES,
	APP_READS,
	APP_TEXT_KINDS,
	type AppManifest,
	appFileKind,
	appFolder,
	appRelativePath,
	parseAppManifest,
	setAppPosted,
	writeAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { INTERFACE_EMBLEMS, isInterfaceName } from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderNewEntry,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	CloudCompanyPathNotText,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import {
	args,
	cloudFolderRefusal,
	OPERATION_KEY,
	operationKey,
	released,
	TOOL_VERSION,
	unavailable,
} from "./cloud-folder-file-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	MAX_TOOL_ARGUMENT_BYTES,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/** Files one save_app call writes, at most. */
const FILES_PER_CALL = 32;
/** The app's entries a save lists to check its totals: more than an app may hold. */
const LIST_LIMIT = 200;

const sha256hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface AppFile {
	readonly path: string;
	readonly text: string;
}

interface ManifestInput {
	readonly name: string;
	readonly about: string | null;
	readonly emblem: AppManifest["emblem"] | null;
	readonly colour: AppManifest["colour"];
	readonly entry: string | null;
	readonly reads: AppManifest["reads"] | null;
}

interface SaveRequest {
	readonly name: string;
	readonly operationKey: string;
	readonly manifest: ManifestInput | null;
	readonly files: readonly AppFile[];
}

const text = (value: JsonValue | undefined, label: string, max: number, required: boolean): string | null => {
	if (value === undefined || value === null) {
		if (required) throw new CloudToolArgumentRefusal(`${label} is required`);
		return null;
	}
	if (typeof value !== "string" || /[\0-\x1f\x7f]/.test(value) || [...value.trim()].length > max)
		throw new CloudToolArgumentRefusal(`${label} must be one line of at most ${max} characters`);
	const trimmed = value.trim();
	if (required && trimmed.length === 0) throw new CloudToolArgumentRefusal(`${label} is required`);
	return trimmed.length === 0 ? null : trimmed;
};

function appName(value: JsonValue | undefined): string {
	if (typeof value !== "string" || !isInterfaceName(value))
		throw new CloudToolArgumentRefusal(
			"name must be the app's folder name: lowercase a–z, digits and single hyphens, at most 64 characters, like sales-board",
		);
	return value;
}

function parseManifest(value: JsonValue | undefined): ManifestInput | null {
	if (value === null) return null;
	if (value === undefined || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("manifest must be an object, or null to keep the app's manifest as it is");
	const keys = ["title", "about", "emblem", "colour", "entry", "reads"];
	if (Object.keys(value).some((key) => !keys.includes(key)))
		throw new CloudToolArgumentRefusal(`manifest takes ${keys.join(", ")}`);
	const choice = <T extends string>(raw: JsonValue | undefined, label: string, options: readonly T[]): T | null => {
		if (raw === undefined || raw === null) return null;
		if (typeof raw !== "string" || !(options as readonly string[]).includes(raw))
			throw new CloudToolArgumentRefusal(`${label} must be one of ${options.join(", ")}`);
		return raw as T;
	};
	let entry: string | null = null;
	if (value.entry !== undefined && value.entry !== null) {
		const relative = typeof value.entry === "string" ? appRelativePath(value.entry) : null;
		if (relative === null || !["html", "htm"].includes(appFileKind(relative)))
			throw new CloudToolArgumentRefusal("manifest.entry must be a relative path to an .html file of the app");
		entry = relative;
	}
	let reads: AppManifest["reads"] | null = null;
	if (value.reads !== undefined && value.reads !== null) {
		if (
			!Array.isArray(value.reads) ||
			value.reads.some((read) => typeof read !== "string" || !(APP_READS as readonly string[]).includes(read))
		)
			throw new CloudToolArgumentRefusal(`manifest.reads must be a list of ${APP_READS.join(", ")}`);
		reads = [...new Set(value.reads as AppManifest["reads"][number][])];
	}
	return {
		name: text(value.title, "manifest.title", 60, true) as string,
		about: text(value.about, "manifest.about", 200, false),
		emblem: choice(value.emblem, "manifest.emblem", INTERFACE_EMBLEMS),
		colour: choice(value.colour, "manifest.colour", AGENT_COLOURS),
		entry,
		reads,
	};
}

function parseFiles(value: JsonValue | undefined): AppFile[] {
	if (!Array.isArray(value) || value.length > FILES_PER_CALL)
		throw new CloudToolArgumentRefusal(`files must be a list of at most ${FILES_PER_CALL} {path, text}`);
	const seen = new Set<string>();
	return value.map((item) => {
		const file = args(item, "each file", ["path", "text"]);
		const relative = typeof file.path === "string" ? appRelativePath(file.path) : null;
		if (relative === null)
			throw new CloudToolArgumentRefusal(
				"a file's path must be relative to the app's folder, like index.html or js/app.js (no leading /, no ..)",
			);
		if (relative.toLowerCase() === APP_MANIFEST)
			throw new CloudToolArgumentRefusal("app.toml is written from manifest, not as a file");
		const kind = appFileKind(relative);
		if (!APP_TEXT_KINDS.has(kind))
			throw new CloudToolArgumentRefusal(
				`${relative}: an app's text files are ${[...APP_TEXT_KINDS].map((name) => `.${name}`).join(" ")}; put a picture in the folder with company_write's sibling tools or as an inline SVG or data: URL`,
			);
		if (typeof file.text !== "string" || Buffer.byteLength(file.text) > APP_FILE_MAX_BYTES)
			throw new CloudToolArgumentRefusal(
				`${relative}: text must be UTF-8 of at most ${APP_FILE_MAX_BYTES / 1024} KiB`,
			);
		const key = relative.toLowerCase();
		if (seen.has(key)) throw new CloudToolArgumentRefusal(`${relative} is listed twice`);
		seen.add(key);
		return { path: relative, text: file.text };
	});
}

/** The folders a set of relative file paths needs, parents first. */
function foldersOf(paths: readonly string[]): string[] {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
	}
	return [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

const contentOf = (path: string, text: string) => ({
	text,
	mediaType: APP_FILE_TYPES[appFileKind(path)] ?? "text/plain",
});

/** What the model is told after a commit, by each unit's outcome. */
function savedText(
	request: { name: string; operationKey: string },
	receiptId: string,
	units: readonly CloudCompanyFolderUnitResult[],
	created: boolean,
): string {
	const saved = units.filter((unit) => unit.outcome === "saved").length;
	const state = saved === units.length ? "applied" : saved === 0 ? "not_applied" : "partly_applied";
	const conflict = units.some((unit) => unit.outcome === "conflict");
	return cloudToolJsonText({
		schema: "qorpera.app-save/v1",
		state,
		app: request.name,
		operationKey: request.operationKey,
		receiptId,
		created,
		link: `app:${request.name}`,
		files: units.map((unit) => ({
			path: unit.path,
			outcome: unit.outcome,
			...(unit.version ? { version: unit.version } : {}),
			...(unit.reason ? { reason: unit.reason } : {}),
			...(unit.problems.length > 0 ? { problems: unit.problems.map((problem) => problem.message) } : {}),
		})),
		next:
			state === "applied"
				? `Saved. Show it to the member with a link in your message: [${request.name}](app:${request.name}). post_app shows it to every member in their apps.`
				: conflict
					? "Some files changed while this call saved them: read the app's files again, then call again with a new operationKey."
					: "Some files were not saved (their reasons): fix them and call again with a new operationKey.",
	});
}

/** The two interface app tools of a folder-v2 run. `operations` takes the receipts of their changes. */
export function cloudAppTools(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
}): CloudNativeTool[] {
	const { folder, operations, identity } = options;
	const owner = identity.staffAgentId.toLowerCase();
	const read = async (path: string, signal: AbortSignal): Promise<CloudCompanyFolderEntry | null> => {
		try {
			return (await folder.read(path, signal)).entry;
		} catch (error) {
			return unavailable(error, "saved");
		}
	};
	const manifestText = async (path: string, signal: AbortSignal) => {
		try {
			return await folder.readText(path, APP_MANIFEST_MAX_BYTES, signal);
		} catch (error) {
			if (error instanceof CloudCompanyPathNotText) return "unreadable" as const;
			return unavailable(error, "saved");
		}
	};
	// A commit no one can complete would fence this run's later operations: refuse before writing anything.
	const writable = () => {
		if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
	};
	const commit = async (
		tool: "save_app" | "post_app",
		request: { name: string; operationKey: string },
		argumentsDigest: Record<string, JsonValue>,
		units: readonly CloudCompanyFolderUnit[],
		answer: (receiptId: string, units: readonly CloudCompanyFolderUnitResult[]) => string,
		context: CloudToolContext,
	) => {
		const content = await operations.execute({
			operation: {
				tool,
				toolVersion: TOOL_VERSION,
				logicalOperationKey: request.operationKey,
				arguments: argumentsDigest,
				target: { path: appFolder(request.name) as string },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			refused: cloudFolderRefusal,
			perform: async (_operation, { receiptId, signal }) => {
				const key = `${tool}:${sha256hex(request.operationKey)}`;
				const committed = await folder.commit(key, units, { receiptId }, signal);
				if (committed.units.length !== units.length) throw new Error("Company folder commit answered other units");
				return {
					content: { kind: "text", value: answer(receiptId, committed.units) },
					folderCommitId: committed.commitId,
					...(committed.units.some((unit) => unit.outcome === "waiting_for_review")
						? { proposed: true as const }
						: {}),
				};
			},
			signal: context.signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		if (content.kind !== "text") throw new Error("An app change answered no text");
		return content.value;
	};
	// After the receipt the change is made or settled, so an answer that cannot be released is unconfirmed, never a
	// refusal (which says nothing happened): the model repeats the same call, and its replay answers.
	const showCommitted = async (
		context: CloudToolContext,
		value: string,
		reads: readonly CloudCompanyFolderEntry[],
	) => {
		try {
			return await released(folder, identity.runId, context, value, reads.map(cloudCompanyFolderRelease));
		} catch (error) {
			if (error instanceof CloudToolRefusal)
				throw new Error("A committed answer could not be released", { cause: error });
			throw error;
		}
	};

	const saveApp: CloudNativeTool = {
		name: "save_app" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		maxArgumentBytes: MAX_TOOL_ARGUMENT_BYTES,
		description: `Make or change an interface app: a small web page in apps/<name>/ of the company folder that shows members what you made (results, a test, a prototype, a dashboard), opened beside the chat. Give the app's name (its folder: lowercase, digits and hyphens), a manifest (title, and optionally about, emblem: ${INTERFACE_EMBLEMS.join(", ")}, colour: ${AGENT_COLOURS.join(", ")}, entry: the page that opens, default ${APP_DEFAULT_ENTRY}, reads: the live sources the page may read, of ${APP_READS.join(", ")}) to make it or change its manifest, or null to keep it, and the files to write (at most ${FILES_PER_CALL} a call: .html, .css, .js, .json, .svg, .md, .csv, .txt, each at most ${APP_FILE_MAX_BYTES / 1024} KiB). The entry may use the app's other files by relative paths (<link rel="stylesheet" href="style.css">, <script src="app.js">, <img src="chart.svg">); the page has no network, so put everything it needs in the app. A new app needs a manifest and its entry. It applies at once. Then link it in your message as [Title](app:<name>), which members open beside the chat. Keep operationKey for the same change, and use a new one for any other change.`,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "operationKey", "manifest", "files"],
			properties: {
				name: { type: "string", maxLength: 64 },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				manifest: {
					type: ["object", "null"],
					additionalProperties: false,
					required: ["title"],
					properties: {
						title: { type: "string", maxLength: 60 },
						about: { type: ["string", "null"], maxLength: 200 },
						emblem: { type: ["string", "null"], enum: [...INTERFACE_EMBLEMS, null] },
						colour: { type: ["string", "null"], enum: [...AGENT_COLOURS, null] },
						entry: { type: ["string", "null"], maxLength: 1024 },
						reads: { type: ["array", "null"], items: { type: "string", enum: [...APP_READS] } },
					},
				},
				files: {
					type: "array",
					maxItems: FILES_PER_CALL,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["path", "text"],
						properties: {
							path: { type: "string", maxLength: 1024 },
							text: { type: "string", maxLength: APP_FILE_MAX_BYTES },
						},
					},
				},
			},
		},
		parseArguments(value) {
			const input = args(value, "save_app", ["name", "operationKey", "manifest", "files"]);
			const request: SaveRequest = {
				name: appName(input.name),
				operationKey: operationKey(input.operationKey),
				manifest: parseManifest(input.manifest),
				files: parseFiles(input.files),
			};
			if (request.manifest === null && request.files.length === 0)
				throw new CloudToolArgumentRefusal("give a manifest, files, or both");
			return request as unknown as JsonValue;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as unknown as SaveRequest;
			writable();
			context.observation?.update({
				inputBytes: request.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
			});
			const root = appFolder(request.name) as string;
			const reads: CloudCompanyFolderEntry[] = [];
			const at = await read(root, context.signal);
			if (at !== null && at.kind !== "folder")
				throw new CloudToolRefusal(
					`APP_NOT_A_FOLDER: ${root} is a ${at.kind === "file" ? "file" : "link"}, not an app's folder`,
				);
			const digest: Record<string, JsonValue> = {
				name: request.name,
				manifestSha256: sha256hex(JSON.stringify(request.manifest)),
				files: request.files.map((file) => ({ path: file.path, textSha256: sha256hex(file.text) })),
			};
			if (at === null) {
				// A new app: its whole folder in one unit, the apps folder with it when the company has none yet.
				if (request.manifest === null)
					throw new CloudToolRefusal("APP_NOT_FOUND: no app has that name; give a manifest to make it");
				const manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? "page",
					colour: request.manifest.colour,
					entry: request.manifest.entry ?? APP_DEFAULT_ENTRY,
					owner,
					posted: false,
					reads: request.manifest.reads ?? [],
				};
				if (!request.files.some((file) => file.path.toLowerCase() === manifest.entry.toLowerCase()))
					throw new CloudToolRefusal(
						`APP_ENTRY_MISSING: a new app needs its entry, ${manifest.entry}, among files`,
					);
				const total = request.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
				if (request.files.length + 1 > APP_MAX_FILES || total > APP_MAX_BYTES)
					throw new CloudToolRefusal(
						`APP_TOO_LARGE: an app holds at most ${APP_MAX_FILES} files and ${APP_MAX_BYTES / 1024 / 1024} MiB in all`,
					);
				const contents: CloudCompanyFolderNewEntry[] = [
					{
						path: APP_MANIFEST,
						kind: "file",
						content: { text: writeAppManifest(manifest), mediaType: "application/toml" },
					},
					...foldersOf(request.files.map((file) => file.path)).map((path) => ({ path, kind: "folder" as const })),
					...request.files.map((file) => ({
						path: file.path,
						kind: "file" as const,
						content: contentOf(file.path, file.text),
					})),
				];
				const apps = await read("apps", context.signal);
				if (apps !== null) reads.push(apps);
				if (apps !== null && apps.kind !== "folder")
					throw new CloudToolRefusal("APP_NOT_A_FOLDER: apps is not a folder, so no app can be made");
				const unit: CloudCompanyFolderUnit =
					apps === null
						? {
								op: "new_folder",
								path: "apps",
								contents: [
									{ path: request.name, kind: "folder" },
									...contents.map((entry) => ({ ...entry, path: `${request.name}/${entry.path}` })),
								],
							}
						: { op: "new_folder", path: root, contents };
				const answer = await commit(
					"save_app",
					request,
					digest,
					[unit],
					(receiptId, units) => savedText(request, receiptId, units, true),
					context,
				);
				return showCommitted(context, answer, reads);
			}
			reads.push(at);
			// A change: the manifest kept or rewritten with its owner and posted as stored, and each file written over the
			// version read now (a file another call changed in between is a conflict).
			const manifestPath = `${root}/${APP_MANIFEST}`;
			const stored = await manifestText(manifestPath, context.signal);
			const units: CloudCompanyFolderUnit[] = [];
			let entry = APP_DEFAULT_ENTRY;
			if (stored !== null && stored !== "unreadable") reads.push(stored.entry);
			const storedParse = stored !== null && stored !== "unreadable" ? parseAppManifest(stored.text) : null;
			if (request.manifest !== null) {
				const before = storedParse?.ok ? storedParse.manifest : null;
				const manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? before?.emblem ?? "page",
					colour: request.manifest.colour ?? before?.colour ?? null,
					entry: request.manifest.entry ?? before?.entry ?? APP_DEFAULT_ENTRY,
					owner: before?.owner ?? owner,
					posted: before?.posted ?? false,
					reads: request.manifest.reads ?? before?.reads ?? [],
				};
				entry = manifest.entry;
				const textOut = writeAppManifest(manifest);
				if (stored === "unreadable")
					throw new CloudToolRefusal(
						`APP_MANIFEST_UNREADABLE: ${manifestPath} is not text; replace it on the company's computer`,
					);
				units.push(
					stored === null
						? { op: "write", path: manifestPath, content: { text: textOut, mediaType: "application/toml" } }
						: {
								op: "write",
								path: manifestPath,
								content: { text: textOut, mediaType: stored.entry.file.mediaType },
								expectedVersion: stored.entry.version,
							},
				);
			} else if (storedParse?.ok) entry = storedParse.manifest.entry;
			else
				throw new CloudToolRefusal(
					`APP_MANIFEST_INVALID: ${manifestPath} is missing or has problems; give a manifest to write it again`,
				);
			// The app's totals, with this call's files in place of the ones they replace.
			const listed = await folder
				.list(root, { recursive: true, limit: LIST_LIMIT }, context.signal)
				.catch((error) => unavailable(error, "saved"));
			reads.push(...listed.entries);
			const sizes = new Map<string, number>();
			for (const item of listed.entries)
				if (item.kind === "file" && APP_FILE_TYPES[appFileKind(item.path)])
					sizes.set(item.path.slice(root.length + 1).toLowerCase(), item.file.bytes);
			for (const file of request.files) sizes.set(file.path.toLowerCase(), Buffer.byteLength(file.text));
			const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
			if (listed.next !== null || sizes.size > APP_MAX_FILES || total > APP_MAX_BYTES)
				throw new CloudToolRefusal(
					`APP_TOO_LARGE: an app holds at most ${APP_MAX_FILES} files and ${APP_MAX_BYTES / 1024 / 1024} MiB in all; remove files with company_delete first`,
				);
			const byKey = new Map(listed.entries.map((item) => [item.path.slice(root.length + 1).toLowerCase(), item]));
			for (const folderPath of foldersOf(request.files.map((file) => file.path))) {
				const found = byKey.get(folderPath.toLowerCase());
				if (found === undefined) units.push({ op: "mkdir", path: `${root}/${folderPath}` });
				else if (found.kind !== "folder")
					throw new CloudToolRefusal(`APP_NOT_A_FOLDER: ${root}/${folderPath} is a file, not a folder`);
			}
			for (const file of request.files) {
				const found = byKey.get(file.path.toLowerCase());
				if (found !== undefined && found.kind !== "file")
					throw new CloudToolRefusal(`APP_NOT_A_FILE: ${root}/${file.path} is a folder or a link`);
				units.push(
					found === undefined
						? { op: "write", path: `${root}/${file.path}`, content: contentOf(file.path, file.text) }
						: {
								op: "write",
								path: found.path,
								content: {
									text: file.text,
									mediaType: found.file.mediaType,
									executable: found.file.executable,
								},
								expectedVersion: found.version,
							},
				);
			}
			if (
				!byKey.has(entry.toLowerCase()) &&
				!request.files.some((file) => file.path.toLowerCase() === entry.toLowerCase())
			)
				throw new CloudToolRefusal(
					`APP_ENTRY_MISSING: the app's entry, ${entry}, is not in its folder; write it among files`,
				);
			const answer = await commit(
				"save_app",
				request,
				digest,
				units,
				(receiptId, results) => savedText(request, receiptId, results, false),
				context,
			);
			return showCommitted(context, answer, reads);
		},
	};

	const postApp: CloudNativeTool = {
		name: "post_app" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description:
			"Post an interface app so every member of the company sees it in their apps (posted true), or take it away (posted false). The app stays in the company folder either way, and a link to it in a message still opens it. Post what members should keep coming back to: a dashboard, a board, a living plan. Keep operationKey for the same change, and use a new one for any other change.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["name", "operationKey", "posted"],
			properties: {
				name: { type: "string", maxLength: 64 },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				posted: { type: "boolean" },
			},
		},
		parseArguments(value) {
			const input = args(value, "post_app", ["name", "operationKey", "posted"]);
			if (typeof input.posted !== "boolean") throw new CloudToolArgumentRefusal("posted must be true or false");
			return { name: appName(input.name), operationKey: operationKey(input.operationKey), posted: input.posted };
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as { name: string; operationKey: string; posted: boolean };
			writable();
			const path = `${appFolder(request.name)}/${APP_MANIFEST}`;
			const stored = await manifestText(path, context.signal);
			if (stored === null) throw new CloudToolRefusal("APP_NOT_FOUND: no app has that name; make it with save_app");
			if (stored === "unreadable")
				throw new CloudToolRefusal(`APP_MANIFEST_UNREADABLE: ${path} is not text; replace it with save_app`);
			const parsed = parseAppManifest(stored.text);
			const show = (answer: Record<string, JsonValue>) =>
				released(
					folder,
					identity.runId,
					context,
					cloudToolJsonText({
						schema: "qorpera.app-post/v1",
						app: request.name,
						operationKey: request.operationKey,
						...answer,
					}),
					[cloudCompanyFolderRelease(stored.entry)],
				);
			if (!parsed.ok)
				return show({
					state: "not_applied",
					reason: "invalid",
					problems: parsed.problems.map((problem) => problem.message),
					next: "The app's manifest has problems: fix it with save_app, then post it.",
				});
			if (parsed.manifest.posted === request.posted)
				return show({
					state: "unchanged",
					posted: request.posted,
					next: request.posted ? "It is already posted." : "It is not posted.",
				});
			const next = setAppPosted(stored.text, request.posted);
			if (next === null) throw new Error("A manifest that parses could not be posted");
			const answer = await commit(
				"post_app",
				request,
				{ name: request.name, posted: request.posted },
				[
					{
						op: "write",
						path: stored.entry.path,
						content: { text: next, mediaType: stored.entry.file.mediaType },
						expectedVersion: stored.entry.version,
					},
				],
				(receiptId, units) => {
					const unit = units[0];
					const saved = unit?.outcome === "saved";
					return cloudToolJsonText({
						schema: "qorpera.app-post/v1",
						app: request.name,
						operationKey: request.operationKey,
						receiptId,
						state: saved ? "applied" : unit?.outcome === "waiting_for_review" ? "proposed" : "not_applied",
						posted: saved ? request.posted : parsed.manifest.posted,
						outcome: unit?.outcome ?? "refused",
						...(unit?.reason ? { reason: unit.reason } : {}),
						next: saved
							? request.posted
								? "Posted: every member sees it in their apps."
								: "Taken away from the members' apps."
							: unit?.outcome === "conflict"
								? "The manifest changed while this call wrote it: call again with a new operationKey."
								: "Nothing was posted: tell the member.",
					});
				},
				context,
			);
			return showCommitted(context, answer, [stored.entry]);
		},
	};

	return [saveApp, postApp];
}
