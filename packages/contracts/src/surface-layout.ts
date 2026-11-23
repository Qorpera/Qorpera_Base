import { WireValueError } from "./wire-values.ts";

export const SURFACE_LAYOUT_PATH = "layout.json";
export const SURFACE_LAYOUT_SCHEMA = "qorpera.surface-layout/v1";
export const SURFACE_LAYOUT_MAX_BYTES = 64 * 1024;
export const SURFACE_LAYOUT_MAX_TABS = 12;
export const SURFACE_LAYOUT_MAX_TAB_NODES = 24;
export const SURFACE_LAYOUT_MAX_BLOCKS = 64;
export const SURFACE_LAYOUT_TAB_TITLE_CHARS = 40;
export const SURFACE_LAYOUT_HEADING_CHARS = 80;
export const SURFACE_LAYOUT_LABEL_CHARS = 40;
export const SURFACE_LAYOUT_CAPTION_CHARS = 160;
export const SURFACE_LAYOUT_ID_CHARS = 40;
export const SURFACE_LAYOUT_KEY_CHARS = 64;
export const SURFACE_LAYOUT_BINDING_CHARS = 600;
export const SURFACE_LAYOUT_GLOB_CHARS = 128;
export const SURFACE_LAYOUT_MAX_KEYS = 16;
export const SURFACE_LAYOUT_MAX_GLOBS = 16;
export const SURFACE_GLOB_MAX_PARTS = 16;
export const SURFACE_GLOB_MAX_DEEP_PARTS = 4;
export const SURFACE_GLOB_MAX_STARS_PER_PART = 4;
export const SURFACE_LAYOUT_MAX_COLUMNS = 12;
export const SURFACE_FACTS_MAX = 8;
export const SURFACE_CARDS_MAX = 6;
export const SURFACE_SOURCE_MIN_CHOICES = 2;
export const SURFACE_SOURCE_MAX_CHOICES = 6;
export const SURFACE_FACTS_DEFAULT_TAKE = 4;
export const SURFACE_FACT_FIGURE_CHARS = 18;
export const SURFACE_STAGE_DEFAULT_MODEL = "object.json";
export const SURFACE_MODULE_MIN_HEIGHT = 120;
export const SURFACE_MODULE_MAX_HEIGHT = 1600;
export const SURFACE_ROW_MIN_BLOCKS = 2;
export const SURFACE_ROW_MAX_BLOCKS = 3;
export const SURFACE_BRAND_GROUNDS = ["light", "dark"] as const;
export const SURFACE_PICTURE_EXTENSIONS = [".svg", ".png", ".webp", ".jpg", ".jpeg"] as const;

const SURFACE_LAYOUT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SURFACE_BLOCK_TYPES = [
	"stage_3d",
	"title",
	"swatch_row",
	"palette",
	"brand_mark",
	"type_specimen",
	"facts",
	"spec_list",
	"table",
	"cards",
	"report",
	"files",
	"module",
] as const;
export type SurfaceBlockType = (typeof SURFACE_BLOCK_TYPES)[number];
export type SurfaceLayoutNodeType = SurfaceBlockType | "row";

export type SurfaceSourceChoice = string | { readonly value: unknown };
export type SurfaceSource = SurfaceSourceChoice | readonly SurfaceSourceChoice[];
export type SurfaceBrandGround = (typeof SURFACE_BRAND_GROUNDS)[number];

interface SurfaceBlockBase {
	readonly id?: string;
}

export interface SurfaceStage3dBlock extends SurfaceBlockBase {
	readonly type: "stage_3d";
	readonly model: SurfaceSource;
	readonly tint?: SurfaceSource;
}

export interface SurfaceTitleBlock extends SurfaceBlockBase {
	readonly type: "title";
	readonly name?: SurfaceSource;
	readonly line?: SurfaceSource;
}

export interface SurfaceSwatchRowBlock extends SurfaceBlockBase {
	readonly type: "swatch_row";
	readonly from: SurfaceSource;
	readonly tints?: string;
}

export interface SurfacePaletteBlock extends SurfaceBlockBase {
	readonly type: "palette";
	readonly from: SurfaceSource;
	readonly heading?: string;
}

export interface SurfaceBrandMarkBlock extends SurfaceBlockBase {
	readonly type: "brand_mark";
	readonly from: string;
	readonly grounds: readonly SurfaceBrandGround[];
	readonly heading?: string;
}

export interface SurfaceTypeSpecimenBlock extends SurfaceBlockBase {
	readonly type: "type_specimen";
	readonly from: SurfaceSource;
	readonly heading?: string;
}

export interface SurfaceFactItem {
	readonly label: string;
	readonly from: SurfaceSource;
}

export interface SurfaceFactsItemsBlock extends SurfaceBlockBase {
	readonly type: "facts";
	readonly items: readonly SurfaceFactItem[];
	readonly heading?: string;
}

export interface SurfaceFactsFromBlock extends SurfaceBlockBase {
	readonly type: "facts";
	readonly from: SurfaceSource;
	readonly take: number;
	readonly skip: readonly string[];
	readonly heading?: string;
}

export type SurfaceFactsBlock = SurfaceFactsItemsBlock | SurfaceFactsFromBlock;

export interface SurfaceSpecListBlock extends SurfaceBlockBase {
	readonly type: "spec_list";
	readonly from: SurfaceSource;
	readonly skip?: readonly string[];
	readonly heading?: string;
}

export interface SurfaceTableColumn {
	readonly key: string;
	readonly label: string;
}

export interface SurfaceTableBlock extends SurfaceBlockBase {
	readonly type: "table";
	readonly from: SurfaceSource;
	readonly columns?: readonly SurfaceTableColumn[];
	readonly heading?: string;
	readonly caption?: string;
}

export interface SurfaceCardsFromBlock extends SurfaceBlockBase {
	readonly type: "cards";
	readonly from: SurfaceSource;
	readonly title: string;
	readonly lines: readonly string[];
	readonly badge?: string;
	readonly heading?: string;
}

export interface SurfaceCardItem {
	readonly title: string;
	readonly from: SurfaceSource;
}

export interface SurfaceCardsItemsBlock extends SurfaceBlockBase {
	readonly type: "cards";
	readonly items: readonly SurfaceCardItem[];
	readonly heading?: string;
}

