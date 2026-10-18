/** Git on the mount (deploy/first-node/RUNTIME-COMPANY-FOLDER.md §6 "Git on the mount"; crates/qorpera-folder/src/git.rs
 * is the program's half): what a path in a code area `code/<owner>/<name>/` is to git, and so what this service does
 * with it. The core holds the leases on git's shared files and the version check at the rename that publishes one;
 * this service asks for them as git locks and renames, and keeps out of the folder what must never be in it. */

import type { FileRef } from "./pending.ts";

/** A unit of a git publish or of a lease's release (5b): a file written over the version it names (none for an
 * object, which is its content; null for a file that must not exist yet), or a file deleted. */
export type GitUnit =
	| { readonly op: "write"; readonly path: string; readonly file: FileRef; readonly expectedVersion?: string | null }
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion: string };

export type GitPlace =
	/** Not in a code area's `repo.git/` or `worktrees/<worker>/`. */
	| { readonly kind: "other" }
	/** In the shared git directory: `area` is `code/<owner>/<name>`, `rest` the path below `repo.git/` ("" for
	 * `repo.git` itself). */
	| { readonly kind: "git"; readonly area: string; readonly rest: string }
	/** In a worker's worktree: `rest` is the path below `worktrees/<worker>/` ("" for the worktree itself). */
	| { readonly kind: "worktree"; readonly area: string; readonly worker: string; readonly rest: string };

const OTHER: GitPlace = { kind: "other" };

/** Where `path` is in a code area. */
export function gitPlace(path: string): GitPlace {
	if (!path.startsWith("code/")) return OTHER;
	const parts = path.split("/");
	if (parts.length < 4) return OTHER;
	const area = parts.slice(0, 3).join("/");
	if (parts[3] === "repo.git") return { kind: "git", area, rest: parts.slice(4).join("/") };
	if (parts[3] === "worktrees" && parts.length > 4)
		return { kind: "worktree", area, worker: parts[4], rest: parts.slice(5).join("/") };
	return OTHER;
}

/** A git file each session keeps its own copy of on its machine's disk, never published (`rest` is below
 * `repo.git/`): the repository's `config`, `hooks/**` and `info/**`, and a worktree's `config.worktree`, with the
 * locks git writes them through. Git runs what they say, so a copy published by one session would run in every other. */
export function gitSessionLocal(rest: string): boolean {
	const parts = rest.split("/");
	if (rest === "config" || rest === "config.lock" || parts[0] === "hooks" || parts[0] === "info") return true;
	return (
		parts.length === 3 &&
		parts[0] === "worktrees" &&
		(parts[2] === "config.worktree" || parts[2] === "config.worktree.lock")
	);
}

/** Under `repo.git/objects` (`rest` is below `repo.git/`). */
export function gitObject(rest: string): boolean {
	return rest === "objects" || rest.startsWith("objects/");
}

/** A path under a code area's `repo.git/objects`. */
export function gitObjectPath(path: string): boolean {
	const place = gitPlace(path);
	return place.kind === "git" && gitObject(place.rest);
}

/** A git object a lock's publish carries (5b's `qorpera_folder_git_object`): a loose object (SHA-1 or SHA-256) or a
 * pack's own file. Anything else under `objects/` (`info/packs`, a commit-graph, a multi-pack index: `gitObjectIndex`)
 * is not one. */
export function gitPublishedObject(path: string): boolean {
	const place = gitPlace(path);
	return (
		place.kind === "git" &&
		/^objects\/([0-9a-f]{2}\/[0-9a-f]{38}([0-9a-f]{24})?|pack\/pack-[0-9a-f]{40}([0-9a-f]{24})?\.(pack|idx|rev|bitmap|mtimes|promisor))$/.test(
			place.rest,
		)
	);
}

/** The most units one change set takes (core §3), the folders the core makes for a git change's among them. */
export const GIT_UNITS = 1000;

/** The folders the core makes for a git change's unit at `path` (5b): each from the repo's own (`objects`, `refs`,
 * `logs`) down to the unit's. */
export function gitFolders(path: string): string[] {
	const parts = path.split("/");
	const folders: string[] = [];
	for (let n = 5; n < parts.length; n++) folders.push(parts.slice(0, n).join("/"));
	return folders;
}

/** Git's units in change sets the core takes, in order: at most `most` units each, the folders made for them among
 * them. */
