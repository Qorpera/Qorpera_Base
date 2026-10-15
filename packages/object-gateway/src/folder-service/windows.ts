import { folderKey } from "./pending.ts";
import type { CommitUnit } from "./plan.ts";
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

/** Whether `key` is `prefix` or a path under it (both folded, or both as spelled). */
function under(key: string, prefix: string): boolean {
	return key === prefix || key.startsWith(`${prefix}/`);
}

/** A folded path's tags, and the one spelling of it they were tagged at: none once two spellings were (the core folds
 * them into one path, as a file removed at one spelling and made again at another). */
interface Tagged {
	readonly tags: Set<string>;
	path: string | undefined;
}

/** What each pending path of a test machine's view was changed under, by folded path: command ids, or the starter. */
export class CreditTags {
	readonly #tags = new Map<string, Tagged>();

	/** A change to these paths, made under these tags. */
	tag(paths: readonly string[], tags: readonly string[]): void {
		for (const path of paths) {
			const key = folderKey(path);
			const tagged = this.#tags.get(key);
			if (tagged === undefined) {
				this.#tags.set(key, { tags: new Set(tags), path });
				continue;
			}
			if (tagged.path !== path) tagged.path = undefined;
			for (const tag of tags) tagged.tags.add(tag);
		}
	}

	/** A rename, made under these tags: the tags of `from` and of everything under it go with it to `to`, in place of
	 * what `to` had (it is replaced), and `to` is tagged with the rename's own. A move's unit names only `to`, so
	 * nothing is left on `from`. */
	rename(from: string, to: string, tags: readonly string[]): void {
		const source = folderKey(from);
		const target = folderKey(to);
		const moved: [string, Tagged][] = [];
		for (const [key, { tags: set, path }] of this.#tags)
			if (under(key, source)) {
				const spelled = path !== undefined && under(path, from) ? to + path.slice(from.length) : undefined;
				moved.push([target + key.slice(source.length), { tags: set, path: spelled }]);
			}
		for (const key of [...this.#tags.keys()]) if (under(key, source) || under(key, target)) this.#tags.delete(key);
		for (const [key, tagged] of moved) this.#tags.set(key, tagged);
		this.tag([to], tags);
	}

	/** The node at `path`, which the view had moved there from `origin`, was removed under these tags (unlinked, or
	 * replaced by a rename): its removal is published at `origin`, which takes the tags of `path` and the removal's. */
	carry(path: string, origin: string, tags: readonly string[]): void {
		this.tag([origin], [...(this.#tags.get(folderKey(path))?.tags ?? []), ...tags]);
	}

	/** A change left nothing pending at `path` (`left` says what is): a file made and removed again, or one moved here
	 * and removed (its removal is its origin's). Its tags go, so what is made there next is credited afresh. Tags also
	 * taken at another spelling of the path stay until a boundary prunes them (`prune`). */
	forget(path: string, left: (path: string) => boolean): void {
		const key = folderKey(path);
		if (this.#tags.get(key)?.path === path && !left(path)) this.#tags.delete(key);
	}

	/** The commands a unit publishing these paths is credited to, sorted; none when only the starter changed them.
	 * A unit that mixes the starter's changes with commands' is credited to the commands alone: `credits` cannot name
	 * the starter, and leaving it out would credit the commands' changes to the starter. */
	credits(paths: readonly string[]): readonly string[] | undefined {
		const ids = new Set<string>();
		for (const path of paths)
			for (const tag of this.#tags.get(folderKey(path))?.tags ?? []) if (tag !== STARTER) ids.add(tag);
		return ids.size === 0 ? undefined : [...ids].sort();
	}

	/** At a boundary: forgets every path but these, which are still pending (what it publishes or keeps, or what it
	 * kept once settled). A change undone before it was published (a move made and moved back) has none left. */
	prune(pending: Iterable<string>): void {
		if (this.#tags.size === 0) return;
		const left = new Set<string>();
		for (const path of pending) left.add(folderKey(path));
		for (const key of [...this.#tags.keys()]) if (!left.has(key)) this.#tags.delete(key);
	}

	clear(): void {
		this.#tags.clear();
	}
}
