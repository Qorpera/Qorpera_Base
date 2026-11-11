import { isInterfaceName } from "./interfaces.ts";

/* App groups (APP-GROUPS-SPEC §1; Jonas, 11 November 2026: "the same way we have categories and groups for agents, we
 * should have so for the interfaces as well"): the company's layout of the apps drawer, a plain Markdown file in the
 * Company File, `apps/groups.md`, kept by its agents with `organize_apps`. It is not an app (`appPath` reads no app in
 * `groups.md`), so the drawer, which lists the folders of `apps/`, does not show it as one.
 *
 * The file is a nested list, two spaces a level:
 *   - an item is `- <key>` and words for reading (ignored): `page:mailbox`, `page:members`, `page:bank`,
 *     `app:<name>`, `concepts`, `sites` or `whats-new`;
 *   - a group is `- group <id>: <name>`, its items the lines under it indented two more spaces, in order.
 * At most two group levels: a deeper line is read at its nearest allowed level. The first line of a key or group id
 * wins. Lines that are not list items are notes: the ones before the list stay before it, the others are written after
 * it. The ids of groups that are gone are kept in one note, so no new group takes an id a member's own changes point at.
 * The reader takes the first 64 KiB and ignores the rest. Browser-safe: the web's drawer reads the same file. */

export const APP_GROUPS_PATH = "apps/groups.md";
export const APP_GROUPS_MAX_BYTES = 64 * 1024;
export const APP_GROUP_ID_MAX_CHARS = 40;
export const APP_GROUP_NAME_MAX_CHARS = 40;
/** A group in a group, nothing deeper. */
export const APP_GROUP_LEVELS = 2;
/** How an item names a whole group where a key is expected (organize_apps' `move`, members' own changes). */
export const APP_GROUP_KEY_PREFIX = "group:";
/** The platform's pages the drawer shows, in their order there. */
export const APP_DRAWER_PAGES = Object.freeze(["mailbox", "members", "bank"] as const);

export interface AppGroupItem {
	readonly kind: "item";
	readonly key: string;
	/** The words after the key, for reading only. */
	readonly words: string;
}

export interface AppGroup {
	readonly kind: "group";
	readonly id: string;
	readonly name: string;
	readonly items: readonly AppGroupNode[];
}

export type AppGroupNode = AppGroupItem | AppGroup;

export interface AppGroupsFile {
	/** The notes before the list, as written. */
	readonly head: readonly string[];
	readonly items: readonly AppGroupNode[];
	/** The other notes, in their order; written after the list. */
	readonly notes: readonly string[];
	/** The ids of groups that were ungrouped: never given to a new group. */
	readonly retired: readonly string[];
}

/** What the drawer draws: the file's items the company has, in its order, groups with nothing to draw left out, then
 * the keys the file does not list, loose, in the order given. */
export type AppGroupsDrawnNode =
	| { readonly kind: "item"; readonly key: string }
	| {
			readonly kind: "group";
			readonly id: string;
			readonly name: string;
			readonly items: readonly AppGroupsDrawnNode[];
	  };

const GROUP_ID = /^[a-z0-9-]{1,40}$/;
// Every pattern here runs in time linear in its line, whatever a line holds (a run of 60,000 spaces included): no two
// quantifiers next to each other can take the same character. Trailing spaces, tabs and carriage returns are cut with
// a loop (`trimTail`), not a pattern.
const LIST_LINE = /^([ \t]*)[-*][ \t]+(\S.*)$/s;
const GROUP_LINE = /^group[ \t]+([^\s:]+)[ \t]*:[ \t]*(.*)$/s;
const RETIRED_LINE = /^<!--[ \t]*retired group ids:([^>]*)-->[ \t]*$/;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
/** What would end a line where a list line is written: written as a space. */
const BREAKS = /[\r\n\u2028\u2029]+/g;

/** Whether a key is one of the drawer's: a platform page, an app's folder, Concepts, Sites or What's new. What's new
 * (own code storage, step 4) is the platform's page, the bare `whats-new`; `app:whats-new` is an agent's app. */
export function isAppDrawerKey(key: string): boolean {
	if (key === "concepts" || key === "sites" || key === "whats-new") return true;
	if (key.startsWith("page:")) return (APP_DRAWER_PAGES as readonly string[]).includes(key.slice(5));
	return key.startsWith("app:") && isInterfaceName(key.slice(4));
}

