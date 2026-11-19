/*
 * The interface app tools of a folder-v2 run (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3; Jonas, 5 November 2026):
 * an agent makes a small web page, kept as files in `apps/<name>/` of the Company File, to show members a part of the
 * company as it stands, and members open it as a page of its own.
 * - `save_app` creates an app (its folder, its `app.toml` and its files) or changes its manifest and files, in one
 *   change set under the call's receipt. It applies at once (review class internal): the files are the agent's own work.
 *   It checks the name, the manifest, each file's kind and size and the app's totals before anything is written; it
 *   sets `owner` and `posted = false` on a new app and never changes either after.
 *   Its answer carries `look`: what a quick read of the saved entry page found (`appLookNotes`), as advice. A save of
 *   an owed view (`OWED_APPS`, not a concept, not icons alone) adds to it, last, the line that says so (`owedAppNote`):
 *   a line to know, which asks for no fix, so `next` asks for a fix only when another note stands.
 *   An app made from a kit (`manifest.kit`, §3a and §3b) gets the kit's own files from this call: for an explainer the
 *   engine and the page, beside the agent's `scenes.js`, whose quick read is the `look` (cloud-app-kit-explainer.ts);
 *   for a data kit (model, board, path, object, curve, stack, shelf, map, ring, flow) the kit's engine and a page
 *   that names the pictures its data refers to, beside the agent's `<kit>.json`, whose read is the `look`
 *   (cloud-app-kits.ts).
 *   An app's own icons (`icons/<id>.svg`, @qorpera/cloud-client/app-icons), which members pick for their drawer, are
 *   read here as the web draws them, and an app keeps at most `APP_ICONS_MAX`.
 * - `post_app` sets `posted`, which shows the app in every member's apps drawer or takes it away: delegation, which the
 *   automatic review sees (cloud-action-review.ts). It rewrites that one line of `app.toml`, every other byte as written.
 * - `app_guide` answers how one part of an app is made (cloud-app-guides.ts): the look every app is held to, what a
 *   kit's one file holds, how a page written by hand is styled, reads the company's live data and lets a member act,
 *   and how an app's own icons are drawn. It reads nothing of the company and changes nothing. `save_app` saves a
 *   kit's file only in a run that has read the kit's guide: until 14 November 2026 the guides were the descriptions of
 *   save_app's fields, which no model ever received (cloud-app-guides.ts says why), so nothing is left to a
 *   description being read.
 * `company_write` and `company_edit` check an `app.toml` the same way and refuse a change of `posted`
 * (cloud-folder-file-tools.ts, `appManifestCheck`).
 * An interface a member retired (`apps/retired.md`, cloud-folder-app-retired.ts) is refused by `save_app` and
 * `post_app`, as by the file tools and `make_picture`, until a member brings it back.
 */

import { createHash } from "node:crypto";
import { APP_GROUPS_PATH, isAppGroupId } from "@qorpera/cloud-client/app-groups";
import { APP_ICONS_FOLDER, APP_ICONS_MAX, appIconIdOf, parseAppIcon } from "@qorpera/cloud-client/app-icons";
import { PROGRAM_FILE, PROGRAM_FILE_MAX_BYTES, parseProgram } from "@qorpera/cloud-client/app-program";
import { AGENT_COLOURS, companyPathKey } from "@qorpera/cloud-client/company-state-shared";
import {
	APP_BINARY_KINDS,
	APP_CLOSED_FOLDERS,
	APP_COVER_KINDS,
	APP_DEFAULT_ENTRY,
	APP_FILE_TYPES,
	APP_KITS,
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APP_READS,
	APP_WRITE_ANSWERS,
	APP_WRITES_MAX,
	type AppManifest,
	appFileKind,
	appFolder,
	appLinkName,
	appRelativePath,
	OWED_APPS,
	parseAppManifest,
	parseAppWrites,
	setAppPosted,
	writeAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { INTERFACE_EMBLEMS, isInterfaceName } from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
import { APP_GUIDES, APP_KIT_CHOICE, type AppGuide, appGuide, isAppGuide } from "./cloud-app-guides.ts";
import {
	EXPLAINER_CLIPS,
	EXPLAINER_CLIPS_MAX_BYTES,
	EXPLAINER_ENGINE,
	EXPLAINER_ENGINE_JS,
	EXPLAINER_PAGE,
	EXPLAINER_SCENES,
	explainerNotes,
	explainerPage,
	parseExplainerClips,
} from "./cloud-app-kit-explainer.ts";
import { keepProgram, programHandIn } from "./cloud-app-kit-program.ts";
import {
	type DataKit,
	isDataKit,
	KIT_DATA_MAX_BYTES,
	KIT_ENGINE,
	KIT_ENGINE_JS,
	KIT_PAGE,
	KIT_THREE,
	KIT_THREE_LICENSE,
	kitBindings,
	kitDataFile,
	kitHeavyPictures,
	kitLibrary,
	kitNotes,
	kitPage,
	parseKitData,
} from "./cloud-app-kits.ts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderNewEntry,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderUnitResult,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { placeAppInGroup } from "./cloud-folder-app-groups.ts";
import { refuseRetiredApp } from "./cloud-folder-app-retired.ts";
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
async function listWhole(
	folder: CloudCompanyFolderClient,
	root: string,
	signal: AbortSignal,
): Promise<CloudCompanyFolderEntry[]> {
	const entries: CloudCompanyFolderEntry[] = [];
	let after: string | undefined;
	for (;;) {
		const page = await folder.list(root, { recursive: true, ...(after === undefined ? {} : { after }) }, signal);
		entries.push(...page.entries);
		if (page.next === null) return entries;
		after = page.next;
	}
}

/** What save_app says of `manifest.emblem`: the schema's enum lists the pictures (24 since 12 November 2026). */
const SAVE_APP_EMBLEM =
	"The app's own picture in the apps drawer, drawn in its colour; page when the app has none. Members may pick another for their own drawer, or one of the app's own icons (app_guide icons says how to draw those).";

/**
 * What app_guide tells the agent, as a contract (track 3, T3-5): what it answers, when to call it, and what it changes.
 * The guides stood on save_app's fields until 14 November 2026 (#1804, cloud-app-guides.ts says why no model read them).
 */
const APP_GUIDE_DESCRIPTION = [
	"Read the guide to one part of an interface app before you make it with save_app. It reads nothing of the company and changes nothing.",
	"- look: the bar every app's look is held to, with screens to follow and screens to avoid. Read it before your first app.",
	"- about a kit (model, board, path, object, curve, stack, shelf, map, ring, flow, explainer, program): what the kit's one file holds, field by field with its bounds, an example, and how to check the page. save_app saves a kit's file only in a run that has read that kit's guide.",
	"- style, reads, writes: for a page written by hand: the base style and the company's colours as CSS variables, in light and dark; how its script reads the company's live data through the qorpera object, and how often; how it lets a member answer a question or change a table's row.",
	"- icons: how an app's own icons are drawn.",
	"The answer is the guide's text: read it again when you no longer have it.",
].join("\n");

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
	/** Null keeps what the app has (nothing for a new app). */
	readonly writes: AppManifest["writes"] | null;
	/** Null keeps what the app has (false for a new app). */
	readonly concept: boolean | null;
	readonly cover: string | null;
	/** Null keeps what the app has (no kit for a new app). */
	readonly kit: AppManifest["kit"];
}

