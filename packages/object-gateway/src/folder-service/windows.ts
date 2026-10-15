import { folderKey, type LiveRef, type PendingFile, type PendingFolder, type PendingView } from "./pending.ts";
import type { CommitUnit, PlannedUnit } from "./plan.ts";
import { ErrorCode, ProtocolError } from "./protocol.ts";

/** A command window on a test machine (F3 6b): the executor opens one when a command starts on the machine and closes
 * it when the command ends. A change the machine makes while windows are open is credited to their commands (6a's
 * `credits`); one made while none is open is the starter's, the view's actor. */
export interface CommandWindow {
	readonly commandId: string;
	readonly runId: string;
	readonly staffAgentId: string;
	readonly requestedByUserId: string;
}

/** The tag of a change made while no window was open: the starter's. It is not a uuid, so no command has it. */
export const STARTER = "starter";

/** A commit unit with the commands it is credited to; none, when it is the starter's alone. */
export type CreditedUnit = CommitUnit & { readonly credits?: readonly string[] };

/** The command windows open on each test machine, by its placement id. They are kept in memory only: after a restart of
 * the service none is open until the executor opens it again. */
export class CommandWindows {
	readonly #open = new Map<string, Map<string, CommandWindow>>();

	/** Opens a window. Opening it again is a no-op; the same command with other ids is refused. */
	open(machine: string, window: CommandWindow): void {
		let windows = this.#open.get(machine);
		const known = windows?.get(window.commandId);
		if (known !== undefined) {
			if (
				known.runId !== window.runId ||
				known.staffAgentId !== window.staffAgentId ||
				known.requestedByUserId !== window.requestedByUserId
			)
				throw new ProtocolError(ErrorCode.badRequest, `The command ${window.commandId} is open with other ids`);
			return;
		}
		if (windows === undefined) {
			windows = new Map();
			this.#open.set(machine, windows);
		}
		windows.set(window.commandId, window);
	}

	/** Closes a window. Closing one that is not open is a no-op, so the request may be repeated. */
	close(machine: string, commandId: string): void {
		const windows = this.#open.get(machine);
		if (windows?.delete(commandId) && windows.size === 0) this.#open.delete(machine);
	}

	/** What a change made on the machine now is tagged with: the open windows' commands, or the starter. */
	tags(machine: string): readonly string[] {
		const windows = this.#open.get(machine);
		return windows === undefined ? [STARTER] : [...windows.keys()];
	}

	/** Closes every window of the machine: its view closed, or its instance restarted. */
	clear(machine: string): void {
		this.#open.delete(machine);
	}
}

/** What a change changes, for a test machine's credits: these paths (made, cut, written or removed), or a rename's. */
export type Changed = readonly string[] | { readonly from: string; readonly to: string };

type Node = PendingFile | PendingFolder;

/** Whether the node at `path` has anything to publish, as planBoundary reads it: it is new or moved, or has bytes or a
 * bit of its own. One with nothing (a move moved back, a bit set back) is published as nothing. */
function differs(node: Node, path: string): boolean {
	const origin = node.origin;
	if (origin === undefined || origin.path !== path) return true;
	return node.kind === "file" && (node.content !== undefined || node.executable !== origin.entry?.executable);
}

/** A path a change may remove: the live path its removal would be recorded at (a node's origin), the tags of the node
 * it would take, and the removal recorded there before. */
export interface Removable {
	readonly at: string;
	readonly tags: readonly string[];
	readonly was: LiveRef | undefined;
}

/** What a change saw before it was made (`CreditTags.before`). */
export interface Before {
	readonly removable: readonly Removable[];
	/** The node each path it changes showed, and its version: one still there at that version was not changed. */
	readonly shown: ReadonlyMap<string, { readonly node: Node; readonly version: string } | undefined>;
	/** A rename's target: the nodes a new folder had inside it are moved with it. */
	readonly moved?: string;
}

