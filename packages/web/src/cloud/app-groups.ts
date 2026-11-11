/* Groups of apps in the drawer (Jonas, 11 Nov 2026: "the same way we have categories and groups for agents, we should
 * have so for the interfaces as well … an expandable group of interfaces can live inside an expanded category of
 * interfaces"; design page VvFVpD5DckoSgXMoEGSfqR). The company's groups are its file `apps/groups.md`, which its agents
 * keep; a member's own changes are a document of theirs in the cloud (20260930728000) laid over it: what the member
 * touched is theirs, the rest follows the file. Everything here is pure: the drawer arranges, flattens and changes the
 * member's document with these, and draws the result.
 *
 * Keys are the file's: `page:mailbox|members|bank`, `app:<name>`, `concepts`, `sites`, and `group:<id>` for a group. */

import {
	isAppDrawerKey,
	isAppGroupId,
	parseAppGroups as parseAppGroupsFile,
	type AppGroupNode as SharedAppGroupNode,
} from "@qorpera/cloud-client/app-groups";
import { parseRecord } from "@qorpera/contracts";

export const APP_GROUPS_PATH = "apps/groups.md";
export const APP_GROUPS_MAX_BYTES = 64 * 1024;
export const APP_LAYOUT_SCHEMA = "qorpera.member-app-layout/v1";
/** A group's name, as the file and the member's document allow. */
export const APP_GROUP_NAME_LIMIT = 40;

export interface AppItemNode {
	readonly kind: "item";
	readonly key: string;
}
export interface AppGroupNode {
	readonly kind: "group";
	readonly id: string;
	name: string;
	items: AppTreeNode[];
	/** A group the member made for themselves. */
	mine?: boolean;
}
export type AppTreeNode = AppItemNode | AppGroupNode;

export interface AppPlace {
	/** The group it stands in; null or absent: loose in the drawer. */
	group?: string | null;
	/** The key it stands after there; with neither this nor `first`: last. */
	after?: string | null;
	first?: boolean;
	/** When it was made, as a count: the cloud keeps no order of a document's keys, so places carry their own. */
	at?: number;
}
export interface AppGroupChange {
	/** The member's name for one of the company's groups. */
	name?: string;
	/** The member ungrouped one of the company's groups: its apps stand where it stood. */
	removed?: true;
	/** A group the member made. */
	mine?: { name: string };
}
export interface MemberAppLayout {
	readonly schema: typeof APP_LAYOUT_SCHEMA;
	/** Where the member put apps and groups, each with when (`at`). */
	readonly places: Readonly<Record<string, AppPlace>>;
	readonly groups: Readonly<Record<string, AppGroupChange>>;
}

export const EMPTY_APP_LAYOUT: MemberAppLayout = { schema: APP_LAYOUT_SCHEMA, places: {}, groups: {} };

export const groupKey = (id: string) => `group:${id}`;
export const isGroupKey = (key: string) => key.startsWith("group:");
export const groupIdOf = (key: string) => key.slice("group:".length);

/** The drawer marks a page by its bare name (`mailbox`); the file and the member's document write `page:mailbox`. */
export function fileKey(drawerKey: string): string {
	return drawerKey === "mailbox" || drawerKey === "members" || drawerKey === "bank" ? `page:${drawerKey}` : drawerKey;
}
export function drawerKey(key: string): string {
	return key.startsWith("page:") ? key.slice("page:".length) : key;
}

/** Reads `apps/groups.md` with the same reader the agents' `organize_apps` uses (`@qorpera/cloud-client/app-groups`):
 * a nested list, two group levels; what it cannot read it skips, and only the file's first 64 KiB count. */
export function parseAppGroups(text: string): AppTreeNode[] {
	// A line whose key is no drawer key stays in the file for the agents and is not drawn.
	const tree = (nodes: readonly SharedAppGroupNode[]): AppTreeNode[] =>
		nodes
			.filter((node) => node.kind === "group" || isAppDrawerKey(node.key))
			.map((node) =>
				node.kind === "item"
					? { kind: "item", key: node.key }
					: { kind: "group", id: node.id, name: node.name, items: tree(node.items) },
			);
	return tree(parseAppGroupsFile(text).items);
}