export function isAppGroupId(id: string): boolean {
	return GROUP_ID.test(id);
}

/** A group's name as the file keeps it (one line, runs of spaces as one, 1 to 40 characters), or null. */
export function appGroupName(value: string): string | null {
	if (CONTROL.test(value)) return null;
	const name = value.trim().replace(/\s+/g, " ");
	const length = [...name].length;
	return length >= 1 && length <= APP_GROUP_NAME_MAX_CHARS ? name : null;
}

/** A new group's id from its name: lowercase a–z, digits and hyphens, at most 40, not one of `taken` (the file's ids
 * and its retired ones); "group" when the name has none of those letters. */
export function appGroupSlug(name: string, taken: ReadonlySet<string>): string {
	const base =
		name
			.toLowerCase()
			.replace(/æ/g, "ae")
			.replace(/ø/g, "oe")
			.replace(/ß/g, "ss")
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, APP_GROUP_ID_MAX_CHARS)
			.replace(/-+$/, "") || "group";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const end = `-${n}`;
		const id = `${base.slice(0, APP_GROUP_ID_MAX_CHARS - end.length).replace(/-+$/, "")}${end}`;
		if (!taken.has(id)) return id;
	}
}

/** Reads `apps/groups.md`. Never fails: what does not read as the list is a note, and the rest past 64 KiB is left. */
export function parseAppGroups(text: string): AppGroupsFile {
	const lines = bounded(text).split("\n");
	if (lines.at(-1) === "") lines.pop();
	const head: string[] = [];
	const notes: string[] = [];
	const retired: string[] = [];
	const root: AppGroupNode[] = [];
	// The open containers by level: the list itself, then the group open at each level.
	const stack: AppGroupNode[][] = [root];
	const keys = new Set<string>();
	const ids = new Set<string>();
	const retiredSeen = new Set<string>();
	let listed = false;
	for (const raw of lines) {
		// Every carriage return at a line's end goes, so no line, key or words end in one and a written line reads back
		// the same.
		const line = trimTail(raw, "\r");
		const kept = RETIRED_LINE.exec(line);
		if (kept) {
			for (const id of (kept[1] ?? "").split(/[\s,]+/))
				if (isAppGroupId(id) && !retiredSeen.has(id)) {
					retiredSeen.add(id);
					retired.push(id);
				}
			continue;
		}
		const item = LIST_LINE.exec(line);
		if (!item) {
			(listed ? notes : head).push(line);
			continue;
		}
		listed = true;
		const width = [...(item[1] ?? "")].reduce((sum, character) => sum + (character === "\t" ? 2 : 1), 0);
		const content = trimTail(item[2] ?? "", " \t\r");
		const group = GROUP_LINE.exec(content);
		const id = group?.[1] ?? "";
		const name = group ? appGroupName(group[2] ?? "") : null;
		if (group && isAppGroupId(id) && name !== null) {
			// A group sits at most one level in; the first line of an id wins, and a later one's items stand where it does.
			const level = Math.min(Math.floor(width / 2), APP_GROUP_LEVELS - 1, stack.length - 1);
			stack.length = level + 1;
			if (ids.has(id)) continue;
			ids.add(id);
			const items: AppGroupNode[] = [];
			stack[level]?.push({ kind: "group", id, name, items });
			stack.push(items);
			continue;
		}
		const level = Math.min(Math.floor(width / 2), stack.length - 1);
		stack.length = level + 1;
		const space = content.search(/[ \t]/);
		const key = space < 0 ? content : content.slice(0, space);
		// A drawer key's words are trimmed; any other item keeps its words as written but the spaces after the key, so
		// it reads back the same (trim would also take a line or paragraph separator at either end).
		const rest = space < 0 ? "" : content.slice(space);
		const words = isAppDrawerKey(key) ? rest.trim() : rest.replace(/^[ \t]+/, "");
		// The first line of a drawer key wins; a line that names no drawer key is kept where it is.
		if (isAppDrawerKey(key)) {
			if (keys.has(key)) continue;
			keys.add(key);
		}
		stack[level]?.push({ kind: "item", key, words });
	}
	while (head.length > 0 && !head.at(-1)?.trim()) head.pop();
	while (notes.length > 0 && !notes[0]?.trim()) notes.shift();
	while (notes.length > 0 && !notes.at(-1)?.trim()) notes.pop();
	return { head, items: root, notes, retired: retired.filter((id) => !ids.has(id)) };
}