interface SaveRequest {
	readonly name: string;
	readonly operationKey: string;
	readonly manifest: ManifestInput | null;
	readonly files: readonly AppFile[];
	/** A group of apps/groups.md the app is put in, last, when the file does not list it yet (APP-GROUPS-SPEC §3). */
	readonly group?: string;
}

/** Where save_app put the app in the drawer's layout. */
interface Grouped {
	readonly group: string;
	readonly placed: "added" | "already_listed";
}

/**
 * What save_app's schema says of `group` (APP-GROUPS-SPEC §3): the drawer's groups are organize_apps' work, and a new app
 * goes into one as it is made. On the field because the description holds 4096 bytes.
 */
const SAVE_APP_GROUP =
	"The id of a group of the apps drawer (organize_apps list shows them) to put this app in, last, as it is saved. Give it when you make an app that belongs to a group: to a product, a customer or a piece of work the drawer already groups. An app the layout already lists stays where it stands: organize_apps move moves it. Leave it out to leave the app loose. A group that does not exist is refused and nothing is saved; a concept never goes in a group, it shows inside Concepts.";

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

function groupId(value: JsonValue): string {
	if (typeof value !== "string" || !isAppGroupId(value))
		throw new CloudToolArgumentRefusal("group must be a group's id from organize_apps list, such as trips");
	return value;
}

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
	const keys = ["title", "about", "emblem", "colour", "entry", "reads", "writes", "concept", "cover", "kit"];
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
	let cover: string | null = null;
	if (value.cover !== undefined && value.cover !== null) {
		const relative = typeof value.cover === "string" ? appRelativePath(value.cover) : null;
		if (relative === null || !APP_COVER_KINDS.has(appFileKind(relative)))
			throw new CloudToolArgumentRefusal(
				"manifest.cover must be a relative path to a .png, .jpg or .webp picture of the app",
			);
		cover = relative;
	}
	if (value.concept !== undefined && value.concept !== null && typeof value.concept !== "boolean")
		throw new CloudToolArgumentRefusal("manifest.concept must be true or false");
	let reads: AppManifest["reads"] | null = null;
	if (value.reads !== undefined && value.reads !== null) {
		if (
			!Array.isArray(value.reads) ||
			value.reads.some((read) => typeof read !== "string" || !(APP_READS as readonly string[]).includes(read))
		)
			throw new CloudToolArgumentRefusal(`manifest.reads must be a list of ${APP_READS.join(", ")}`);
		reads = [...new Set(value.reads as AppManifest["reads"][number][])];
	}
	let writes: AppManifest["writes"] | null = null;
	if (value.writes !== undefined && value.writes !== null) {
		const parsed = parseAppWrites(value.writes);
		if ("problem" in parsed) throw new CloudToolArgumentRefusal(`manifest.${parsed.problem}`);
		writes = parsed.writes;
	}
	const kit = choice(value.kit, "manifest.kit", APP_KITS);
	if (kit !== null && entry !== null && entry !== APP_DEFAULT_ENTRY)
		throw new CloudToolArgumentRefusal(
			`manifest.entry: an app made from a kit opens ${APP_DEFAULT_ENTRY}; leave entry out`,
		);
	return {
		name: text(value.title, "manifest.title", 60, true) as string,
		about: text(value.about, "manifest.about", 200, false),
		emblem: choice(value.emblem, "manifest.emblem", INTERFACE_EMBLEMS),
		colour: choice(value.colour, "manifest.colour", AGENT_COLOURS),
		entry,
		reads,
		writes,
		concept: typeof value.concept === "boolean" ? value.concept : null,
		cover,
		kit,
	};
}

/** Whether a path of an app's folder is in its icons folder, in any case: such a file must be an icon. */
const inIcons = (relative: string): boolean => relative.toLowerCase().startsWith(`${APP_ICONS_FOLDER}/`);

/**
 * Refuses a save that would leave an app more than `APP_ICONS_MAX` icons: what members pick from stays a short row, and
 * a new icon takes an old one's id (a change of that file) or an old one is deleted first; save_app removes nothing.
 * `held` are the files the app's icons folder holds now, by lowercase path. A save that adds none leaves the app as
 * it is, however many it holds.
 */