/** The member's document as the cloud keeps it; anything else is the empty one. */
export function parseMemberAppLayout(value: unknown): MemberAppLayout {
	// Lenient: what is not an object reads as nothing, never as a refusal of the whole document.
	const objectOrNothing = (item: unknown): Record<string, unknown> | undefined => {
		try {
			return parseRecord(item, "apps layout");
		} catch {
			return undefined;
		}
	};
	const input = objectOrNothing(value);
	if (!input || input.schema !== APP_LAYOUT_SCHEMA) return EMPTY_APP_LAYOUT;
	const places: Record<string, AppPlace> = {};
	for (const [key, raw] of Object.entries(objectOrNothing(input.places) ?? {})) {
		const place = objectOrNothing(raw);
		if (!place || !(isAppDrawerKey(key) || (isGroupKey(key) && isAppGroupId(groupIdOf(key))))) continue;
		const group = typeof place.group === "string" && isAppGroupId(place.group) ? place.group : null;
		const after = typeof place.after === "string" ? place.after : null;
		const at = typeof place.at === "number" && Number.isSafeInteger(place.at) && place.at >= 0 ? place.at : 0;
		places[key] = { group, after, ...(place.first === true ? { first: true } : {}), at };
	}
	const groups: Record<string, AppGroupChange> = {};
	for (const [id, raw] of Object.entries(objectOrNothing(input.groups) ?? {})) {
		const change = objectOrNothing(raw);
		if (!change || !isAppGroupId(id)) continue;
		const mine = objectOrNothing(change.mine);
		const entry: AppGroupChange = {
			...(typeof change.name === "string" && change.name ? { name: change.name } : {}),
			...(change.removed === true ? { removed: true as const } : {}),
			...(mine && typeof mine.name === "string" && mine.name ? { mine: { name: mine.name } } : {}),
		};
		if (Object.keys(entry).length) groups[id] = entry;
	}
	return { schema: APP_LAYOUT_SCHEMA, places, groups };
}

/** The member's document as the cloud answers it, with when it was last written (null: never, or emptied). */
export interface MemberAppLayoutRead {
	layout: MemberAppLayout;
	updatedAt: string | null;
}

export function parseMemberAppLayoutRead(value: unknown): MemberAppLayoutRead {
	const input = parseRecord(value, "apps layout");
	if (input.schema !== "qorpera.member-app-layout-read/v1") throw new Error("Invalid apps layout");
	return {
		layout: parseMemberAppLayout(input.layout),
		updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
	};
}

/** How many changes the member's document holds, as Reset sidebar counts them. */
export function appLayoutChanges(layout: MemberAppLayout): number {
	return Object.keys(layout.places).length + Object.keys(layout.groups).length;
}

function clone(nodes: readonly AppTreeNode[], present: ReadonlySet<string>, seen: Set<string>): AppTreeNode[] {
	const out: AppTreeNode[] = [];
	for (const node of nodes) {
		if (node.kind === "item") {
			if (present.has(node.key) && !seen.has(node.key)) {
				seen.add(node.key);
				out.push({ kind: "item", key: node.key });
			}
		} else if (!seen.has(groupKey(node.id))) {
			seen.add(groupKey(node.id));
			out.push({ kind: "group", id: node.id, name: node.name, items: clone(node.items, present, seen) });
		}
	}
	return out;
}

interface Found {
	readonly node: AppTreeNode;
	readonly parent: AppTreeNode[];
	/** The group the parent list belongs to; undefined: the drawer itself. */
	readonly owner: AppGroupNode | undefined;
	readonly index: number;
}

function find(tree: AppTreeNode[], key: string, owner?: AppGroupNode): Found | undefined {
	for (const [index, node] of tree.entries()) {
		if ((node.kind === "item" ? node.key : groupKey(node.id)) === key) return { node, parent: tree, owner, index };
		if (node.kind === "group") {
			const inside = find(node.items, key, node);
			if (inside) return inside;
		}
	}
	return undefined;
}

export const nodeKey = (node: AppTreeNode) => (node.kind === "item" ? node.key : groupKey(node.id));

/** The groups of a tree, in drawing order, each with its depth (0: in the drawer, 1: in a group). */
export function groupsOf(tree: readonly AppTreeNode[], depth = 0): { group: AppGroupNode; depth: number }[] {
	return tree.flatMap((node) =>
		node.kind === "group" ? [{ group: node, depth }, ...groupsOf(node.items, depth + 1)] : [],
	);
}