export type SurfaceCardsBlock = SurfaceCardsFromBlock | SurfaceCardsItemsBlock;

export interface SurfaceReportFileBlock extends SurfaceBlockBase {
	readonly type: "report";
	readonly from: string;
	readonly heading?: string;
}

export interface SurfaceReportMatchBlock extends SurfaceBlockBase {
	readonly type: "report";
	readonly match: string;
	readonly heading?: string;
}

export type SurfaceReportBlock = SurfaceReportFileBlock | SurfaceReportMatchBlock;

export interface SurfaceFilesBlock extends SurfaceBlockBase {
	readonly type: "files";
	readonly match?: readonly string[];
	readonly skip?: readonly string[];
	readonly heading?: string;
}

export interface SurfaceModuleBlock extends SurfaceBlockBase {
	readonly type: "module";
	readonly from: string;
	readonly height: "auto" | number;
	readonly heading?: string;
}

export type SurfaceBlock =
	| SurfaceStage3dBlock
	| SurfaceTitleBlock
	| SurfaceSwatchRowBlock
	| SurfacePaletteBlock
	| SurfaceBrandMarkBlock
	| SurfaceTypeSpecimenBlock
	| SurfaceFactsBlock
	| SurfaceSpecListBlock
	| SurfaceTableBlock
	| SurfaceCardsBlock
	| SurfaceReportBlock
	| SurfaceFilesBlock
	| SurfaceModuleBlock;

export interface SurfaceUnknownBlock {
	readonly type: "unknown";
	readonly reason: string;
}

export interface SurfaceRow<B> {
	readonly type: "row";
	readonly blocks: readonly B[];
}

export type SurfaceLayoutNode = SurfaceBlock | SurfaceRow<SurfaceBlock>;
export type SurfaceReadBlock = SurfaceBlock | SurfaceUnknownBlock;
export type SurfaceReadNode = SurfaceReadBlock | SurfaceRow<SurfaceReadBlock>;

export interface SurfaceTab<N> {
	readonly id: string;
	readonly title: string;
	readonly blocks: readonly N[];
}

export interface SurfaceLayout {
	readonly schema: typeof SURFACE_LAYOUT_SCHEMA;
	readonly tabs: readonly SurfaceTab<SurfaceLayoutNode>[];
}

export interface SurfaceLayoutRead {
	readonly schema: typeof SURFACE_LAYOUT_SCHEMA;
	readonly tabs: readonly SurfaceTab<SurfaceReadNode>[];
}

export type SurfaceLayoutReadResult = { readonly layout: SurfaceLayoutRead } | { readonly problem: string };

export type SurfaceBlockFieldKind =
	| "source"
	| "file"
	| "stage"
	| "key"
	| "keys"
	| "heading"
	| "caption"
	| "glob"
	| "globs"
	| "folder"
	| "grounds"
	| "take"
	| "height"
	| "items"
	| "cards"
	| "columns"
	| "blocks";

export interface SurfaceBlockField {
	readonly name: string;
	readonly kind: SurfaceBlockFieldKind;
	readonly required: boolean;
	readonly note: string;
	readonly accepts?: readonly string[];
}

export interface SurfaceBlockDefinition {
	readonly type: SurfaceLayoutNodeType;
	readonly family: string;
	readonly summary: string;
	readonly fields: readonly SurfaceBlockField[];
}

const HEADING_FIELD: SurfaceBlockField = {
	name: "heading",
	kind: "heading",
	required: false,
	note: "a heading above it",
};

export const SURFACE_BLOCKS: readonly SurfaceBlockDefinition[] = [
	{
		type: "stage_3d",
		family: "stage_3d",
		summary: "a 3D model to turn, take apart and tint",
		fields: [
			{ name: "model", kind: "source", required: false, note: "the object file, default object.json" },
			{ name: "tint", kind: "source", required: false, note: "a colour to tint it" },
		],
	},
	{
		type: "title",
		family: "title",
		summary: "a name and one line about it",
		fields: [
			{ name: "name", kind: "source", required: false, note: "default the interface's own title" },
			{ name: "line", kind: "source", required: false, note: "one line about what it is" },
		],
	},
	{
		type: "swatch_row",
		family: "colours",
		summary: "a row of colour dots",
		fields: [
			{ name: "from", kind: "source", required: true, note: "[{name, hex}] or {name: colour}" },
			{ name: "tints", kind: "stage", required: false, note: "a stage_3d on this tab" },
		],
	},
	{
		type: "palette",
		family: "colours",
		summary: "a palette of named colours",
		fields: [{ name: "from", kind: "source", required: true, note: "{name: colour} or a list" }, HEADING_FIELD],
	},
	{
		type: "brand_mark",
		family: "brand_mark",
		summary: "a logo or wordmark on light and dark ground",
		fields: [
			{
				name: "from",
				kind: "file",
				required: true,
				note: "a picture file",
				accepts: SURFACE_PICTURE_EXTENSIONS,
			},
			{ name: "grounds", kind: "grounds", required: false, note: "default both" },
			HEADING_FIELD,
		],
	},
	{
		type: "type_specimen",
		family: "type_specimen",
		summary: "the typefaces at work",
		fields: [{ name: "from", kind: "source", required: true, note: "an object of role to typeface" }, HEADING_FIELD],
	},
	{
		type: "facts",
		family: "facts",
		summary: `short key figures (with from, only values of <=${SURFACE_FACT_FIGURE_CHARS} chars); ? where missing`,
		fields: [
			{ name: "items", kind: "items", required: false, note: "each figure named" },
			{ name: "from", kind: "source", required: false, note: "an object, or a list of {label, value}" },
			{ name: "take", kind: "take", required: false, note: "default 4" },
			{ name: "skip", kind: "keys", required: false, note: "keys to leave out" },
			HEADING_FIELD,
		],
	},
	{
		type: "spec_list",
		family: "specs",
		summary:
			"labelled values, objects as groups, lists of objects as tables; nothing if found empty or skip leaves nothing",
		fields: [
			{ name: "from", kind: "source", required: true, note: "an object" },
			{ name: "skip", kind: "keys", required: false, note: "keys to leave out" },
			HEADING_FIELD,
		],
	},
	{
		type: "table",
		family: "specs",
		summary: "rows and columns",
		fields: [
			{ name: "from", kind: "source", required: true, note: "a list of objects" },
			{ name: "columns", kind: "columns", required: false, note: "default every key" },
			HEADING_FIELD,
			{ name: "caption", kind: "caption", required: false, note: "a line under it" },
		],
	},
	{
		type: "cards",
		family: "cards",
		summary: "one card per item, or named cards",
		fields: [
			{ name: "items", kind: "cards", required: false, note: "each card named" },
			{ name: "from", kind: "source", required: false, note: "a list of objects" },
			{ name: "title", kind: "key", required: false, note: "the key cards are titled by" },
			{ name: "lines", kind: "keys", required: false, note: "keys shown as lines" },
			{ name: "badge", kind: "key", required: false, note: "a key shown as a badge" },
			HEADING_FIELD,
		],
	},
	{
		type: "report",
		family: "report",
		summary: "essays and charts from report files",
		fields: [
			{
				name: "from",
				kind: "file",
				required: false,
				note: "one report file; or use match",
				accepts: [".json"],
			},
			{ name: "match", kind: "glob", required: false, note: "every matching file" },
			HEADING_FIELD,
		],
	},
	{
		type: "files",
		family: "files",
		summary: "working files no other block shows, .json too; its empty line only alone on a tab or with a heading",
		fields: [
			{ name: "match", kind: "globs", required: false, note: "default every file" },
			{ name: "skip", kind: "globs", required: false, note: "files to leave out" },
			HEADING_FIELD,
		],
	},
	{
		type: "module",
		family: "module",
		summary: "a small app built for this page",
		fields: [
			{ name: "from", kind: "folder", required: true, note: "its folder" },
			{ name: "height", kind: "height", required: false, note: "default auto" },
			HEADING_FIELD,
		],
	},
	{
		type: "row",
		family: "row",
		summary: "blocks side by side; one column on a phone",
		fields: [{ name: "blocks", kind: "blocks", required: true, note: "no row inside a row" }],
	},
];