export function gitBatches<T extends { readonly path: string }>(units: readonly T[], most = GIT_UNITS): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let folders = new Set<string>();
	for (const unit of units) {
		const own = gitFolders(unit.path);
		const added = own.filter((folder) => !folders.has(folder)).length;
		if (batch.length > 0 && batch.length + 1 + folders.size + added > most) {
			batches.push(batch);
			batch = [];
			folders = new Set();
		}
		batch.push(unit);
		for (const folder of own) folders.add(folder);
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/** A file that would make git read objects from elsewhere (`rest` is below `repo.git/`). */
export function gitAlternates(rest: string): boolean {
	const file = rest.endsWith(".lock") ? rest.slice(0, -".lock".length) : rest;
	return file === "objects/info/alternates" || file === "objects/info/http-alternates";
}

/** A file or folder a lease guards (`rest` is below `repo.git/`), with its lock: a ref (`refs/**`, and `refs`),
 * `packed-refs` (and `packed-refs.new`, which git renames onto it under its lock), `shallow`, and a ref's log
 * (`logs/refs/**`, and `logs/refs`). Sessions race on these. */
export function gitLeased(rest: string): boolean {
	const file = rest.endsWith(".lock") ? rest.slice(0, -".lock".length) : rest;
	return (
		file === "refs" ||
		file.startsWith("refs/") ||
		file === "packed-refs" ||
		file === "packed-refs.new" ||
		file === "shallow" ||
		file === "logs/refs" ||
		file.startsWith("logs/refs/")
	);
}

/** A shared file other sessions change (`rest` is below `repo.git/`): everything in the git directory but objects, the
 * workers' own files and the session-local ones. In the code host's view (`codeHost`) only what a lease guards: the
 * code host is the platform, which the core gives no git rule (5b, 446200), so it writes the rest (`HEAD`, the probe
 * files `git init` makes) as plain files, published at its boundary. */
export function gitShared(rest: string, codeHost = false): boolean {
	return (
		rest !== "" &&
		!gitObject(rest) &&
		rest !== "worktrees" &&
		!rest.startsWith("worktrees/") &&
		!gitSessionLocal(rest) &&
		(!codeHost || gitLeased(rest))
	);
}

/** A shared file or folder of a git directory, by its full path, in the code host's view (`codeHost`) or a session's:
 * only a lease publishes it, never a boundary. */
export function gitSharedPath(path: string, codeHost: boolean): boolean {
	const place = gitPlace(path);
	return place.kind === "git" && gitShared(place.rest, codeHost);
}

/** The shared file `X` a lock `path` (`X.lock`) stands for, where `X` is a ref (`refs/**`), `packed-refs` or
 * `shallow`: the lock's exclusive create takes the core's lease on `X`, its rename onto `X` publishes, and its removal
 * gives the lease back. The core leases nothing else (5b): `HEAD` is the platform's, so a session's lock on it is
 * refused here, and the code host writes it as a plain file (`gitShared`). */
export function gitLockTarget(path: string): string | null {
	const place = gitPlace(path);
	if (place.kind !== "git" || !place.rest.endsWith(".lock")) return null;
	const target = place.rest.slice(0, -".lock".length);
	const ok = target === "packed-refs" || target === "shallow" || target.startsWith("refs/");
	return ok ? `${place.area}/repo.git/${target}` : null;
}

/** The `packed-refs` whose `packed-refs.new` `path` is: `git pack-refs` writes it under `packed-refs.lock` and renames it
 * onto `packed-refs`, the publish (§6). */
export function gitPackedRefsTarget(path: string): string | null {
	const place = gitPlace(path);
	return place.kind === "git" && place.rest === "packed-refs.new" ? `${place.area}/repo.git/packed-refs` : null;
}

/** The git directory (`code/<owner>/<name>/repo.git`) the shared file `target` is in. */
export function gitDir(target: string): string {
	const place = gitPlace(target);
	if (place.kind !== "git") throw new Error(`${target} is not in a git directory`);
	return `${place.area}/repo.git`;
}

/** The files a lock on the shared file `target` guards: the file, its log, and the locks git writes them through
 * (`packed-refs` also through `packed-refs.new`, which `git pack-refs` renames onto it). */
export function gitGuarded(target: string): readonly string[] {
	const reflog = gitReflog(target);
	const files = [target, `${target}.lock`, reflog, `${reflog}.lock`];
	const place = gitPlace(target);
	return place.kind === "git" && place.rest === "packed-refs" ? [...files, `${target}.new`] : files;
}

/** The reflog of the shared file `target` (`code/<owner>/<name>/repo.git/X`). */
export function gitReflog(target: string): string {
	const place = gitPlace(target);
	if (place.kind !== "git") throw new Error(`${target} is not in a git directory`);
	return `${place.area}/repo.git/logs/${place.rest}`;
}

/** Whether a write to `path` is refused: an alternates file, and in a session's view a session-local git file (the
 * program keeps those on the machine's disk, so one reaching this service is a program that would publish its hooks).
 * The code host's view (`codeHost`) writes the published copies sessions seed theirs from: there they are plain files,
 * published at a boundary. */
export function gitRefused(path: string, codeHost = false): boolean {
	const place = gitPlace(path);
	return place.kind === "git" && ((!codeHost && gitSessionLocal(place.rest)) || gitAlternates(place.rest));
}

/** A file git makes in the git directory that a boundary never publishes: an object or pack it has not finished
 * (`tmp_*`, a push's `incoming-*` quarantine), a pack's `.keep`, and every lock (a shared file's goes with its lease,
 * a worker's own is git's until it renames it). A git killed midway leaves them; they stay this view's. So do git's
 * own indexes of the objects (`gitObjectIndex`). */
export function gitUnpublished(path: string): boolean {
	const place = gitPlace(path);
	if (place.kind !== "git") return false;
	const parts = place.rest.split("/");
	const name = parts[parts.length - 1];
	if (name.endsWith(".lock")) return true;
	if (!gitObject(place.rest)) return false;
	return (
		name.startsWith("tmp_") ||
		parts.some((part) => part.startsWith("incoming-")) ||
		(parts[1] === "pack" && name.endsWith(".keep")) ||
		gitObjectIndex(place.rest)
	);
}

/** An index git keeps of the objects, and makes again from them (`rest` is below `repo.git/`): `objects/info/packs`
 * (and the `packs_*` it is written as, by `git update-server-info`, which `git repack` and `git gc` run), a
 * commit-graph (`objects/info/commit-graph`, and the split one's `objects/info/commit-graphs/`), and a multi-pack index
 * (`objects/pack/multi-pack-index*`). The core takes none from a session (446200: `git_platform_only`), and one made in
 * another view lists what that view's git held, so each view keeps its own, the code host's too: none is published. */
function gitObjectIndex(rest: string): boolean {
	const parts = rest.split("/");
	if (parts[0] !== "objects" || parts.length < 3) return false;
	const name = parts[2];
	if (parts[1] === "info") return name === "packs" || name.startsWith("packs_") || name.startsWith("commit-graph");
	return parts[1] === "pack" && name.startsWith("multi-pack-index");
}