/** Writes `apps/groups.md`: the notes before the list, the list two spaces a level, the other notes, and the retired
 * ids. What it writes reads back as the same file. */
export function writeAppGroups(file: AppGroupsFile): string {
	const list: string[] = [];
	const walk = (items: readonly AppGroupNode[], level: number) => {
		const indent = "  ".repeat(level);
		for (const node of items) {
			if (node.kind === "group") {
				list.push(`${indent}- group ${node.id}: ${node.name.replace(BREAKS, " ")}`);
				walk(node.items, level + 1);
			} else {
				// A drawer key's words may come from a title: a break in them is written as a space. Any other item's line
				// is written as it was read, so it reads back the same.
				const words = isAppDrawerKey(node.key) ? node.words.replace(BREAKS, " ").trim() : node.words;
				list.push(`${indent}- ${node.key}${words ? ` ${words}` : ""}`);
			}
		}
	};
	walk(file.items, 0);
	const blocks = [
		trimBlank(file.head),
		list,
		trimBlank(file.notes),
		file.retired.length > 0 ? [`<!-- retired group ids: ${file.retired.join(", ")} -->`] : [],
	].filter((block) => block.length > 0);
	return blocks.length === 0 ? "" : `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

/** Every group in the list with its parent (null at the top) and its level (0 at the top), in order. */
export function appGroupsGroups(
	items: readonly AppGroupNode[],
): { readonly group: AppGroup; readonly parent: AppGroup | null; readonly level: number }[] {
	const found: { group: AppGroup; parent: AppGroup | null; level: number }[] = [];
	const walk = (nodes: readonly AppGroupNode[], parent: AppGroup | null, level: number) => {
		for (const node of nodes)
			if (node.kind === "group") {
				found.push({ group: node, parent, level });
				walk(node.items, node, level + 1);
			}
	};
	walk(items, null, 0);
	return found;
}

/** What the drawer draws from the file for a company that has `have` (its keys in the drawer's own order: pages, apps
 * by name, Concepts, Sites, What's new): the listed keys it has, groups with nothing to draw left out, then the rest
 * loose. `missing` is the drawer keys the file lists that the company does not have. */
export function resolveAppGroups(
	file: Pick<AppGroupsFile, "items">,
	have: readonly string[],
): { readonly items: readonly AppGroupsDrawnNode[]; readonly missing: readonly string[] } {
	const present = new Set(have);
	const seen = new Set<string>();
	const missing: string[] = [];
	const walk = (nodes: readonly AppGroupNode[]): AppGroupsDrawnNode[] =>
		nodes.flatMap((node): AppGroupsDrawnNode[] => {
			if (node.kind === "group") {
				const items = walk(node.items);
				return items.length > 0 ? [{ kind: "group", id: node.id, name: node.name, items }] : [];
			}
			if (!isAppDrawerKey(node.key) || seen.has(node.key)) return [];
			seen.add(node.key);
			if (!present.has(node.key)) {
				missing.push(node.key);
				return [];
			}
			return [{ kind: "item", key: node.key }];
		});
	const items = walk(file.items);
	for (const key of have)
		if (!seen.has(key)) {
			seen.add(key);
			items.push({ kind: "item", key });
		}
	return { items, missing };
}

function bounded(text: string): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.byteLength <= APP_GROUPS_MAX_BYTES) return text;
	const cut = new TextDecoder().decode(bytes.subarray(0, APP_GROUPS_MAX_BYTES));
	const end = cut.lastIndexOf("\n");
	return end < 0 ? "" : cut.slice(0, end + 1);
}

/** `text` without the characters of `cut` at its end. */
function trimTail(text: string, cut: string): string {
	let end = text.length;
	while (end > 0 && cut.includes(text[end - 1] as string)) end--;
	return end === text.length ? text : text.slice(0, end);
}

function trimBlank(lines: readonly string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && !out[0]?.trim()) out.shift();
	while (out.length > 0 && !out.at(-1)?.trim()) out.pop();
	return out;
}