/** The drawer's apps arranged: the company's groups (`company`, from the file), the member's changes over them, and
 * every key in `present` (what the drawer has, in its own order) that neither names standing loose at the end. Keys the
 * drawer does not have are left out, and so is a group with nothing in it. */
export function arrangeApps(
	company: readonly AppTreeNode[],
	layout: MemberAppLayout,
	present: readonly string[],
): AppTreeNode[] {
	return arrangeAppsFully(company, layout, present).tree;
}

/** `arrangeApps`, and the places the arrangement refused (they broke it); the drawer leaves those out of the next
 * change it writes, so a refused place never comes back later nor outweighs a newer move. */
export function arrangeAppsFully(
	company: readonly AppTreeNode[],
	layout: MemberAppLayout,
	present: readonly string[],
): { tree: AppTreeNode[]; refused: ReadonlySet<string> } {
	const refused = new Set<string>();
	const have = new Set(present);
	const seen = new Set<string>();
	const tree = clone(company, have, seen);
	// The member's changes to the company's groups: names, and groups taken apart.
	for (const [id, change] of Object.entries(layout.groups)) {
		if (change.mine) continue;
		const where = find(tree, groupKey(id));
		if (!where || where.node.kind !== "group") continue;
		if (change.removed) where.parent.splice(where.index, 1, ...where.node.items);
		else if (change.name) where.node.name = change.name;
	}
	// The member's own groups, at the end until their place says otherwise.
	for (const [id, change] of Object.entries(layout.groups))
		if (change.mine && !seen.has(groupKey(id))) {
			seen.add(groupKey(id));
			tree.push({ kind: "group", id, name: change.mine.name, items: [], mine: true });
		}
	// What the drawer has that nothing names, loose at the end, before the member's places move anything.
	for (const key of present) if (!seen.has(key)) tree.push({ kind: "item", key });
	// Where everything stands before the member's places: its group (null: the drawer) and its order.
	const parentOf = new Map<string, string | null>();
	const nodes = new Map<string, AppTreeNode>();
	const walkTree = (list: readonly AppTreeNode[], owner: string | null) => {
		for (const node of list) {
			parentOf.set(nodeKey(node), owner);
			nodes.set(nodeKey(node), node);
			if (node.kind === "group") walkTree(node.items, node.id);
		}
	};
	walkTree(tree, null);
	const order = [...nodes.keys()];
	// The member's places that name what is here: the arrangement they make together must hold. A group stands in a
	// group only when that group stands in the drawer and the moved one holds no group, and never inside itself; while
	// it does not hold, the newest place among those that break it is dropped, and the rest are judged again.
	interface Held {
		readonly key: string;
		readonly target: string | null;
		readonly place: AppPlace;
	}
	const held = new Map<string, Held>();
	for (const [key, place] of Object.entries(layout.places)) {
		const target = place.group ?? null;
		if (!nodes.has(key) || (target !== null && nodes.get(groupKey(target))?.kind !== "group")) continue;
		held.set(key, { key, target, place });
	}
	const startOf = new Map(parentOf);
	for (;;) {
		parentOf.clear();
		// A place's group is null for the drawer itself, which `??` would take for no place at all.
		for (const [key, owner] of startOf) parentOf.set(key, held.has(key) ? held.get(key)!.target : owner);
		const parentGroup = (id: string) => parentOf.get(groupKey(id)) ?? null;
		const broken = new Set<string>();
		for (const [key, owner] of parentOf) {
			if (!isGroupKey(key) || owner === null) continue;
			const id = groupIdOf(key);
			// Inside itself: every group on the way up.
			const seenUp = new Set<string>([id]);
			let up: string | null = owner;
			while (up !== null && !seenUp.has(up)) {
				seenUp.add(up);
				up = parentGroup(up);
			}
			if (up !== null) for (const member of seenUp) broken.add(groupKey(member));
			// Three levels: it stands in a group that stands in a group, or it holds a group itself.
			else if (parentGroup(owner) !== null) broken.add(key).add(groupKey(owner));
			else
				for (const [inner, innerOwner] of parentOf)
					if (innerOwner === id && isGroupKey(inner)) broken.add(key).add(inner);
		}
		const culprits = [...broken].map((key) => held.get(key)).filter((entry): entry is Held => entry !== undefined);
		if (!culprits.length) break;
		const newestCulprit = culprits.reduce((a, b) =>
			(b.place.at ?? 0) > (a.place.at ?? 0) || ((b.place.at ?? 0) === (a.place.at ?? 0) && b.key > a.key) ? b : a,
		);
		held.delete(newestCulprit.key);
		refused.add(newestCulprit.key);
	}
	const newest = (a: Held, b: Held) => (b.place.at ?? 0) - (a.place.at ?? 0) || (a.key < b.key ? -1 : 1);
	const oldest = (a: Held, b: Held) => -newest(a, b);
	// Each list laid in as a walk: after each item, what the member put right after it, newest first, each followed in
	// turn by what stands after it; what stands first, newest first, before everything; what stands after something
	// that is not here, oldest first, at the end. How old a place is never reorders what stands after it.
	const lay = (owner: string | null): AppTreeNode[] => {
		const base = order.filter((key) => parentOf.get(key) === owner && !held.has(key));
		const here = [...held.values()].filter((entry) => entry.target === owner);
		const keys = new Set([...base, ...here.map((entry) => entry.key)]);
		const out: string[] = [];
		const done = new Set<string>();
		const visit = (entry: Held) => {
			if (done.has(entry.key)) return;
			done.add(entry.key);
			out.push(entry.key);
			follow(entry.key);
		};
		const follow = (key: string) => {
			for (const entry of here.filter((item) => !item.place.first && item.place.after === key).sort(newest))
				visit(entry);
		};
		for (const entry of here.filter((item) => item.place.first).sort(newest)) visit(entry);
		for (const key of base) {
			out.push(key);
			follow(key);
		}
		for (const entry of here
			.filter((item) => !item.place.first && (!item.place.after || !keys.has(item.place.after)))
			.sort(oldest))
			visit(entry);
		// A place that could only stand after itself goes at the end.
		for (const entry of here.sort(oldest)) visit(entry);
		return out.map((key) => {
			const node = nodes.get(key)!;
			if (node.kind === "group") node.items = lay(node.id);
			return node;
		});
	};
	tree.splice(0, tree.length, ...lay(null));
	const prune = (nodes: AppTreeNode[]): AppTreeNode[] =>
		nodes.flatMap((node): AppTreeNode[] => {
			if (node.kind === "item") return [node];
			node.items = prune(node.items);
			return node.items.length ? [node] : [];
		});
	return { tree: prune(tree), refused };
}