/**
 * What a test machine's pending changes were made under (F3 6b): command ids, or the starter.
 *
 * The invariant: a unit is credited to exactly the commands whose windows were open when a change now in it was made
 * (none, when only the starter's are). It holds because tags are kept on the two things a boundary publishes, and on
 * nothing else:
 * - a pending node (the object, never its path) has the tags of the changes made to it since it last had nothing to
 *   publish. They go with it through renames, and go when it does: removed, settled, or back to nothing to publish.
 *   Chunks no close fixed have theirs apart until the close that fixes them takes them in the same step; a file
 *   abandoned, or removed, before that loses them, and their tags.
 * - a pending removal of a live path (the path removed, or the origin of the node removed) has the tags of the change
 *   that removed it and of the node it took. They are kept by that live path, which no rename moves, and hold while
 *   that removal is the one pending there: published, dropped or replaced, it has none.
 * A unit's credits are read from what it publishes as its boundary plans it: a delete's from the removals it names;
 * any other unit's from the nodes it names, and a new file published as the next version of a live file the view
 * removed (with that file's `expectedVersion`) also from that removal. Such a file the core refused and the boundary
 * keeps pending takes that removal's tags as it settles, which drops the removal: sent again, a unit kept pending is
 * credited as it was. A change undone (a file made and removed, a move moved back) leaves nothing that holds its tags.
 * Each of these is made in the same synchronous step as the change to the pending view it follows, so no other change
 * sees one without the other.
 */
export class CreditTags {
	#nodes = new WeakMap<Node, Set<string>>();
	#unfixed = new WeakMap<PendingFile, Set<string>>();
	readonly #removals = new Map<string, { readonly ref: LiveRef; readonly tags: ReadonlySet<string> }>();
	/** Anything was tagged since the tags were cleared: other views' never are, and their boundaries skip this. */
	#used = false;