function refuseTooManyIcons(files: readonly AppFile[], held: ReadonlyMap<string, CloudCompanyFolderEntry>): void {
	const added = files.filter((file) => inIcons(file.path) && !held.has(file.path.toLowerCase())).length;
	if (added === 0 || held.size + added <= APP_ICONS_MAX) return;
	const oldest = [...held.values()]
		.sort((a, b) => a.seq - b.seq || a.updatedAt.localeCompare(b.updatedAt) || a.path.localeCompare(b.path))
		.slice(0, 3)
		.map((entry) => {
			const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			return appIconIdOf(name) ?? name;
		});
	throw new CloudToolRefusal(
		held.size === 0
			? `APP_ICONS_FULL: an app keeps at most ${APP_ICONS_MAX} icons, and this save gives it ${added}; save at most ${APP_ICONS_MAX}`
			: `APP_ICONS_FULL: an app keeps at most ${APP_ICONS_MAX} icons, and this save would leave it ${held.size + added}: give each new icon the id of an old one it replaces (the oldest: ${oldest.join(", ")}), or delete old ones with company_delete first`,
	);
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
		// The web draws an icon from icons/<id>.svg (appIconPath): any other file there would be no icon.
		const icon = inIcons(relative);
		const iconName = relative.slice(APP_ICONS_FOLDER.length + 1);
		if (
			icon &&
			!(relative.startsWith(`${APP_ICONS_FOLDER}/`) && iconName.endsWith(".svg") && appIconIdOf(iconName) !== null)
		)
			throw new CloudToolArgumentRefusal(
				`${relative}: an app's own icon is ${APP_ICONS_FOLDER}/<id>.svg, its id lowercase letters, digits and hyphens, such as ${APP_ICONS_FOLDER}/compass.svg or ${APP_ICONS_FOLDER}/trail-sign.svg`,
			);
		const kind = appFileKind(relative);
		if (APP_BINARY_KINDS.has(kind))
			throw new CloudToolArgumentRefusal(
				`${relative}: a .${kind} file is not text; write it into the app's folder from a company machine, under /company/apps/<name>/`,
			);
		if (typeof file.text !== "string") throw new CloudToolArgumentRefusal(`${relative}: text must be UTF-8 text`);
		if (icon) {
			const drawn = parseAppIcon(file.text);
			if (!drawn.ok) throw new CloudToolArgumentRefusal(`${relative}: ${drawn.problem}`);
		}
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

/** The files a kit writes itself, which an agent's call may not name. */
const KIT_FILES: Readonly<Record<NonNullable<AppManifest["kit"]>, readonly string[]>> = {
	explainer: [EXPLAINER_ENGINE, EXPLAINER_PAGE],
	model: [KIT_ENGINE, KIT_PAGE],
	board: [KIT_ENGINE, KIT_PAGE],
	path: [KIT_ENGINE, KIT_PAGE],
	object: [KIT_ENGINE, KIT_PAGE, KIT_THREE, KIT_THREE_LICENSE],
	curve: [KIT_ENGINE, KIT_PAGE],
	stack: [KIT_ENGINE, KIT_PAGE],
	shelf: [KIT_ENGINE, KIT_PAGE],
	map: [KIT_ENGINE, KIT_PAGE],
	ring: [KIT_ENGINE, KIT_PAGE],
	flow: [KIT_ENGINE, KIT_PAGE],
	program: [],
};

/** The one file of a kit's app that its maker writes: an explainer's scenes, a data kit's data. */
const kitOwnFile = (kit: NonNullable<AppManifest["kit"]>): string =>
	kit === "explainer" ? EXPLAINER_SCENES : kit === "program" ? PROGRAM_FILE : kitDataFile(kit);

/** A data kit's data, read from its file's text; a file that does not read as the kit's data is refused, with why. */
function kitData(kit: DataKit, text: string): Readonly<Record<string, unknown>> {
	const parsed = parseKitData(kit, text);
	if ("problem" in parsed) throw new CloudToolRefusal(`APP_DATA_INVALID: ${parsed.problem}`);
	return parsed.data;
}

/** What the answer's look says when save_app added `data` to a kit app's reads. */
const DATA_READ_ADDED =
	"data was added to the app's reads: its data names a question of the company's databases, which the page reads live.";
/** What the answer's look says when save_app gave a stack's page the open questions and their answers. */
const STACK_ASKS_ADDED =
	"questions was added to the app's reads and answers to its writes: a stack's buttons answer the open questions that point at the app.";
/** What the answer's look says when save_app gave a stack's page the open questions only. */
const STACK_QUESTIONS_ADDED =
	"questions was added to the app's reads: a stack's cards show the open questions that point at the app.";
/** What the answer's look says when save_app gave a stack's page the answers only. */
const STACK_ANSWERS_ADDED =
	"answers was added to the app's writes: a stack's buttons answer the open questions that point at the app.";
/** What the answer's look says when save_app gave a map's page the company's reading. */
const MAP_READING_ADDED =
	"reading was added to the app's reads: a map's page reads the company's reading of itself and its agents' figures live.";
/** What the answer's look says when a stack's writes are full and hold no `answers`, which save_app cannot add. */
const STACK_WRITES_FULL = `answers could not be added to the app's writes, which already hold ${APP_WRITES_MAX} entries: a stack's buttons cannot answer the open questions that point at the app until answers replaces one of them.`;

/**
 * A kit app's manifest with what its page needs and its maker may not think of, and the look's line for each: `data`
 * in reads where its data names a question of the company's databases, and for a stack `questions` in reads and
 * `answers` in writes, since its cards' buttons answer the open questions that point at the app; for a map `reading` in
 * reads, when its first layer is the company's reading or a thing names an agent, whose figure the page finds there.
 * Never taken away: when `writes` is full without `answers`, a look line tells the agent to make room.
 */
function kitNeeds(
	kit: DataKit,
	data: Readonly<Record<string, unknown>>,
	manifest: AppManifest,
): { readonly manifest: AppManifest; readonly notes: readonly string[] } {
	let out = manifest;
	const notes: string[] = [];
	if (kitBindings(data).length > 0 && !out.reads.includes("data")) {
		out = { ...out, reads: [...out.reads, "data"] };
		notes.push(DATA_READ_ADDED);
	}
	if (kit === "stack") {
		const addQuestions = !out.reads.includes("questions");
		const hasAnswers = out.writes.includes(APP_WRITE_ANSWERS);
		const addAnswers = !hasAnswers && out.writes.length < APP_WRITES_MAX;
		if (addQuestions || addAnswers)
			out = {
				...out,
				reads: addQuestions ? [...out.reads, "questions"] : out.reads,
				writes: addAnswers ? [...out.writes, APP_WRITE_ANSWERS] : out.writes,
			};
		if (addQuestions && addAnswers) notes.push(STACK_ASKS_ADDED);
		else if (addQuestions) notes.push(STACK_QUESTIONS_ADDED);
		else if (addAnswers) notes.push(STACK_ANSWERS_ADDED);
		// writes are full without answers: the agent must make room, since save_app never takes an entry away
		if (!hasAnswers && !addAnswers) notes.push(STACK_WRITES_FULL);
	}
	if (kit === "map" && !out.reads.includes("reading") && mapReadsReading(data)) {
		out = { ...out, reads: [...out.reads, "reading"] };
		notes.push(MAP_READING_ADDED);
	}
	return { manifest: out, notes };
}

/** A map whose first layer is the company's reading, or one of whose things names an agent. */
function mapReadsReading(data: Readonly<Record<string, unknown>>): boolean {
	if (data.top === "reading") return true;
	const names = (layer: unknown) =>
		typeof layer === "object" &&
		layer !== null &&
		Array.isArray((layer as { things?: unknown }).things) &&
		(layer as { things: unknown[] }).things.some(
			(thing) =>
				typeof thing === "object" &&
				thing !== null &&
				Array.isArray((thing as { agents?: unknown }).agents) &&
				(thing as { agents: unknown[] }).agents.length > 0,
		);
	const layers = typeof data.layers === "object" && data.layers !== null ? Object.values(data.layers) : [];
	return names(data.top) || layers.some(names);
}

/** Refuses a call that writes a file of the app's kit: the kit's files are Qorpera's, the same in every such app. */
function refuseKitFiles(kit: NonNullable<AppManifest["kit"]>, files: readonly AppFile[]): void {
	const own = files.find((file) => KIT_FILES[kit].includes(file.path.toLowerCase()));
	if (own)
		throw new CloudToolRefusal(
			`APP_KIT_FILE: ${own.path} is the ${kit} kit's own file, which save_app writes; leave it out and give ${kitOwnFile(kit)}`,
		);
}

const contentOf = (path: string, text: string) => ({
	text,
	mediaType: APP_FILE_TYPES[appFileKind(path)] ?? "text/plain",
});

/** A page past this many words a member would read is a document. */
const LOOK_WORDS = 250;
/** A page of more words than this with nothing to look at gets a note. */
const LOOK_WORDS_UNSHOWN = 80;
/** This many folded sections hide what the page is for. */
const LOOK_FOLDED = 3;

/** `text` without each block from `open` to `close` (to the end when one is never closed), in one pass. */
function withoutBlocks(text: string, open: RegExp, close: RegExp): string {
	let out = "";
	let at = 0;
	for (;;) {
		open.lastIndex = at;
		const from = open.exec(text);
		if (from === null) return out + text.slice(at);
		out += `${text.slice(at, from.index)} `;
		close.lastIndex = from.index + from[0].length;
		const to = close.exec(text);
		if (to === null) return out;
		at = to.index + to[0].length;
	}
}

/**
 * Whether a link in an app's page opens when a member clicks it, by the form of its address: a quick mirror of the
 * web's check (packages/web/src/app/interface-apps.ts `appLink`), which is the one that decides. A jump inside the page
 * is the page's own. A `javascript:` address opens nothing: the browser runs none in an app's frame.
 */
function linkOpens(href: string): boolean {
	if (href.startsWith("#") || /^https?:/i.test(href) || appLinkName(href) !== undefined) return true;
	if (!href.startsWith("folder:")) return false;
	try {
		const top = companyPathKey(decodeURIComponent(href.slice("folder:".length))).split("/")[0] ?? "";
		return top !== "" && !APP_CLOSED_FOLDERS.includes(top);
	} catch {
		return false;
	}
}

/**
 * What a quick read of an app's entry page finds, told to the agent after a save: advice, never a refusal (Jonas,
 * 10 November 2026, on a company whose seven agent-made apps held 68 links that open nothing, 36 folded sections and
 * about 6,000 words, and six of them no picture, chart or diagram). It reads the page's text alone, so a replayed save
 * answers the same notes, and in one pass over the page, whatever an agent wrote into it:
 * - links that open nothing: the web opens an `app:`, `folder:` or web link when a member clicks it (`linkOpens`), and
 *   nothing else; a jump inside the page (`#`) is the page's own;
 * - folded sections (`<details>`), which hide what a member came to see;
 * - the words a member would read, outside scripts and styles;
 * - a page of text with nothing to look at: no picture, drawing, canvas or video, in the markup or made by a script.
 * How the page looks stays the agent's to check, on a machine (save_app's description).
 */
export function appLookNotes(html: string): string[] {
	const page = withoutBlocks(html, /<!--/g, /-->/g);
	const markup = withoutBlocks(withoutBlocks(page, /<script\b/gi, /<\/script\s*>/gi), /<style\b/gi, /<\/style\s*>/gi);
	let read = "";
	const dead: string[] = [];
	let folded = 0;
	let at = 0;
	for (;;) {
		const from = markup.indexOf("<", at);
		const to = from < 0 ? -1 : markup.indexOf(">", from);
		if (to < 0) break;
		read += `${markup.slice(at, from)} `;
		const tag = markup.slice(from + 1, to);
		if (/^details\b/i.test(tag)) folded++;
		const href = /^a\s/i.test(tag) ? /\shref\s*=\s*["']?\s*([^"'\s]*)/i.exec(tag) : null;
		if (href?.[1] && !linkOpens(href[1])) dead.push(href[1].length > 80 ? `${href[1].slice(0, 80)}…` : href[1]);
		at = to + 1;
	}
	read += markup.slice(at);
	const words = read
		.replace(/&[a-z0-9#]+;/gi, " ")
		.split(/\s+/)
		.filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
	const shown = /<(?:img|svg|canvas|video|picture)\b|createElementNS|getContext\(|url\(/i.test(page);
	const notes: string[] = [];
	if (dead.length > 0)
		notes.push(
			`${dead.length} ${dead.length === 1 ? "link opens" : "links open"} nothing (${dead.slice(0, 3).join(", ")}${dead.length > 3 ? ", …" : ""}): a link opens another app (app:<name>), a file of the company's own work (folder:<path>, never under QorperaOS/), a web page (https://…) or a place in the page (#id). For anything else, such as a tab, use a button with a click handler.`,
		);
	if (folded >= LOOK_FOLDED)
		notes.push(
			`${folded} folded sections (<details>): a member sees only what is open. Show what matters and leave the rest out.`,
		);
	if (words > LOOK_WORDS)
		notes.push(
			`${words} words: a member would have to read this, so it is a document, not an app. Show the thing itself with a kit (model, board, path, object, curve, stack, shelf, map, ring, flow or explainer: kit's schema says what each draws), and keep the text in its file.`,
		);
	if (!shown && words > LOOK_WORDS_UNSHOWN)
		notes.push(
			"Nothing to look at, only text: an app shows a thing to look at and handle. Make it with a kit (model, board, path, object, curve, stack, shelf, map, ring, flow or explainer: kit's schema says what each draws).",
		);
	return notes;
}

/** What a quick read of what a call wrote finds: of an explainer its scenes, of any other app its entry page; nothing
 * when the call wrote neither. */
function lookNotes(files: readonly AppFile[], kit: AppManifest["kit"], entry: string): string[] {
	const path = kit === "explainer" ? EXPLAINER_SCENES : entry.toLowerCase();
	const written = files.find((file) => file.path.toLowerCase() === path)?.text;
	if (written === undefined) return [];
	return kit === "explainer" ? explainerNotes(written) : appLookNotes(written);
}

/** Where the app stands in the drawer's layout after the commit, by the layout unit's own outcome. */
function groupPlaced(grouped: Grouped, units: readonly CloudCompanyFolderUnitResult[]): string {
	if (grouped.placed === "already_listed")
		return "not moved: the drawer's layout already lists it; organize_apps move moves it";
	const unit = units.find((each) => companyPathKey(each.path) === companyPathKey(APP_GROUPS_PATH));
	return unit?.outcome === "saved"
		? "last in the group"
		: `not placed (${unit?.reason ?? unit?.outcome ?? "not saved"}): organize_apps move puts it in the group`;
}

/** The look's line for an app at one of the folders of the views the company is owed (`OWED_APPS`; company views
 * step 4, lanes/company-views-20261114/DESIGN-4.md): the web shows it first in the apps drawer. A concept is none: it
 * shows inside Concepts. */
export function owedAppNote(name: string, concept: boolean): string | null {
	const owed = OWED_APPS.find((each) => each === name);
	return owed && !concept ? `This is the company's ${owed} view: members find it first in the apps drawer.` : null;
}

/** What the model is told after a commit, by each unit's outcome. `notes` is what a quick read of what this call
 * wrote found (`lookNotes`); `owed` is the line of an owed view (`owedAppNote`), told beside them and nothing to fix.
 * A call that wrote icons alone answers where the member picks one. */
function savedText(
	request: { name: string; operationKey: string; files: readonly AppFile[] },
	receiptId: string,
	units: readonly CloudCompanyFolderUnitResult[],
	created: boolean,
	notes: readonly string[],
	grouped: Grouped | null,
	owed: string | null,
): string {
	const saved = units.filter((unit) => unit.outcome === "saved").length;
	const state = saved === units.length ? "applied" : saved === 0 ? "not_applied" : "partly_applied";
	const conflict = units.some((unit) => unit.outcome === "conflict");
	const drawn = request.files.length > 0 && request.files.every((file) => inIcons(file.path));
	const fix = state === "applied" ? notes : [];
	const look = state === "applied" && owed && !drawn ? [...fix, owed] : fix;
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
		...(look.length > 0 ? { look } : {}),
		...(grouped ? { group: grouped.group, groupPlaced: groupPlaced(grouped, units) } : {}),
		next:
			state === "applied" && drawn
				? "Saved. Tell the member in one line what you drew, and that they pick one under Icon and colour in the app's menu in the apps drawer."
				: state === "applied"
					? `Saved. ${fix.length > 0 ? "First fix what look names, unless it does not fit this page. Then show" : "Show"} it to the member with a link in your message: [${request.name}](app:${request.name}). post_app shows it to every member in their apps.`
					: conflict
						? "Some files changed while this call saved them: read the app's files again, then call again with a new operationKey."
						: "Some files were not saved (their reasons): fix them and call again with a new operationKey.",
	});
}

/** The interface app tools of a folder-v2 run. `operations` takes the receipts of their changes. They are made once
 * for a run's attempt and hold which guides it has read: a run that goes on in a new attempt reads a kit's guide again
 * before it writes the kit's file, as it does when its context no longer holds the guide. */
export function cloudAppTools(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
	clock?: () => Date;
}): CloudNativeTool[] {
	const { folder, operations, identity } = options;
	const clock = options.clock ?? (() => new Date());
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
	// The guides this run has read (app_guide).
	const guided = new Set<AppGuide>();
	// A kit's own file is saved only in a run that has read the kit's guide: its fields, their bounds and its example
	// are nowhere else, and a file written without them passes the few checks a save can make and draws an empty or
	// broken page (14 November 2026). Thrown before the call began anything, and it speaks of this call alone: a call
	// an earlier attempt of the run completed is refused here too, in an attempt that has not read the guide, and made
	// again after the read it replays its receipt, as any repeated call does.
	const refuseUnread = (kit: AppManifest["kit"], files: readonly AppFile[]): void => {
		if (kit === null || guided.has(kit)) return;
		const own = kitOwnFile(kit);
		if (files.some((file) => file.path.toLowerCase() === own))
			throw new CloudToolRefusal(
				`APP_GUIDE_UNREAD: this call saved nothing. Read the ${kit} kit's guide first: it says what ${own} holds and gives an example. Call app_guide with about ${kit}, check ${own} against it, then make this call again.`,
			);
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
		// Its fields say a line each since #1804 (the guides are app_guide's answers), so its schema stays under the 5,000
		// bytes past which Codex sends no field description (T3-5's probe); what a call needs stands here.
		description: [
			"Make or change an interface app: a small web page in apps/<name>/ that lets members see and handle one thing of the company (an object to turn, a model to try, an app to use, a video to watch), opened as a page of its own. Text to read stays a file. It applies at once.",
			`- name: the app's folder (lowercase letters, digits and hyphens). manifest: title, and optionally about, emblem, colour, kit, entry (the page that opens, ${APP_DEFAULT_ENTRY} by default), reads, writes, concept and cover; null keeps the manifest. A new app needs a manifest and its entry, which a kit writes. group: a group of the apps drawer (organize_apps list) to put a new app in, last; a concept goes in none.`,
			`- files: at most ${FILES_PER_CALL} text files a call (a page, its styles, scripts and data), each as large as one call carries. An app has no other bound on its files: any number, size or kind. Pictures, video, sound, fonts and 3D models are files in its folder too, written from a company machine and named by their path.`,
			"Kits draw nearly every app: you write the kit's one file among files (<kit>.json, such as model.json; an explainer's scenes.js), and save_app writes index.html and engine.js, which you never write or edit. What the file holds is in the kit's guide (app_guide): a kit's file is saved only in a run that has read it, else APP_GUIDE_UNREAD and nothing is saved. Change the data with save_app, not company_write. A kit's page shows the pictures its data names that are in the folder when you save: write them first, or save the data again after. A program people install is kit program: copy each build into versions/<version>/ from a machine, then save program.json (app_guide program).",
			"A page you write by hand (the product's own prototype, or a working tool no kit draws) is the entry alone, so every view is in it, as tabs or sections. It opens at once and reads each of its files when it uses it, by a relative path: <img src>, <video src>, <audio src>, a poster, url() in its styles (a font's @font-face too), and in a script fetch(path), qorpera.file(path) for an address or qorpera.bytes(path) for the bytes, so a 3D, font or sound library loads its files as anywhere. No page has a network. The thing fills the first screen, on a laptop and on a phone (about 390 px wide, one column, nothing cut off): a title of two or three words, at most one short line, then the thing; labels and numbers, not sentences, boxes of text, a date or a list of what you did; what is not known yet drawn as open, such as a dashed outline or a question mark, not written about. Give it something to do: a control that changes what it shows, or a choice a member makes (writes). A prototype of the product follows the product's own design instead. Every page starts from Qorpera's base style with the company's colours as CSS variables (--q-bg, --q-text, --q-muted, --q-line, --q-surface, --q-accent, --q-on-accent, --q-accent-soft, --q-good, --q-warn, --q-bad): use them, not colours of your own (app_guide style).",
			"Live data: a page's script reads the company through the qorpera object (qorpera.read, list, table, todos, agents, questions; reads names its sources) and asks a member to change an answer or a table row (qorpera.answer, setRow, addRow; writes names them). Qorpera shows the member what will be saved, and only their yes saves it. app_guide reads and writes say how.",
			"Links open on a member's click: app:<name> another app, folder:<path> a file of the company's own work, https://… a web page in a new tab, #id a place in the page; nothing else opens.",
			"A concept (concept true, cover a picture of it) shows in the Concepts viewer, full screen beside Qorpera's own panel, which names it and says who made it: its page is the visual, edge to edge, with no title, strapline, caption, frame or band, only the few controls it needs, small and at the visual, and no base style.",
			"The answer's look names what a read of the saved app found: fix it, unless it does not fit this app. One operationKey for one change; a new change takes a new one.",
		].join("\n"),
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
						emblem: {
							type: ["string", "null"],
							enum: [...INTERFACE_EMBLEMS, null],
							description: SAVE_APP_EMBLEM,
						},
						colour: { type: ["string", "null"], enum: [...AGENT_COLOURS, null] },
						entry: { type: ["string", "null"], maxLength: 1024 },
						reads: {
							type: ["array", "null"],
							items: { type: "string", enum: [...APP_READS] },
							description:
								"The live sources a page written by hand may read through the qorpera object: app_guide reads says how. A kit's page reads its own data by itself.",
						},
						writes: {
							type: ["array", "null"],
							maxItems: APP_WRITES_MAX,
							items: { type: "string", maxLength: 80 },
							description:
								"What a page written by hand may ask a member to change, of answers and table:<name>, saved only on the member's yes: app_guide writes says how.",
						},
						concept: { type: ["boolean", "null"] },
						cover: { type: ["string", "null"], maxLength: 1024 },
						kit: { type: ["string", "null"], enum: [...APP_KITS, null], description: APP_KIT_CHOICE },
					},
				},
				group: { type: "string", maxLength: 46, description: SAVE_APP_GROUP },
				files: {
					type: "array",
					maxItems: FILES_PER_CALL,
					description: `The files to write, by their path in the app's folder: a kit's one file, or a page written by hand with its styles, scripts and data (app_guide style says what every such page starts from). An app's own icons are ${APP_ICONS_FOLDER}/<id>.svg: app_guide icons says how to draw them.`,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["path", "text"],
						properties: {
							path: { type: "string", maxLength: 1024 },
							text: { type: "string", maxLength: MAX_TOOL_ARGUMENT_BYTES },
						},
					},
				},
			},
		},
		parseArguments(value) {
			// group is the one field a call may leave out.
			const given = value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
			const { group, ...rest } = given ?? {};
			const input = args(given === null ? value : rest, "save_app", ["name", "operationKey", "manifest", "files"]);
			const request: SaveRequest = {
				name: appName(input.name),
				operationKey: operationKey(input.operationKey),
				manifest: parseManifest(input.manifest),
				files: parseFiles(input.files),
				...(group === undefined || group === null ? {} : { group: groupId(group) }),
			};
			if (request.manifest === null && request.files.length === 0)
				throw new CloudToolArgumentRefusal("give a manifest, files, or both");
			return request as unknown as JsonValue;
		},
		// Another agent's app, or a member's, is changed only after the automatic review (review r2, H-1): the panel names
		// its owner to members. Read before the review, so its effect class is the one that runs.
		async prepare(value, context) {
			const request = value as unknown as SaveRequest;
			// A retired interface is the members' alone (cloud-folder-app-retired.ts): neither changed nor made again under
			// its name, refused before the review.
			await refuseRetiredApp(folder, request.name, context.signal, "saved");
			const stored = await manifestText(`${appFolder(request.name)}/${APP_MANIFEST}`, context.signal);
			const parsed = stored !== null && stored !== "unreadable" ? parseAppManifest(stored.text) : null;
			const foreign = parsed?.ok === true && parsed.manifest.owner !== owner;
			return foreign ? ({ ...request, foreignOwner: true } as unknown as JsonValue) : value;
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
			// Again at the save, since a member may have retired it since the review: the read is released with the answer.
			const retired = await refuseRetiredApp(folder, request.name, context.signal, "saved");
			if (retired.entry) reads.push(retired.entry);
			const at = await read(root, context.signal);
			if (at !== null && at.kind !== "folder")
				throw new CloudToolRefusal(
					`APP_NOT_A_FOLDER: ${root} is a ${at.kind === "file" ? "file" : "link"}, not an app's folder`,
				);
			const digest: Record<string, JsonValue> = {
				name: request.name,
				manifestSha256: sha256hex(JSON.stringify(request.manifest)),
				files: request.files.map((file) => ({ path: file.path, textSha256: sha256hex(file.text) })),
				...(request.group ? { group: request.group } : {}),
			};
			// The app's place in the drawer's layout, read and checked before anything is written; its unit goes in the
			// same commit as the app's own.
			const place = async (concept: boolean): Promise<Grouped | null> => {
				if (!request.group) return null;
				if (concept)
					throw new CloudToolRefusal(
						"APP_GROUP_CONCEPT: a concept shows inside Concepts in the drawer, never in a group; leave group out",
					);
				const placed = await placeAppInGroup(folder, request.name, request.group, context.signal);
				reads.push(placed.read);
				if (placed.unit) groupUnits.push(placed.unit);
				return { group: request.group, placed: placed.placed };
			};
			const groupUnits: CloudCompanyFolderUnit[] = [];
			if (at === null) {
				// A new app: its whole folder in one unit, the apps folder with it when the company has none yet.
				if (request.manifest === null)
					throw new CloudToolRefusal("APP_NOT_FOUND: no app has that name; give a manifest to make it");
				let manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? "page",
					colour: request.manifest.colour,
					entry: request.manifest.entry ?? APP_DEFAULT_ENTRY,
					owner,
					posted: false,
					reads: request.manifest.reads ?? [],
					writes: request.manifest.writes ?? [],
					concept: request.manifest.concept ?? false,
					cover: request.manifest.cover,
					kit: request.manifest.kit,
				};
				refuseUnread(manifest.kit, request.files);
				// A kit's own files go in with the agent's: for an explainer the engine and the page, around its scenes.
				let files = request.files;
				if (manifest.kit === "explainer") {
					refuseKitFiles(manifest.kit, files);
					if (!files.some((file) => file.path.toLowerCase() === EXPLAINER_SCENES))
						throw new CloudToolRefusal(
							`APP_SCENES_MISSING: a new explainer needs its ${EXPLAINER_SCENES} among files`,
						);
					files = [
						...files,
						{ path: EXPLAINER_ENGINE, text: EXPLAINER_ENGINE_JS },
						{ path: EXPLAINER_PAGE, text: explainerPage(manifest.name, []) },
					];
				}
				// For a data kit the engine and the page, around its data: a new app's folder holds no picture yet, so the
				// page names the pictures this call writes (an .svg), and the look says which the data names beyond them.
				let look: string[] | null = null;
				if (isDataKit(manifest.kit)) {
					const kit = manifest.kit;
					refuseKitFiles(kit, files);
					const dataText = files.find((file) => file.path.toLowerCase() === kitDataFile(kit))?.text;
					if (dataText === undefined)
						throw new CloudToolRefusal(
							`APP_DATA_MISSING: a new ${kit} app needs its ${kitDataFile(kit)} among files`,
						);
					const data = kitData(kit, dataText);
					const written = new Set(request.files.map((file) => file.path.toLowerCase()));
					const holds = (path: string) => written.has(path.toLowerCase());
					const needs = kitNeeds(kit, data, manifest);
					manifest = needs.manifest;
					look = [...kitNotes(kit, data, holds), ...needs.notes];
					files = [
						...files,
						{ path: KIT_ENGINE, text: KIT_ENGINE_JS[kit] },
						{ path: KIT_PAGE, text: kitPage(request.name, kit, manifest.name, data, holds, manifest.concept) },
						...kitLibrary(kit, data),
					];
				}
				if (manifest.kit === "program") {
					const given = files.find((file) => file.path.toLowerCase() === PROGRAM_FILE)?.text;
					if (given === undefined)
						throw new CloudToolRefusal(
							`APP_DATA_MISSING: a new program app needs its ${PROGRAM_FILE} among files`,
						);
					keepProgram({
						app: request.name,
						handIn: programHandIn(given),
						kept: null,
						file: () => undefined,
						now: clock(),
					});
				}
				if (!files.some((file) => file.path.toLowerCase() === manifest.entry.toLowerCase()))
					throw new CloudToolRefusal(
						`APP_ENTRY_MISSING: a new app needs its entry, ${manifest.entry}, among files`,
					);
				refuseTooManyIcons(files, new Map());
				const contents: CloudCompanyFolderNewEntry[] = [
					{
						path: APP_MANIFEST,
						kind: "file",
						content: { text: writeAppManifest(manifest), mediaType: "application/toml" },
					},
					...foldersOf(files.map((file) => file.path)).map((path) => ({ path, kind: "folder" as const })),
					...files.map((file) => ({
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
				const grouped = await place(manifest.concept);
				const answer = await commit(
					"save_app",
					request,
					digest,
					[unit, ...groupUnits],
					(receiptId, units) =>
						savedText(
							request,
							receiptId,
							units,
							true,
							look ?? lookNotes(request.files, manifest.kit, manifest.entry),
							grouped,
							owedAppNote(request.name, manifest.concept),
						),
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
			const before = storedParse?.ok ? storedParse.manifest : null;
			// The kit and the title the app has after this call: the kit's page is written from them below.
			let kit = before?.kit ?? null;
			let title = before?.name ?? request.name;
			let concept = before?.concept ?? false;
			// The manifest this call writes: the one given, or the stored one when its kit's data names a question below.
			let manifestOut: AppManifest | null = null;
			if (request.manifest !== null) {
				const manifest: AppManifest = {
					name: request.manifest.name,
					about: request.manifest.about,
					emblem: request.manifest.emblem ?? before?.emblem ?? "page",
					colour: request.manifest.colour ?? before?.colour ?? null,
					entry: request.manifest.entry ?? before?.entry ?? APP_DEFAULT_ENTRY,
					owner: before?.owner ?? owner,
					posted: before?.posted ?? false,
					reads: request.manifest.reads ?? before?.reads ?? [],
					writes: request.manifest.writes ?? before?.writes ?? [],
					concept: request.manifest.concept ?? before?.concept ?? false,
					cover: request.manifest.cover ?? before?.cover ?? null,
					kit: request.manifest.kit ?? before?.kit ?? null,
				};
				if (manifest.kit !== null && manifest.entry !== APP_DEFAULT_ENTRY)
					throw new CloudToolRefusal(
						`APP_KIT_ENTRY: an app made from a kit opens ${APP_DEFAULT_ENTRY}; give manifest.entry ${APP_DEFAULT_ENTRY}`,
					);
				entry = manifest.entry;
				kit = manifest.kit;
				title = manifest.name;
				concept = manifest.concept;
				if (stored === "unreadable")
					throw new CloudToolRefusal(
						`APP_MANIFEST_UNREADABLE: ${manifestPath} is not text; replace it on a machine`,
					);
				manifestOut = manifest;
			} else if (storedParse?.ok) entry = storedParse.manifest.entry;
			else
				throw new CloudToolRefusal(
					`APP_MANIFEST_INVALID: ${manifestPath} is missing or has problems; give a manifest to write it again`,
				);
			refuseUnread(kit, request.files);
			// The app's totals, with this call's files in place of the ones they replace.
			const listed = await listWhole(folder, root, context.signal).catch((error) => unavailable(error, "saved"));
			const inApp = new Map(listed.map((item) => [item.path.slice(root.length + 1).toLowerCase(), item]));
			const drawnOn = new Set<CloudCompanyFolderEntry>();
			const byKey = {
				get(key: string): CloudCompanyFolderEntry | undefined {
					const found = inApp.get(key);
					if (found && !drawnOn.has(found)) {
						drawnOn.add(found);
						reads.push(found);
					}
					return found;
				},
				has(key: string): boolean {
					return byKey.get(key) !== undefined;
				},
			};
			// A kit's own files, written where the folder holds none or other text: the engine of this runtime, and the
			// page with the title as it is now and the voice clips the folder holds. A save of scenes.js alone leaves
			// them as they are.
			let files = request.files;
			if (kit === "explainer") {
				refuseKitFiles(kit, files);
				const given = (path: string) => files.find((file) => file.path.toLowerCase() === path)?.text;
				if (byKey.get(EXPLAINER_SCENES)?.kind !== "file" && given(EXPLAINER_SCENES) === undefined)
					throw new CloudToolRefusal(
						`APP_SCENES_MISSING: the explainer's ${EXPLAINER_SCENES} is not in its folder; write it among files`,
					);
				let listedClips = given(EXPLAINER_CLIPS) ?? null;
				if (listedClips === null && byKey.get(EXPLAINER_CLIPS)?.kind === "file")
					listedClips = await folder
						.readText(`${root}/${EXPLAINER_CLIPS}`, EXPLAINER_CLIPS_MAX_BYTES, context.signal)
						.then(
							(found) => found?.text ?? null,
							(error) => (error instanceof CloudCompanyPathNotText ? null : unavailable(error, "saved")),
						);
				const clips = (listedClips === null ? [] : parseExplainerClips(listedClips)).filter(
					(clip) => byKey.get(`voice/${clip.file}`)?.kind === "file",
				);
				for (const file of [
					{ path: EXPLAINER_ENGINE, text: EXPLAINER_ENGINE_JS },
					{ path: EXPLAINER_PAGE, text: explainerPage(title, clips) },
				]) {
					const found = byKey.get(file.path);
					if (found?.kind !== "file" || found.file.fileSha256 !== sha256hex(file.text)) files = [...files, file];
				}
			}
			// A data kit's own files, the same way: the engine of this runtime, and the page with the title as it is now
			// and every picture the data names that the folder holds. The data is this call's, or the folder's when the
			// call gives none, so a save after a machine wrote the pictures names them in the page.
			let look: string[] | null = null;
			if (isDataKit(kit)) {
				refuseKitFiles(kit, files);
				const dataPath = kitDataFile(kit);
				let dataText = files.find((file) => file.path.toLowerCase() === dataPath)?.text ?? null;
				if (dataText === null && byKey.get(dataPath)?.kind === "file")
					dataText = await folder.readText(`${root}/${dataPath}`, KIT_DATA_MAX_BYTES, context.signal).then(
						(found) => found?.text ?? null,
						(error) => (error instanceof CloudCompanyPathNotText ? null : unavailable(error, "saved")),
					);
				if (dataText === null)
					throw new CloudToolRefusal(
						`APP_DATA_MISSING: the ${kit} app's ${dataPath} is not in its folder; write it among files`,
					);
				const data = kitData(kit, dataText);
				const written = new Set(request.files.map((file) => file.path.toLowerCase()));
				const holds = (path: string) =>
					written.has(path.toLowerCase()) || byKey.get(path.toLowerCase())?.kind === "file";
				look = kitNotes(kit, data, holds);
				look.push(
					...kitHeavyPictures(kit, data, (path) => {
						const key = path.toLowerCase();
						const found = written.has(key) ? undefined : byKey.get(key);
						return found?.kind === "file" ? found.file.bytes : undefined;
					}),
				);
				// Data that names a question reads the company's databases, and a stack answers questions: what the page
				// needs joins the manifest, never leaves it.
				const reading = manifestOut ?? before;
				if (reading !== null) {
					const needs = kitNeeds(kit, data, reading);
					if (needs.manifest !== reading) manifestOut = needs.manifest;
					look.push(...needs.notes);
				}
				for (const file of [
					{ path: KIT_ENGINE, text: KIT_ENGINE_JS[kit] },
					{ path: KIT_PAGE, text: kitPage(request.name, kit, title, data, holds, concept) },
					...kitLibrary(kit, data),
				]) {
					const found = byKey.get(file.path);
					if (found?.kind !== "file" || found.file.fileSha256 !== sha256hex(file.text)) files = [...files, file];
				}
			}
			if (kit === "program") {
				const given = files.find((file) => file.path.toLowerCase() === PROGRAM_FILE);
				const keptEntry = byKey.get(PROGRAM_FILE);
				if (given === undefined && keptEntry?.kind !== "file")
					throw new CloudToolRefusal(
						`APP_DATA_MISSING: the program app's ${PROGRAM_FILE} is not in its folder; write it among files`,
					);
				if (given !== undefined) {
					const handIn = programHandIn(given.text);
					const keptText =
						keptEntry?.kind === "file"
							? await folder.readText(`${root}/${PROGRAM_FILE}`, PROGRAM_FILE_MAX_BYTES, context.signal).then(
									(found) => found?.text ?? null,
									(error) => (error instanceof CloudCompanyPathNotText ? "" : unavailable(error, "saved")),
								)
							: null;
					const kept = keptText === null ? null : parseProgram(keptText);
					if (keptText !== null && kept === null)
						throw new CloudToolRefusal(
							`APP_DATA_INVALID: this call saved nothing. The app's ${PROGRAM_FILE} as kept does not read as a program's versions: delete it with company_delete and save again (the files in versions/ stay).`,
						);
					const fileAt = (path: string) => {
						const found = byKey.get(path.toLowerCase());
						return found?.kind === "file" ? found : undefined;
					};
					const program = keepProgram({ app: request.name, handIn, kept, file: fileAt, now: clock() });
					look = [...program.notes];
					files = files.map((file) => (file === given ? { path: file.path, text: program.text } : file));
				}
			}
			if (manifestOut !== null) {
				const textOut = writeAppManifest(manifestOut);
				units.push(
					stored === null || stored === "unreadable"
						? { op: "write", path: manifestPath, content: { text: textOut, mediaType: "application/toml" } }
						: {
								op: "write",
								path: manifestPath,
								content: { text: textOut, mediaType: stored.entry.file.mediaType },
								expectedVersion: stored.entry.version,
							},
				);
			}
			const icons = [...inApp].filter(([path, item]) => item.kind === "file" && inIcons(path));
			for (const [path] of icons) byKey.get(path);
			refuseTooManyIcons(files, new Map(icons));
			for (const folderPath of foldersOf(files.map((file) => file.path))) {
				const found = byKey.get(folderPath.toLowerCase());
				if (found === undefined) units.push({ op: "mkdir", path: `${root}/${folderPath}` });
				else if (found.kind !== "folder")
					throw new CloudToolRefusal(`APP_NOT_A_FOLDER: ${root}/${folderPath} is a file, not a folder`);
			}
			for (const file of files) {
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
				kit !== "program" &&
				!byKey.has(entry.toLowerCase()) &&
				!files.some((file) => file.path.toLowerCase() === entry.toLowerCase())
			)
				throw new CloudToolRefusal(
					`APP_ENTRY_MISSING: the app's entry, ${entry}, is not in its folder; write it among files`,
				);
			const grouped = await place(concept);
			const answer = await commit(
				"save_app",
				request,
				digest,
				[...units, ...groupUnits],
				(receiptId, results) =>
					savedText(
						request,
						receiptId,
						results,
						false,
						look ?? lookNotes(request.files, kit, entry),
						grouped,
						owedAppNote(request.name, concept),
					),
				context,
			);
			return showCommitted(context, answer, reads);
		},
	};

	const postApp: CloudNativeTool = {
		name: "post_app" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description:
			"Post an interface app so every member sees it in their apps drawer (posted true), or take it away (posted false). The app stays in the company folder either way, and a link to it in a message still opens it. Post what members should keep coming back to: the state of an area, a dashboard, a board, a living plan.",
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
		// Its own app posts at once; another agent's or a member's goes through the automatic review. Read before the
		// review, so its effect class is the one that runs, and bound to that read: the post writes only the manifest
		// version read here, so an app made or changed in between is refused, never posted under the wrong class.
		async prepare(value, context) {
			const request = value as unknown as { name: string };
			// A retired interface is posted or taken away by no agent, refused before the review.
			await refuseRetiredApp(folder, request.name, context.signal, "saved");
			const stored = await manifestText(`${appFolder(request.name)}/${APP_MANIFEST}`, context.signal);
			const parsed = stored !== null && stored !== "unreadable" ? parseAppManifest(stored.text) : null;
			// A manifest that cannot be read or does not parse names no owner: it is reviewed as another's.
			const foreign = parsed === null ? stored === "unreadable" : !parsed.ok || parsed.manifest.owner !== owner;
			return {
				...(value as Record<string, JsonValue>),
				checkedVersion: stored !== null && stored !== "unreadable" ? stored.entry.version : null,
				...(foreign ? { foreignOwner: true } : {}),
			} as JsonValue;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as {
				name: string;
				operationKey: string;
				posted: boolean;
				checkedVersion?: string | null;
			};
			writable();
			const retired = await refuseRetiredApp(folder, request.name, context.signal, "saved");
			const path = `${appFolder(request.name)}/${APP_MANIFEST}`;
			const stored = await manifestText(path, context.signal);
			// The review judged the manifest read in prepare: one made or changed since is not the one it judged.
			if (
				request.checkedVersion !== undefined &&
				(stored === null || stored === "unreadable" ? null : stored.entry.version) !== request.checkedVersion
			)
				throw new CloudToolRefusal("APP_CHANGED: the app changed while this post was checked; post it again");
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
					[stored.entry, ...(retired.entry ? [retired.entry] : [])].map(cloudCompanyFolderRelease),
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
			return showCommitted(context, answer, [stored.entry, ...(retired.entry ? [retired.entry] : [])]);
		},
	};

	const appGuideTool: CloudNativeTool = {
		name: "app_guide" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: APP_GUIDE_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["about"],
			properties: { about: { type: "string", enum: [...APP_GUIDES] } },
		},
		parseArguments(value) {
			const about = args(value, "app_guide", ["about"]).about;
			if (!isAppGuide(about)) throw new CloudToolArgumentRefusal(`about must be one of ${APP_GUIDES.join(", ")}`);
			return { about };
		},
		async execute(value, context) {
			const about = (value as { about: AppGuide }).about;
			// Read once the answer is on its way: a guide that could not be shown was not read.
			const shown = await released(folder, identity.runId, context, appGuide(about), []);
			guided.add(about);
			return shown;
		},
	};

	return [saveApp, postApp, appGuideTool];
}