const FIELD_KIND_WORDS: Readonly<Record<SurfaceBlockFieldKind, string>> = {
	source: "source",
	file: "file",
	stage: "id",
	key: "key",
	keys: "[key]",
	heading: `text<=${SURFACE_LAYOUT_HEADING_CHARS}`,
	caption: `text<=${SURFACE_LAYOUT_CAPTION_CHARS}`,
	glob: "glob",
	globs: "[glob]",
	folder: "folder",
	grounds: '["light","dark"]',
	take: `1-${SURFACE_FACTS_MAX}`,
	height: `"auto"|${SURFACE_MODULE_MIN_HEIGHT}-${SURFACE_MODULE_MAX_HEIGHT}`,
	items: `[{label, from}] 1-${SURFACE_FACTS_MAX}`,
	cards: `[{title, from}] 1-${SURFACE_CARDS_MAX}`,
	columns: "[{key, label}]",
	blocks: `${SURFACE_ROW_MIN_BLOCKS}-${SURFACE_ROW_MAX_BLOCKS} blocks`,
};

export function describeSurfaceBlocks(): string {
	const lines = [
		`${SURFACE_LAYOUT_PATH} at the interface folder's root sets the page: {"schema":"${SURFACE_LAYOUT_SCHEMA}","tabs":[{"id","title","blocks":[...]}]}.`,
		`1-${SURFACE_LAYOUT_MAX_TABS} tabs; at most ${SURFACE_LAYOUT_MAX_TAB_NODES} blocks a tab (a row and its blocks each count) and ${SURFACE_LAYOUT_MAX_BLOCKS} in all. Tab title <=${SURFACE_LAYOUT_TAB_TITLE_CHARS} chars, label <=${SURFACE_LAYOUT_LABEL_CHARS}.`,
		'A source is "file.json#/pointer", "file" for a whole file, or {"value": ...} held in the layout; a string always names a file, never a literal. Paths are relative to the interface folder; a leading / names a company file, e.g. /identity/tokens.json.',
		`A source may be a list of ${SURFACE_SOURCE_MIN_CHOICES}-${SURFACE_SOURCE_MAX_CHOICES} sources tried in order; the first found wins.`,
		"Ids are lower-case slugs, unique in the layout; a row has none. Labels, headings, titles and keys are plain text, never sources. Every block draws its own empty home, so name homes before their files exist.",
		"Blocks (field?: optional):",
	];
	for (const block of SURFACE_BLOCKS) {
		const fields = block.fields.map((field) => {
			const name = `${field.name}${field.required ? "" : "?"}`;
			const kind = field.kind === "heading" ? "" : ` ${FIELD_KIND_WORDS[field.kind]}`;
			const note = field.kind === "heading" ? "" : ` (${field.note})`;
			return `${name}${kind}${note}`;
		});
		lines.push(`- ${block.type}: ${block.summary}. ${fields.join("; ")}`);
	}
	lines.push(
		"facts and cards take items or from, not both; cards with from needs title; report from or match. Globs: * and ? in a name, ** for any folders; a leading / as in sources.",
	);
	return lines.join("\n");
}

export interface SurfaceBinding {
	readonly path: string;
	readonly pointer: string;
}

function fail(label: string, problem: string): never {
	throw new WireValueError(label, problem);
}

function checkRelativeSegments(body: string, label: string, what: string): void {
	if (!body) fail(label, `names no ${what}`);
	if (body.includes("\\") || body.includes("\0")) fail(label, `has a backslash or NUL in its ${what}`);
	for (const segment of body.split("/")) {
		if (segment === "") fail(label, `has an empty part in its ${what}; write a/b, never a//b or a trailing /`);
		if (segment === "." || segment === "..") fail(label, `may not use . or .. in its ${what}`);
	}
}