export interface AppTile {
	readonly key: string;
	readonly node: AppTreeNode;
	/** The open groups it stands in, outermost first. */
	readonly chain: readonly string[];
	readonly open: boolean;
}

/** The tiles of the drawer's one grid: each item and group in order, and an open group's tiles right after it. */
export function flattenApps(tree: readonly AppTreeNode[], open: ReadonlySet<string>, chain: string[] = []): AppTile[] {
	return tree.flatMap((node) => {
		if (node.kind === "item") return [{ key: node.key, node, chain, open: false }];
		const isOpen = open.has(node.id);
		const tile: AppTile = { key: groupKey(node.id), node, chain, open: isOpen };
		return isOpen ? [tile, ...flattenApps(node.items, open, [...chain, node.id])] : [tile];
	});
}

/** Every app key in a node, in order. */
export function appsIn(node: AppTreeNode): string[] {
	return node.kind === "item" ? [node.key] : node.items.flatMap(appsIn);
}

/* ---- Changes to the member's document --------------------------------------------------------------------------- */

/** The member's document without the places an arrangement refused. */
export function withoutRefused(layout: MemberAppLayout, refused: ReadonlySet<string>): MemberAppLayout {
	if (!refused.size) return layout;
	return { ...layout, places: Object.fromEntries(Object.entries(layout.places).filter(([key]) => !refused.has(key))) };
}

/** Sets or takes away a place; a new one is the newest (`at`). */
function withPlace(layout: MemberAppLayout, key: string, place: AppPlace | undefined): MemberAppLayout {
	const { [key]: _old, ...rest } = layout.places;
	if (!place) return { ...layout, places: rest };
	const at = Math.max(0, ...Object.values(layout.places).map((other) => other.at ?? 0)) + 1;
	return { ...layout, places: { ...rest, [key]: { ...place, at } } };
}

/** Keeps the places that stood right after `key` (in its own list) where they stood when `key` leaves: the first takes
 * `before`'s place after it (first, with none), each next one stands after the one before it; how old each is stays. */