	/** Before a change: what it may remove (the paths it names, or a rename's target), and what it changes shows. */
	before(pending: PendingView, changed: Changed): Before {
		const removable: Removable[] = [];
		const shown = new Map<string, { node: Node; version: string } | undefined>();
		for (const path of "from" in changed ? [changed.to] : changed) {
			const r = pending.resolve(path);
			shown.set(path, r?.kind === "node" ? { node: r.node, version: r.node.version } : undefined);
			const at = r === undefined ? undefined : r.kind === "live" ? r.source : r.node.origin?.path;
			const was = at === undefined ? undefined : pending.removed().get(at);
			if (at !== undefined)
				removable.push({ at, tags: r?.kind === "node" ? [...(this.#nodes.get(r.node) ?? [])] : [], was });
		}
		return { removable, shown, ...("from" in changed ? { moved: changed.to } : {}) };
	}

	/** After a change made under `tags`: a removal it recorded takes them and those of the node it took; a node it made,
	 * moved or changed takes them (and so do those a new folder it moved had inside), unless it is left with nothing to
	 * publish, when it has none. */
	after(pending: PendingView, before: Before, tags: readonly string[]): void {
		for (const { at, tags: taken, was } of before.removable) {
			const ref = pending.removed().get(at);
			if (ref === undefined || ref === was) continue;
			this.#removals.set(at, { ref, tags: new Set([...taken, ...tags]) });
			this.#used = true;
		}
		for (const [path, shown] of before.shown) {
			const r = pending.resolve(path);
			if (r?.kind !== "node" || (shown !== undefined && r.node === shown.node && r.node.version === shown.version))
				continue;
			if (!differs(r.node, path)) {
				this.#forget(r.node);
				continue;
			}
			this.#add(this.#nodes, r.node, tags);
		}
		if (before.moved !== undefined)
			for (const [path, node] of pending.nodes())
				if (node.kind !== "gone" && path.startsWith(`${before.moved}/`)) this.#add(this.#nodes, node, tags);
	}

	/** A chunk set in a file open for writing, under these tags: in the step that sets it. */
	wrote(file: PendingFile, tags: readonly string[]): void {
		this.#add(this.#unfixed, file, tags);
	}

	/** A close fixed the file's chunks: their tags are the file's, from the close's own step on. */
	fixed(file: PendingFile): void {
		const unfixed = this.#unfixed.get(file);
		this.#unfixed.delete(file);
		if (unfixed !== undefined) this.#add(this.#nodes, file, [...unfixed]);
	}

	/** The file's last handle was abandoned: the chunks no close fixed are lost, and their tags. Left with nothing to
	 * publish (at its origin's path: a file open for writing with an origin is never moved), it has none. */
	abandoned(file: PendingFile): void {
		this.#unfixed.delete(file);
		if (file.origin !== undefined && !differs(file, file.origin.path)) this.#forget(file);
	}

	/** Each unit's credits, read from the pending changes it publishes as its boundary plans it: the commands, sorted;
	 * none when only the starter changed them. A unit mixing the starter's changes with commands' is the commands':
	 * `credits` cannot name the starter, and leaving it out would credit the commands' changes to the starter. */
	credits(units: readonly PlannedUnit[], pending: PendingView): (readonly string[] | undefined)[] {
		if (!this.#used) return units.map(() => undefined);
		const removed = this.#removedByKey(pending);
		return units.map(({ unit, paths }) => {
			const ids = new Set<string>();
			const add = (tags: Iterable<string> | undefined): void => {
				for (const tag of tags ?? []) if (tag !== STARTER) ids.add(tag);
			};
			for (const path of paths) {
				if (unit.op === "delete") {
					add(this.#removal(pending, path));
					continue;
				}
				const node = pending.nodes().get(path);
				if (node === undefined || node.kind === "gone") continue;
				add(this.#nodes.get(node));
				if (node.kind === "file") add(this.#unfixed.get(node));
				add(this.#replaced(unit, node, path, pending, removed));
			}
			return ids.size === 0 ? undefined : [...ids].sort();
		});
	}

	/** As a boundary settles, before the view drops every removal: a file it keeps pending (the core refused it) that it
	 * published as the next version of a live file the view removed takes that removal's tags, so that sent again it is
	 * credited as it was. `keep`: the nodes the settle keeps. */
	kept(units: readonly PlannedUnit[], pending: PendingView, keep: ReadonlySet<string>): void {
		if (!this.#used) return;
		const removed = this.#removedByKey(pending);
		for (const { unit, paths } of units)
			for (const path of paths) {
				const node = pending.nodes().get(path);
				if (!keep.has(path) || node === undefined || node.kind === "gone") continue;
				const tags = this.#replaced(unit, node, path, pending, removed);
				if (tags !== undefined) this.#add(this.#nodes, node, [...tags]);
			}
	}

	/** At a boundary, and once it settled: tags of nothing pending go. A node with nothing to publish has none, so what
	 * it is changed in next is credited afresh; a removal no longer the one pending at its path has none. */
	prune(pending: PendingView): void {
		if (!this.#used) return;
		for (const [path, node] of pending.nodes()) if (node.kind !== "gone" && !differs(node, path)) this.#forget(node);
		for (const [at, { ref }] of this.#removals) if (pending.removed().get(at) !== ref) this.#removals.delete(at);
	}

	clear(): void {
		this.#nodes = new WeakMap();
		this.#unfixed = new WeakMap();
		this.#removals.clear();
		this.#used = false;
	}

	/** The tags of the removal a unit publishing a new file at `path` takes in: one of a live file the view removed
	 * there, whose version the unit names as its `expectedVersion`. */
	#replaced(
		unit: CommitUnit,
		node: Node,
		path: string,
		pending: PendingView,
		removed: () => ReadonlyMap<string, string>,
	): ReadonlySet<string> | undefined {
		if (unit.op !== "write" || unit.expectedVersion === undefined || node.origin !== undefined) return undefined;
		const at = removed().get(folderKey(path));
		if (at === undefined || pending.removed().get(at)?.version !== unit.expectedVersion) return undefined;
		return this.#removal(pending, at);
	}

	/** The view's removals by folded key, made when first asked. */
	#removedByKey(pending: PendingView): () => ReadonlyMap<string, string> {
		let removed: Map<string, string> | undefined;
		return () => {
			removed ??= new Map([...pending.removed().keys()].map((at) => [folderKey(at), at]));
			return removed;
		};
	}

	#removal(pending: PendingView, at: string): ReadonlySet<string> | undefined {
		const removal = this.#removals.get(at);
		return removal !== undefined && pending.removed().get(at) === removal.ref ? removal.tags : undefined;
	}

	#add<K extends Node>(map: WeakMap<K, Set<string>>, node: K, tags: readonly string[]): void {
		let set = map.get(node);
		if (set === undefined) {
			set = new Set();
			map.set(node, set);
		}
		for (const tag of tags) set.add(tag);
		this.#used = true;
	}

	#forget(node: Node): void {
		this.#nodes.delete(node);
		if (node.kind === "file") this.#unfixed.delete(node);
	}
}