export function parseSurfaceBinding(text: unknown, label = "binding"): SurfaceBinding {
	if (typeof text !== "string") fail(label, 'must be a binding "file.json#/pointer" or {"value": ...}');
	if (text.length > SURFACE_LAYOUT_BINDING_CHARS) fail(label, `is longer than ${SURFACE_LAYOUT_BINDING_CHARS} chars`);
	if (text.trim() !== text) fail(label, "has white space at its start or end");
	const hash = text.indexOf("#");
	const path = hash < 0 ? text : text.slice(0, hash);
	const pointer = hash < 0 ? "" : text.slice(hash + 1);
	checkRelativeSegments(path.startsWith("/") ? path.slice(1) : path, label, "file path");
	if (pointer !== "" && !pointer.startsWith("/")) fail(label, "has a pointer after # that does not start with /");
	if (/~(?![01])/.test(pointer))
		fail(label, "has a ~ in its pointer not followed by 0 or 1 (write ~0 for ~, ~1 for /)");
	return { path, pointer };
}

export type SurfaceJsonReader = (path: string) => unknown;

export interface SurfaceSourceValue {
	readonly found: boolean;
	readonly value: unknown;
}

const NOT_FOUND: SurfaceSourceValue = { found: false, value: undefined };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walkPointer(document: unknown, pointer: string): SurfaceSourceValue {
	let current = document;
	if (pointer !== "") {
		for (const raw of pointer.slice(1).split("/")) {
			const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
			if (Array.isArray(current)) {
				if (!/^(?:0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length) return NOT_FOUND;
				current = current[Number(token)];
			} else if (isPlainObject(current) && Object.hasOwn(current, token)) {
				current = current[token];
			} else {
				return NOT_FOUND;
			}
		}
	}
	return current === undefined ? NOT_FOUND : { found: true, value: current };
}

function resolveSourceChoice(source: unknown, readJson: SurfaceJsonReader): SurfaceSourceValue {
	if (isPlainObject(source)) {
		return Object.hasOwn(source, "value") && source.value !== undefined
			? { found: true, value: source.value }
			: NOT_FOUND;
	}
	try {
		const binding = parseSurfaceBinding(source);
		return walkPointer(readJson(binding.path), binding.pointer);
	} catch {
		return NOT_FOUND;
	}
}

export function resolveSurfaceSource(source: unknown, readJson: SurfaceJsonReader): SurfaceSourceValue {
	if (!Array.isArray(source)) return resolveSourceChoice(source, readJson);
	for (const choice of source) {
		if (Array.isArray(choice)) continue;
		const resolved = resolveSourceChoice(choice, readJson);
		if (resolved.found) return resolved;
	}
	return NOT_FOUND;
}

function parseGlob(value: unknown, label: string): string {
	if (typeof value !== "string") fail(label, 'must be a glob such as "*.report.json"');
	if (value.length > SURFACE_LAYOUT_GLOB_CHARS) fail(label, `is longer than ${SURFACE_LAYOUT_GLOB_CHARS} chars`);
	const body = value.startsWith("/") ? value.slice(1) : value;
	checkRelativeSegments(body, label, "glob");
	const parts = body.split("/");
	if (parts.length > SURFACE_GLOB_MAX_PARTS) fail(label, `has more than ${SURFACE_GLOB_MAX_PARTS} folder levels`);
	let deep = 0;
	for (const part of parts) {
		if (part === "**") {
			deep += 1;
			continue;
		}
		if (part.includes("**")) fail(label, "has ** inside a name; ** stands alone between slashes, as in **/*.md");
		if (part.split("*").length - 1 > SURFACE_GLOB_MAX_STARS_PER_PART) {
			fail(label, `has more than ${SURFACE_GLOB_MAX_STARS_PER_PART} * in one name`);
		}
	}
	if (deep > SURFACE_GLOB_MAX_DEEP_PARTS) fail(label, `has more than ${SURFACE_GLOB_MAX_DEEP_PARTS} **`);
	return value;
}

function namePartMatches(pattern: readonly string[], name: readonly string[]): boolean {
	let at = 0;
	let from = 0;
	let star = -1;
	let resume = 0;
	while (from < name.length) {
		const want = pattern[at];
		if (want !== undefined && want !== "*" && (want === "?" || want === name[from])) {
			at += 1;
			from += 1;
		} else if (want === "*") {
			star = at;
			at += 1;
			resume = from;
		} else if (star >= 0) {
			at = star + 1;
			resume += 1;
			from = resume;
		} else {
			return false;
		}
	}
	while (pattern[at] === "*") at += 1;
	return at === pattern.length;
}

export function surfaceGlobMatches(glob: string, path: string): boolean {
	if (glob.startsWith("/") !== path.startsWith("/")) return false;
	const globParts = glob.split("/").map((part) => (part === "**" ? null : Array.from(part)));
	const pathParts = path.split("/").map((part) => Array.from(part));
	let next: boolean[] = pathParts.map(() => false);
	next.push(true);
	for (let index = globParts.length - 1; index >= 0; index -= 1) {
		const part = globParts[index];
		const here: boolean[] = new Array(pathParts.length + 1).fill(false);
		for (let from = pathParts.length; from >= 0; from -= 1) {
			const name = pathParts[from];
			here[from] =
				part === null || part === undefined
					? Boolean(next[from]) || (name !== undefined && Boolean(here[from + 1]))
					: name !== undefined && Boolean(next[from + 1]) && namePartMatches(part, name);
		}
		next = here;
	}
	return Boolean(next[0]);
}

function parseText(value: unknown, label: string, max: number, what: string): string {
	if (typeof value !== "string") fail(label, `must be ${what} (text)`);
	if (value.trim() === "") fail(label, "is empty");
	if (value.length > max) fail(label, `is longer than ${max} chars`);
	if (value.includes("\0")) fail(label, "has a NUL");
	return value;
}

function parseId(value: unknown, label: string): string {
	if (typeof value !== "string" || !SURFACE_LAYOUT_ID_PATTERN.test(value) || value.length > SURFACE_LAYOUT_ID_CHARS) {
		fail(
			label,
			`must be a lower-case slug such as "overview" (a-z, 0-9, single dashes; <=${SURFACE_LAYOUT_ID_CHARS})`,
		);
	}
	return value;
}

function parseSource(value: unknown, label: string): SurfaceSource {
	if (!Array.isArray(value)) return parseSourceChoice(value, label);
	return parseList(value, label, SURFACE_SOURCE_MIN_CHOICES, SURFACE_SOURCE_MAX_CHOICES, (item, at) => {
		if (Array.isArray(item)) fail(at, "is a list inside a list; a list of sources holds sources only");
		return parseSourceChoice(item, at);
	});
}

function parseSourceChoice(value: unknown, label: string): SurfaceSourceChoice {
	if (isPlainObject(value)) {
		const keys = Object.keys(value);
		if (keys.length !== 1 || keys[0] !== "value" || value.value === undefined) {
			fail(label, 'as an object must be exactly {"value": ...}');
		}
		return { value: value.value };
	}
	parseSurfaceBinding(value, label);
	return value as string;
}

function parseFile(value: unknown, label: string, accepts: readonly string[] | undefined): string {
	const binding = parseSurfaceBinding(value, label);
	if (binding.pointer !== "") fail(label, "must name a whole file, without #");
	if (accepts && !accepts.some((extension) => binding.path.toLowerCase().endsWith(extension))) {
		fail(label, `must name a ${accepts.join(", ")} file`);
	}
	return binding.path;
}

function parseList<T>(
	value: unknown,
	label: string,
	min: number,
	max: number,
	parseItem: (item: unknown, at: string) => T,
): T[] {
	if (!Array.isArray(value)) fail(label, "must be a list");
	if (value.length < min || value.length > max) fail(label, `must hold ${min} to ${max} entries, not ${value.length}`);
	return value.map((item, index) => parseItem(item, `${label}[${index}]`));
}

function parseClosed(
	value: unknown,
	label: string,
	what: string,
	fields: readonly string[],
	required: readonly string[],
): Record<string, unknown> {
	if (!isPlainObject(value)) fail(label, `must be an object (${what})`);
	if (Object.keys(value).some((key) => !fields.includes(key))) {
		fail(label, `has a field that ${what} does not take; its fields are ${fields.join(", ")}`);
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) fail(`${label}.${key}`, `is missing; ${what} needs it`);
	}
	return value;
}