function rebaseAfter(
	layout: MemberAppLayout,
	list: readonly AppTreeNode[],
	container: string | null,
	key: string,
	before: string | null,
): MemberAppLayout {
	const order = new Map(list.map((node, index) => [nodeKey(node), index]));
	const followers = Object.entries(layout.places)
		.filter(([other, place]) => other !== key && place.after === key && (place.group ?? null) === container)
		.sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
	let anchor = before;
	const places = { ...layout.places };
	for (const [other, place] of followers) {
		const { after: _a, first: _f, ...rest } = place;
		places[other] = anchor ? { ...rest, after: anchor } : { ...rest, first: true };
		anchor = other;
	}
	return { ...layout, places };
}

/** Puts `key` (an app or `group:<id>`) in `group` (null: loose), after `after` there (null: first). What the member placed
 * right after it keeps standing where it stood, after what stood before it. */
export function placeApp(
	layout: MemberAppLayout,
	tree: AppTreeNode[],
	key: string,
	group: string | null,
	after: string | null,
): MemberAppLayout {
	let next = layout;
	const here = find(tree, key);
	if (here) {
		const before = here.index > 0 ? nodeKey(here.parent[here.index - 1]!) : null;
		next = rebaseAfter(next, here.parent, here.owner?.id ?? null, key, before);
	}
	return withPlace(next, key, after ? { group, after } : { group, first: true });
}

/** A new group of the member's own with `onto` and then `dragged` in it, standing where `onto` stood. */
export function makeAppGroup(
	layout: MemberAppLayout,
	tree: AppTreeNode[],
	dragged: string,
	onto: string,
	name: string,
	id: string,
): MemberAppLayout {
	const where = find(tree, onto);
	if (!where) return layout;
	const before = where.index > 0 ? nodeKey(where.parent[where.index - 1]!) : null;
	let next: MemberAppLayout = { ...layout, groups: { ...layout.groups, [id]: { mine: { name } } } };
	next = withPlace(
		next,
		groupKey(id),
		before ? { group: where.owner?.id ?? null, after: before } : { group: where.owner?.id ?? null, first: true },
	);
	next = placeApp(next, tree, onto, id, null);
	return placeApp(next, tree, dragged, id, onto);
}

/** Renames a group in the member's drawer; back to the company's name, nothing of the member's is left. */
export function renameAppGroup(
	layout: MemberAppLayout,
	id: string,
	name: string,
	companyName: string | undefined,
): MemberAppLayout {
	const change = layout.groups[id] ?? {};
	const { name: _old, ...rest } = change;
	const updated: AppGroupChange = change.mine
		? { ...change, mine: { name } }
		: name === companyName
			? rest
			: { ...change, name };
	const { [id]: _gone, ...others } = layout.groups;
	return { ...layout, groups: Object.keys(updated).length ? { ...others, [id]: updated } : others };
}

/** Takes a group apart in the member's drawer: its apps and groups stand where it stood, in its order. */
export function ungroupApps(layout: MemberAppLayout, tree: AppTreeNode[], id: string): MemberAppLayout {
	const where = find(tree, groupKey(id));
	if (!where || where.node.kind !== "group") return layout;
	const container = where.owner?.id ?? null;
	let after = where.index > 0 ? nodeKey(where.parent[where.index - 1]!) : null;
	let next = layout;
	// Places pointing into the group are dropped first: its apps are placed again just below.
	for (const [key, place] of Object.entries(layout.places))
		if (place.group === id) next = withPlace(next, key, undefined);
	for (const node of where.node.items) {
		const key = nodeKey(node);
		next = withPlace(next, key, after ? { group: container, after } : { group: container, first: true });
		after = key;
	}
	// What stood right after the group now stands after its last app.
	next = rebaseAfter(next, where.parent, container, groupKey(id), after);
	const { [id]: change, ...others } = next.groups;
	next = withPlace({ ...next, groups: others }, groupKey(id), undefined);
	return change?.mine ? next : { ...next, groups: { ...next.groups, [id]: { removed: true } } };
}

/** A name for a new group from its first two apps' names: the first word they share, else "Group". */
export function suggestGroupName(first: string, second: string, fallback: string): string {
	const a = first.trim().split(/\s+/)[0] ?? "";
	const b = second.trim().split(/\s+/)[0] ?? "";
	return a && a.toLocaleLowerCase() === b.toLocaleLowerCase() ? a.slice(0, APP_GROUP_NAME_LIMIT) : fallback;
}