function parseFieldValue(field: SurfaceBlockField, value: unknown, label: string): unknown {
	switch (field.kind) {
		case "source":
			return parseSource(value, label);
		case "file":
			return parseFile(value, label, field.accepts);
		case "stage":
			return parseId(value, label);
		case "key":
			return parseText(value, label, SURFACE_LAYOUT_KEY_CHARS, "a key");
		case "keys":
			return parseList(value, label, 0, SURFACE_LAYOUT_MAX_KEYS, (item, at) =>
				parseText(item, at, SURFACE_LAYOUT_KEY_CHARS, "a key"),
			);
		case "heading":
			return parseText(value, label, SURFACE_LAYOUT_HEADING_CHARS, "a heading");
		case "caption":
			return parseText(value, label, SURFACE_LAYOUT_CAPTION_CHARS, "a caption");
		case "glob":
			return parseGlob(value, label);
		case "globs":
			return parseList(value, label, 1, SURFACE_LAYOUT_MAX_GLOBS, parseGlob);
		case "folder": {
			if (typeof value !== "string") fail(label, 'must be a folder such as "modules/price-calc"');
			if (value.length > SURFACE_LAYOUT_BINDING_CHARS)
				fail(label, `is longer than ${SURFACE_LAYOUT_BINDING_CHARS} chars`);
			if (value.startsWith("/")) fail(label, "must be a folder in the interface folder, without a leading /");
			if (value.includes("#")) fail(label, "must name a folder, without #");
			checkRelativeSegments(value, label, "folder path");
			return value;
		}
		case "grounds": {
			const grounds = parseList(value, label, 1, SURFACE_BRAND_GROUNDS.length, (item, at) => {
				if (item !== "light" && item !== "dark") fail(at, 'must be "light" or "dark"');
				return item;
			});
			if (new Set(grounds).size !== grounds.length) fail(label, "names a ground twice");
			return grounds;
		}
		case "take":
			if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > SURFACE_FACTS_MAX) {
				fail(label, `must be a whole number from 1 to ${SURFACE_FACTS_MAX}`);
			}
			return value;
		case "height":
			if (value === "auto") return value;
			if (
				!Number.isSafeInteger(value) ||
				(value as number) < SURFACE_MODULE_MIN_HEIGHT ||
				(value as number) > SURFACE_MODULE_MAX_HEIGHT
			) {
				fail(
					label,
					`must be "auto" or a whole number of pixels from ${SURFACE_MODULE_MIN_HEIGHT} to ${SURFACE_MODULE_MAX_HEIGHT}`,
				);
			}
			return value;
		case "items":
			return parseList(value, label, 1, SURFACE_FACTS_MAX, (item, at) => {
				const raw = parseClosed(item, at, "a fact", ["label", "from"], ["label", "from"]);
				return {
					label: parseText(raw.label, `${at}.label`, SURFACE_LAYOUT_LABEL_CHARS, "a label"),
					from: parseSource(raw.from, `${at}.from`),
				};
			});
		case "cards":
			return parseList(value, label, 1, SURFACE_CARDS_MAX, (item, at) => {
				const raw = parseClosed(item, at, "a card", ["title", "from"], ["title", "from"]);
				return {
					title: parseText(raw.title, `${at}.title`, SURFACE_LAYOUT_LABEL_CHARS, "a title"),
					from: parseSource(raw.from, `${at}.from`),
				};
			});
		case "columns":
			return parseList(value, label, 1, SURFACE_LAYOUT_MAX_COLUMNS, (item, at) => {
				const raw = parseClosed(item, at, "a column", ["key", "label"], ["key", "label"]);
				return {
					key: parseText(raw.key, `${at}.key`, SURFACE_LAYOUT_KEY_CHARS, "a key"),
					label: parseText(raw.label, `${at}.label`, SURFACE_LAYOUT_LABEL_CHARS, "a label"),
				};
			});
		case "blocks":
			return fail(label, "belongs to a row only");
	}
}

function definitionOf(type: SurfaceLayoutNodeType): SurfaceBlockDefinition {
	const definition = SURFACE_BLOCKS.find((block) => block.type === type);
	if (!definition) throw new Error(`No surface block definition for ${type}`);
	return definition;
}

function finishCards(block: Record<string, unknown>, label: string): void {
	if ((block.items !== undefined) === (block.from !== undefined))
		fail(label, "cards needs items or from, exactly one of them");
	if (block.items !== undefined) {
		if (block.title !== undefined || block.lines !== undefined || block.badge !== undefined) {
			fail(label, "cards takes title, lines and badge only with from, not with items");
		}
		return;
	}
	if (block.title === undefined) fail(`${label}.title`, "is missing; cards with from needs it");
	block.lines ??= [];
}

function finishBlock(type: SurfaceBlockType, block: Record<string, unknown>, label: string): void {
	if (type === "stage_3d" && block.model === undefined) block.model = SURFACE_STAGE_DEFAULT_MODEL;
	if (type === "brand_mark" && block.grounds === undefined) block.grounds = [...SURFACE_BRAND_GROUNDS];
	if (type === "cards") finishCards(block, label);
	if (type === "module" && block.height === undefined) block.height = "auto";
	if (type === "facts") {
		const hasItems = block.items !== undefined;
		if (hasItems === (block.from !== undefined)) fail(label, "facts needs items or from, exactly one of them");
		if (hasItems && (block.take !== undefined || block.skip !== undefined)) {
			fail(label, "facts takes take and skip only with from, not with items");
		}
		if (!hasItems) {
			block.take ??= SURFACE_FACTS_DEFAULT_TAKE;
			block.skip ??= [];
		}
	}
	if (type === "report" && (block.from !== undefined) === (block.match !== undefined)) {
		fail(label, "report needs from or match, exactly one of them");
	}
}

function parseBlock(value: unknown, label: string): SurfaceBlock {
	if (!isPlainObject(value)) fail(label, "must be an object with a type");
	const type = value.type;
	if (type === "row") fail(`${label}.type`, "is row, and a row cannot hold a row");
	if (typeof type !== "string" || !(SURFACE_BLOCK_TYPES as readonly string[]).includes(type)) {
		fail(`${label}.type`, `must be one of ${SURFACE_BLOCK_TYPES.join(", ")} or row`);
	}
	const blockType = type as SurfaceBlockType;
	const definition = definitionOf(blockType);
	const names = ["type", "id", ...definition.fields.map((field) => field.name)];
	const raw = parseClosed(
		value,
		label,
		blockType,
		names,
		definition.fields.filter((field) => field.required).map((field) => field.name),
	);
	const block: Record<string, unknown> = { type: blockType };
	if (raw.id !== undefined) block.id = parseId(raw.id, `${label}.id`);
	for (const field of definition.fields) {
		if (raw[field.name] !== undefined)
			block[field.name] = parseFieldValue(field, raw[field.name], `${label}.${field.name}`);
	}
	finishBlock(blockType, block, label);
	return block as unknown as SurfaceBlock;
}

function parseRowShell(value: Record<string, unknown>, label: string): unknown[] {
	parseClosed(value, label, "row", ["type", "blocks"], ["blocks"]);
	if (!Array.isArray(value.blocks)) fail(`${label}.blocks`, "must be a list of blocks");
	const count = value.blocks.length;
	if (count < SURFACE_ROW_MIN_BLOCKS || count > SURFACE_ROW_MAX_BLOCKS) {
		fail(`${label}.blocks`, `must hold ${SURFACE_ROW_MIN_BLOCKS} or ${SURFACE_ROW_MAX_BLOCKS} blocks, not ${count}`);
	}
	return value.blocks;
}

function parseNode(value: unknown, label: string): SurfaceLayoutNode {
	if (isPlainObject(value) && value.type === "row") {
		const blocks = parseRowShell(value, label).map((item, index) => parseBlock(item, `${label}.blocks[${index}]`));
		return { type: "row", blocks };
	}
	return parseBlock(value, label);
}

function unknownBlock(error: unknown): SurfaceUnknownBlock {
	return { type: "unknown", reason: error instanceof Error ? error.message : "it does not parse" };
}

function readBlock(value: unknown, label: string): SurfaceReadBlock {
	try {
		return parseBlock(value, label);
	} catch (error) {
		return unknownBlock(error);
	}
}

function readNode(value: unknown, label: string): SurfaceReadNode {
	if (!isPlainObject(value) || value.type !== "row") return readBlock(value, label);
	try {
		const blocks = parseRowShell(value, label).map((item, index) => readBlock(item, `${label}.blocks[${index}]`));
		return { type: "row", blocks };
	} catch (error) {
		return unknownBlock(error);
	}
}

function nodeCount(nodes: readonly SurfaceReadNode[]): number {
	return nodes.reduce((sum, node) => sum + (node.type === "row" ? 1 + node.blocks.length : 1), 0);
}

function leafCount(nodes: readonly SurfaceReadNode[]): number {
	return nodes.reduce((sum, node) => sum + (node.type === "row" ? node.blocks.length : 1), 0);
}

interface PlacedBlock {
	readonly label: string;
	readonly block: SurfaceReadBlock;
	readonly replace: (next: SurfaceReadBlock) => void;
}

function placedBlocks(tab: { blocks: SurfaceReadNode[] }, tabLabel: string): PlacedBlock[] {
	const placed: PlacedBlock[] = [];
	tab.blocks.forEach((node, index) => {
		const label = `${tabLabel}.blocks[${index}]`;
		if (node.type === "row") {
			const children = [...node.blocks];
			children.forEach((child, slot) => {
				placed.push({
					label: `${label}.blocks[${slot}]`,
					block: child,
					replace: (next) => {
						children[slot] = next;
						tab.blocks[index] = { type: "row", blocks: [...children] };
					},
				});
			});
		} else {
			placed.push({
				label,
				block: node,
				replace: (next) => {
					tab.blocks[index] = next;
				},
			});
		}
	});
	return placed;
}

function checkAcrossBlocks(
	tabs: readonly { blocks: SurfaceReadNode[] }[],
	onProblem: (place: PlacedBlock, label: string, problem: string) => void,
): void {
	const seen = new Map<string, string>();
	tabs.forEach((tab, tabIndex) => {
		const placed = placedBlocks(tab, `layout.tabs[${tabIndex}]`);
		const stages = new Set(
			placed.flatMap((place) => (place.block.type === "stage_3d" && place.block.id ? [place.block.id] : [])),
		);
		for (const place of placed) {
			const block = place.block;
			if (block.type === "unknown") continue;
			if (block.id !== undefined) {
				const first = seen.get(block.id);
				if (first !== undefined) {
					onProblem(place, `${place.label}.id`, `repeats the id of ${first}; ids must be unique in the layout`);
					continue;
				}
				seen.set(block.id, place.label);
			}
			if (block.type === "swatch_row" && block.tints !== undefined && !stages.has(block.tints)) {
				onProblem(place, `${place.label}.tints`, "names no stage_3d block on this tab");
			}
		}
	});
}

function parseTabShell(value: unknown, label: string): { id: string; title: string; blocks: unknown[] } {
	const raw = parseClosed(value, label, "a tab", ["id", "title", "blocks"], ["id", "title", "blocks"]);
	const id = parseId(raw.id, `${label}.id`);
	const title = parseText(raw.title, `${label}.title`, SURFACE_LAYOUT_TAB_TITLE_CHARS, "a tab title");
	if (!Array.isArray(raw.blocks)) fail(`${label}.blocks`, "must be a list of blocks");
	return { id, title, blocks: raw.blocks };
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function parseSurfaceLayout(value: unknown): SurfaceLayout {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		encoded = undefined;
	}
	if (encoded === undefined) fail("layout", "is not JSON");
	if (utf8Bytes(encoded) > SURFACE_LAYOUT_MAX_BYTES) {
		fail("layout", `is larger than ${SURFACE_LAYOUT_MAX_BYTES} bytes; split long values into their own files`);
	}
	const raw = parseClosed(value, "layout", "the layout", ["schema", "tabs"], ["schema", "tabs"]);
	if (raw.schema !== SURFACE_LAYOUT_SCHEMA) fail("layout.schema", `must be "${SURFACE_LAYOUT_SCHEMA}"`);
	const tabs = parseList(raw.tabs, "layout.tabs", 1, SURFACE_LAYOUT_MAX_TABS, (item, at) => {
		const shell = parseTabShell(item, at);
		if (shell.blocks.length < 1) fail(`${at}.blocks`, "is empty; a tab holds at least one block");
		const blocks = shell.blocks.map((node, index) => parseNode(node, `${at}.blocks[${index}]`));
		const count = nodeCount(blocks);
		if (count > SURFACE_LAYOUT_MAX_TAB_NODES) {
			fail(
				`${at}.blocks`,
				`holds ${count} blocks; a tab holds at most ${SURFACE_LAYOUT_MAX_TAB_NODES}, a row and the blocks in it each counted`,
			);
		}
		return { id: shell.id, title: shell.title, blocks };
	});
	const tabIds = new Map<string, number>();
	tabs.forEach((tab, index) => {
		const first = tabIds.get(tab.id);
		if (first !== undefined)
			fail(`layout.tabs[${index}].id`, `repeats the id of layout.tabs[${first}]; tab ids must be unique`);
		tabIds.set(tab.id, index);
	});
	const total = tabs.reduce((sum, tab) => sum + leafCount(tab.blocks), 0);
	if (total > SURFACE_LAYOUT_MAX_BLOCKS) {
		fail(
			"layout.tabs",
			`hold ${total} blocks; a layout holds at most ${SURFACE_LAYOUT_MAX_BLOCKS}, rows not counted`,
		);
	}
	checkAcrossBlocks(tabs, (_place, label, problem) => fail(label, problem));
	return { schema: SURFACE_LAYOUT_SCHEMA, tabs };
}

export function parseSurfaceLayoutText(text: string): SurfaceLayout {
	if (utf8Bytes(text) > SURFACE_LAYOUT_MAX_BYTES) {
		fail("layout", `is larger than ${SURFACE_LAYOUT_MAX_BYTES} bytes; split long values into their own files`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		fail("layout", "is not valid JSON");
	}
	return parseSurfaceLayout(value);
}

export function readSurfaceLayout(text: string): SurfaceLayoutReadResult {
	if (utf8Bytes(text) > SURFACE_LAYOUT_MAX_BYTES) return { problem: `larger than ${SURFACE_LAYOUT_MAX_BYTES} bytes` };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { problem: "not valid JSON" };
	}
	if (!isPlainObject(value)) return { problem: "not a JSON object" };
	if (value.schema !== SURFACE_LAYOUT_SCHEMA) return { problem: `schema is not ${SURFACE_LAYOUT_SCHEMA}` };
	if (!Array.isArray(value.tabs)) return { problem: "no tabs list" };
	const tabs: { id: string; title: string; blocks: SurfaceReadNode[] }[] = [];
	const tabIds = new Set<string>();
	let budget = SURFACE_LAYOUT_MAX_BLOCKS;
	value.tabs.forEach((item, index) => {
		if (tabs.length >= SURFACE_LAYOUT_MAX_TABS) return;
		let shell: { id: string; title: string; blocks: unknown[] };
		try {
			shell = parseTabShell(item, `layout.tabs[${index}]`);
		} catch {
			return;
		}
		if (tabIds.has(shell.id)) return;
		tabIds.add(shell.id);
		const blocks: SurfaceReadNode[] = [];
		let nodes = 0;
		for (const [slot, raw] of shell.blocks.entries()) {
			const node = readNode(raw, `layout.tabs[${index}].blocks[${slot}]`);
			const size = node.type === "row" ? 1 + node.blocks.length : 1;
			const leaves = node.type === "row" ? node.blocks.length : 1;
			if (nodes + size > SURFACE_LAYOUT_MAX_TAB_NODES || leaves > budget) break;
			nodes += size;
			budget -= leaves;
			blocks.push(node);
		}
		tabs.push({ id: shell.id, title: shell.title, blocks });
	});
	if (tabs.length === 0) return { problem: "no usable tab" };
	checkAcrossBlocks(tabs, (place, label, problem) => {
		const block = place.block;
		if (block.type === "swatch_row" && label.endsWith(".tints")) {
			const { tints: _dropped, ...rest } = block;
			place.replace(rest);
		} else {
			place.replace({ type: "unknown", reason: `${label} ${problem}` });
		}
	});
	return { layout: { schema: SURFACE_LAYOUT_SCHEMA, tabs } };
}

export const SURFACE_STARTER_KINDS = ["product", "identity", "custom"] as const;
export type SurfaceStarterKind = (typeof SURFACE_STARTER_KINDS)[number];

const PRODUCT_STARTER_LAYOUT: SurfaceLayout = {
	schema: SURFACE_LAYOUT_SCHEMA,
	tabs: [
		{
			id: "overview",
			title: "Overview",
			blocks: [
				{ type: "stage_3d", id: "stage", model: "object.json" },
				{
					type: "title",
					line: [
						"specs.json#/overview/tagline",
						"specs.json#/tagline",
						"specs.json#/overview/summary",
						"specs.json#/summary",
						"specs.json#/overview/description",
						"specs.json#/description",
					],
				},
				{
					type: "swatch_row",
					from: ["specs.json#/colorways", "specs.json#/colors", "specs.json#/palette", "specs.json#/swatches"],
					tints: "stage",
				},
				{
					type: "facts",
					from: "specs.json#/overview",
					take: 4,
					skip: ["tagline", "summary", "description"],
				},
			],
		},
		{
			id: "specs",
			title: "Specs",
			blocks: [
				{ type: "spec_list", from: "specs.json#/overview" },
				{ type: "table", from: "specs.json#/bom", heading: "Parts" },
				{
					type: "spec_list",
					from: "specs.json",
					skip: [
						"overview",
						"bom",
						"tagline",
						"summary",
						"description",
						"model",
						"geometry",
						"colorways",
						"colors",
						"color",
						"palette",
						"swatches",
						"typography",
						"type",
						"fonts",
						"font",
					],
					heading: "Other details",
				},
				{ type: "files", match: ["**/*.json"] },
			],
		},
		{
			id: "vendors",
			title: "Vendors",
			blocks: [
				{ type: "spec_list", from: "vendors.json#/production", heading: "Production plan" },
				{
					type: "cards",
					from: ["vendors.json#/vendors", "vendors.json#/suppliers"],
					title: "vendor",
					lines: ["component", "unitPrice", "moq", "leadTime", "region", "certifications"],
					badge: "status",
				},
			],
		},
		{
			id: "reports",
			title: "Reports",
			blocks: [{ type: "report", match: "**/*.report.json" }],
		},
		{
			id: "files",
			title: "Files",
			blocks: [
				{
					type: "files",
					match: ["**/*.md", "**/*.markdown", "**/*.txt", "**/*.svg", "**/*.html", "**/*.htm"],
				},
			],
		},
	],
};

const IDENTITY_STARTER_LAYOUT: SurfaceLayout = {
	schema: SURFACE_LAYOUT_SCHEMA,
	tabs: [
		{
			id: "overview",
			title: "Overview",
			blocks: [
				{
					type: "row",
					blocks: [
						{
							type: "brand_mark",
							id: "logo",
							from: "/identity/logo.svg",
							grounds: ["light", "dark"],
							heading: "Logo",
						},
						{
							type: "brand_mark",
							id: "wordmark",
							from: "/identity/wordmark.svg",
							grounds: ["light", "dark"],
							heading: "Wordmark",
						},
					],
				},
				{
					type: "title",
					id: "name",
					name: ["/identity/company.json#/name", "/identity/tokens.json#/brand"],
					line: "/identity/tokens.json#/voice/summary",
				},
				{
					type: "cards",
					id: "mission",
					items: [
						{ title: "Mission", from: "/identity/company.json#/mission" },
						{ title: "Ambition", from: "/identity/company.json#/ambition" },
					],
					heading: "Mission & Ambition",
				},
				{
					type: "palette",
					id: "palette",
					from: [
						"/identity/tokens.json#/colors",
						"/identity/tokens.json#/palette",
						"/identity/tokens.json#/color",
					],
					heading: "Palette",
				},
				{
					type: "type_specimen",
					id: "type",
					from: ["/identity/tokens.json#/typography", "/identity/tokens.json#/fonts"],
					heading: "Type",
				},
			],
		},
		{
			id: "strategy",
			title: "Strategy",
			blocks: [
				{
					type: "cards",
					id: "strategy",
					from: "/identity/company.json#/strategy",
					title: "title",
					lines: ["detail"],
					heading: "Strategy",
				},
			],
		},
		{
			id: "philosophy",
			title: "Philosophy",
			blocks: [{ type: "report", id: "philosophy", match: "/identity/**/*.report.json" }],
		},
		{
			id: "voice",
			title: "Voice",
			blocks: [
				{ type: "files", id: "voice", match: ["/identity/voice.md", "/identity/brief.md"], heading: "Voice" },
			],
		},
		{
			id: "system",
			title: "Design system",
			blocks: [
				{
					type: "spec_list",
					id: "tokens",
					from: "/identity/tokens.json",
					skip: [
						"colors",
						"color",
						"palette",
						"swatches",
						"typography",
						"type",
						"fonts",
						"font",
						"brand",
						"voice",
					],
					heading: "Tokens",
				},
				{
					type: "spec_list",
					id: "design-system",
					from: "/identity/design-system.json",
					heading: "Design system",
				},
				{ type: "files", id: "data", match: ["/identity/**/*.json"] },
			],
		},
		{
			id: "files",
			title: "Files",
			blocks: [
				{
					type: "files",
					id: "files",
					match: [
						"/identity/**/*.md",
						"/identity/**/*.markdown",
						"/identity/**/*.txt",
						"/identity/**/*.svg",
						"/identity/**/*.html",
						"/identity/**/*.htm",
					],
					skip: ["/identity/voice.md", "/identity/brief.md"],
				},
			],
		},
	],
};

const CUSTOM_STARTER_LAYOUT: SurfaceLayout = {
	schema: SURFACE_LAYOUT_SCHEMA,
	tabs: [{ id: "overview", title: "Overview", blocks: [{ type: "title" }, { type: "files" }] }],
};

export const SURFACE_STARTER_LAYOUTS: Readonly<Record<SurfaceStarterKind, SurfaceLayout>> = {
	product: PRODUCT_STARTER_LAYOUT,
	identity: IDENTITY_STARTER_LAYOUT,
	custom: CUSTOM_STARTER_LAYOUT,
};

export function starterSurfaceLayout(kind: SurfaceStarterKind): SurfaceLayout {
	return structuredClone(SURFACE_STARTER_LAYOUTS[kind]);
}
