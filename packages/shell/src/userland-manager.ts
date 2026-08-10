/**
 * Userland management — the ratified fork model (spec §9a, 2026-08-04).
 *
 * The KERNEL (Electron main, preload bridge, authority, trail, updater) is
 * never forked and updates atomically. The USERLAND — the chrome the
 * company's app actually runs — is forked INTO the company folder
 * (`<company>/userland/`) on first open, where the controller may evolve it
 * freely: UI, behavior, features. Base updates never reset a fork, and
 * CONTENT decides what counts as an update — never the version label (a dev
 * tree rebuilds under an unchanged productVersion; a release can bump the
 * label without touching the userland):
 *
 *  - untouched fork (every file matches the fork-time hash manifest) →
 *    fast-forward to the new base silently;
 *  - evolved fork → the new base is STAGED at `userland/.update/` next to
 *    the pristine fork-time copy at `userland/.base/`, giving the
 *    controller classic 3-way merge materials (mine / base / theirs). The
 *    merge is a controller session, not kernel code.
 *
 * Pure filesystem logic — no Electron — so the semantics are unit-tested.
 *
 * INVARIANT (founder-ratified 2026-08-05): the Base never conflicts with the
 * company file. Everything this module reads or writes lives under
 * `<company>/userland/` — the fork, the pristine copy, staged updates,
 * saved versions, the manifest. The rest of the company folder (company.md,
 * app/, trail/, inbox/, departments/) is invisible to fork/merge/version machinery.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	cpSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface UserlandManifest {
	baseVersion: string;
	forkedAt: string;
	/** sha256 per file, relative forward-slash paths, at fork/fast-forward time. */
	files: Record<string, string>;
	/** Present when a newer base is staged in .update awaiting a merge. */
	stagedVersion?: string;
	/** Which app to boot for this company: the fork (default) or the pristine base. */
	activeApp?: "fork" | "base";
	/** Combined content hash at the time of the last snapshot — dedupes auto-snapshots. */
	lastSnapshotHash?: string;
}

export interface UserlandVersion {
	id: string;
	savedAt: string;
	label?: string;
	/** Base version the fork was built on when this snapshot was taken. */
	baseVersion?: string;
	/** Monotonic version number (v1, v2, …); derived chronologically for legacy snapshots. */
	seq: number;
	/** What changed since the previous snapshot, generated at capture time. */
	description?: string;
	favorite?: boolean;
	/** Stamped when this version is restored. */
	lastUsedAt?: string;
}

export interface UserlandVersionReview {
	version: UserlandVersion;
	contentHash: string;
	baseHash?: string;
}

export interface UserlandStatus {
	action: "forked" | "current" | "fast-forwarded" | "staged" | "already-staged";
	baseVersion: string;
	stagedVersion?: string;
}

const MANIFEST = "userland.json";
const PRISTINE_DIR = ".base";
const UPDATE_DIR = ".update";
const VERSIONS_DIR = ".versions";

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertPhysicalEntry(path: string, kind?: "file" | "directory"): void {
	const entry = lstatSync(path);
	if (
		entry.isSymbolicLink() ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path) ||
		(kind === "file" && (!entry.isFile() || entry.nlink !== 1)) ||
		(kind === "directory" && !entry.isDirectory())
	) {
		throw new Error(`Userland storage must be one physical ${kind ?? "entry"}: ${path}`);
	}
}

function assertPhysicalTree(path: string): void {
	const entry = lstatSync(path);
	assertPhysicalEntry(path, entry.isDirectory() ? "directory" : "file");
	if (!entry.isDirectory()) return;
	for (const entry of readdirSync(path)) assertPhysicalTree(join(path, entry));
}

export function assertUserlandStorage(userlandDir: string): void {
	if (existsSync(userlandDir)) assertPhysicalTree(userlandDir);
}

function writeAtomicFile(path: string, content: string): void {
	assertPhysicalEntry(resolve(path, ".."), "directory");
	if (existsSync(path)) assertPhysicalEntry(path, "file");
	const temporary = `${path}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx");
		writeFileSync(descriptor, content, "utf-8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
		throw error;
	}
}

function listFiles(dir: string, base = dir): string[] {
	assertPhysicalEntry(dir, "directory");
	const files: string[] = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		if (
			name.name === MANIFEST ||
			name.name === PRISTINE_DIR ||
			name.name === UPDATE_DIR ||
			name.name === VERSIONS_DIR
		)
			continue;
		const path = join(dir, name.name);
		assertPhysicalEntry(path);
		if (lstatSync(path).isDirectory()) files.push(...listFiles(path, base));
		else {
			assertPhysicalEntry(path, "file");
			files.push(relative(base, path).split(sep).join("/"));
		}
	}
	return files.sort();
}

function hashFiles(dir: string): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const file of listFiles(dir)) {
		hashes[file] = createHash("sha256")
			.update(readFileSync(join(dir, file.split("/").join(sep))))
			.digest("hex");
	}
	return hashes;
}

function readManifest(userlandDir: string): UserlandManifest | undefined {
	try {
		const path = join(userlandDir, MANIFEST);
		assertPhysicalEntry(path, "file");
		return JSON.parse(readFileSync(path, "utf-8")) as UserlandManifest;
	} catch {
		return undefined;
	}
}

function writeManifest(userlandDir: string, manifest: UserlandManifest): void {
	writeAtomicFile(join(userlandDir, MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`);
}

function copyBase(baseDir: string, targetDir: string): void {
	assertPhysicalTree(baseDir);
	if (existsSync(targetDir)) assertPhysicalTree(targetDir);
	mkdirSync(targetDir, { recursive: true });
	cpSync(baseDir, targetDir, { recursive: true });
	assertPhysicalTree(targetDir);
}

function combinedHash(dir: string): string {
	return createHash("sha256")
		.update(JSON.stringify(hashFiles(dir)))
		.digest("hex");
}

function copyContent(fromDir: string, toDir: string): void {
	mkdirSync(toDir, { recursive: true });
	for (const file of listFiles(fromDir)) {
		const target = join(toDir, file.split("/").join(sep));
		mkdirSync(join(target, ".."), { recursive: true });
		cpSync(join(fromDir, file.split("/").join(sep)), target);
	}
}

function sameContent(dirA: string, dirB: string): boolean {
	return JSON.stringify(hashFiles(dirA)) === JSON.stringify(hashFiles(dirB));
}

interface VersionMeta {
	label?: string;
	baseVersion?: string;
	seq?: number;
	description?: string;
	favorite?: boolean;
	lastUsedAt?: string;
}

function readVersionMeta(versionDir: string): VersionMeta | undefined {
	try {
		const path = join(versionDir, "meta.json");
		assertPhysicalEntry(path, "file");
		return JSON.parse(readFileSync(path, "utf-8")) as VersionMeta;
	} catch {
		return undefined;
	}
}

/**
 * Merge fields into a snapshot's meta.json. Legacy snapshots are bare content
 * dirs — writing meta.json there would leak it into the app on restore, so
 * they are left alone (returns false).
 */
function updateVersionMeta(userlandDir: string, id: string, patch: Partial<VersionMeta>): boolean {
	const versionDir = join(userlandDir, VERSIONS_DIR, id);
	if (!existsSync(join(versionDir, "content"))) return false;
	const meta = { ...readVersionMeta(versionDir), ...patch };
	writeAtomicFile(join(versionDir, "meta.json"), `${JSON.stringify(meta, null, "\t")}\n`);
	return true;
}

/** "changed renderer.js, index.html; added widgets.js" — capped per category. */
function describeDelta(current: Record<string, string>, previous: Record<string, string>): string | undefined {
	const changed: string[] = [];
	const added: string[] = [];
	for (const [file, hash] of Object.entries(current)) {
		if (!(file in previous)) added.push(file);
		else if (previous[file] !== hash) changed.push(file);
	}
	const removed = Object.keys(previous).filter((file) => !(file in current));
	const list = (names: string[]) =>
		names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3} more` : names.join(", ");
	const parts: string[] = [];
	if (changed.length) parts.push(`changed ${list(changed)}`);
	if (added.length) parts.push(`added ${list(added)}`);
	if (removed.length) parts.push(`removed ${list(removed)}`);
	return parts.length ? parts.join("; ") : undefined;
}

/**
 * Snapshot the fork's current content into .versions/ if it changed since the
 * last snapshot (or since fork/fast-forward, whose state lives in .base
 * already). Returns the new version id, or undefined when nothing changed.
 *
 * A snapshot carries its own merge materials: `<id>/content/` is the fork,
 * `<id>/base/` the pristine base it was built on, `meta.json` the base
 * version — so restoring an old version restores ITS 3-way reference instead
 * of inheriting whatever newer .base the live fork moved to.
 */
export function snapshotIfChanged(userlandDir: string, label?: string): string | undefined {
	assertUserlandStorage(userlandDir);
	const manifest = readManifest(userlandDir);
	if (!manifest) return undefined;
	const hash = combinedHash(userlandDir);
	if (manifest.lastSnapshotHash === hash) return undefined;

	// Version number and delta description come from the previous snapshot
	// (or from the pristine base for the very first one).
	const existing = listVersions(userlandDir);
	const seq = existing.reduce((max, v) => Math.max(max, v.seq), 0) + 1;
	const latest = existing[0];
	const previousDir = latest
		? existsSync(join(userlandDir, VERSIONS_DIR, latest.id, "content"))
			? join(userlandDir, VERSIONS_DIR, latest.id, "content")
			: join(userlandDir, VERSIONS_DIR, latest.id)
		: existsSync(join(userlandDir, PRISTINE_DIR))
			? join(userlandDir, PRISTINE_DIR)
			: undefined;
	const description = previousDir
		? (describeDelta(hashFiles(userlandDir), hashFiles(previousDir)) ?? "same content as the previous version")
		: "first capture of the evolved app";

	const id = new Date().toISOString().replace(/[:.]/g, "-") + (label ? `_${label}` : "");
	const versionDir = join(userlandDir, VERSIONS_DIR, id);
	copyContent(userlandDir, join(versionDir, "content"));
	if (existsSync(join(userlandDir, PRISTINE_DIR))) {
		copyBase(join(userlandDir, PRISTINE_DIR), join(versionDir, "base"));
	}
	const meta: VersionMeta = { label, baseVersion: manifest.baseVersion, seq, description };
	writeAtomicFile(join(versionDir, "meta.json"), `${JSON.stringify(meta, null, "\t")}\n`);
	writeManifest(userlandDir, { ...manifest, lastSnapshotHash: hash });
	return id;
}

/** Saved versions, newest first (ids sort chronologically by construction). */
export function listVersions(userlandDir: string): UserlandVersion[] {
	assertUserlandStorage(userlandDir);
	const dir = join(userlandDir, VERSIONS_DIR);
	if (!existsSync(dir)) return [];
	const entries = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const meta = readVersionMeta(join(dir, entry.name));
			const [stamp, ...rest] = entry.name.split("_");
			return {
				id: entry.name,
				savedAt: stamp,
				label: meta?.label ?? (rest.join("_") || undefined),
				baseVersion: meta?.baseVersion,
				seq: meta?.seq,
				description: meta?.description,
				favorite: meta?.favorite,
				lastUsedAt: meta?.lastUsedAt,
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	// Legacy snapshots predate stored numbers — fill them in chronologically,
	// keeping later stored seqs (computed as max+1 at capture) consistent.
	let max = 0;
	const numbered: UserlandVersion[] = entries.map((entry) => {
		const seq = entry.seq ?? max + 1;
		max = Math.max(max, seq);
		return { ...entry, seq };
	});
	return numbered.sort((a, b) => b.id.localeCompare(a.id));
}

/** Immutable founder-review description of one restorable snapshot. */
export function reviewVersion(userlandDir: string, id: string): UserlandVersionReview | undefined {
	const version = listVersions(userlandDir).find((entry) => entry.id === id);
	if (!version) return undefined;
	const snapshot = join(userlandDir, VERSIONS_DIR, id);
	const contentDir = existsSync(join(snapshot, "content")) ? join(snapshot, "content") : snapshot;
	const baseDir = join(snapshot, "base");
	return {
		version,
		contentHash: combinedHash(contentDir),
		...(existsSync(baseDir) ? { baseHash: combinedHash(baseDir) } : {}),
	};
}

/** Mark or unmark a saved version as a favorite. */
export function setVersionFavorite(userlandDir: string, id: string, favorite: boolean): boolean {
	if (!existsSync(join(userlandDir, VERSIONS_DIR, id))) return false;
	return updateVersionMeta(userlandDir, id, { favorite });
}

/**
 * Roll the fork back to a saved version. The current state is snapshotted
 * first, so a rollback is itself reversible. The snapshot's own pristine
 * base (when recorded) comes back with it, and when `currentBase` is given
 * the restored fork immediately rejoins the present: already-current →
 * staging cleared; behind (or ahead) → the current base is staged for a
 * controller merge, exactly like an update arriving. Returns the resulting
 * status, or undefined for an unknown id.
 */
export function restoreVersion(
	userlandDir: string,
	id: string,
	currentBase?: { dir: string; version: string },
): UserlandStatus | undefined {
	assertUserlandStorage(userlandDir);
	const snapshot = join(userlandDir, VERSIONS_DIR, id);
	if (!existsSync(snapshot) || !readManifest(userlandDir)) return undefined;
	snapshotIfChanged(userlandDir, "pre-restore");
	updateVersionMeta(userlandDir, id, { lastUsedAt: new Date().toISOString() });

	// Old snapshots are bare content dirs; new ones nest content/ + base/ + meta.
	const contentDir = existsSync(join(snapshot, "content")) ? join(snapshot, "content") : snapshot;
	for (const file of listFiles(userlandDir)) {
		rmSync(join(userlandDir, file.split("/").join(sep)), { force: true });
	}
	copyContent(contentDir, userlandDir);
	if (existsSync(join(snapshot, "base"))) {
		rmSync(join(userlandDir, PRISTINE_DIR), { recursive: true, force: true });
		copyBase(join(snapshot, "base"), join(userlandDir, PRISTINE_DIR));
	}

	const meta = readVersionMeta(snapshot);
	const manifest = readManifest(userlandDir)!;
	const baseVersion = meta?.baseVersion ?? manifest.baseVersion;
	const next: UserlandManifest = { ...manifest, baseVersion, lastSnapshotHash: combinedHash(userlandDir) };

	if (!currentBase) {
		writeManifest(userlandDir, next);
		return { action: "current", baseVersion };
	}

	const pristine = join(userlandDir, PRISTINE_DIR);
	rmSync(join(userlandDir, UPDATE_DIR), { recursive: true, force: true });
	if (baseVersion === currentBase.version || (existsSync(pristine) && sameContent(pristine, currentBase.dir))) {
		writeManifest(userlandDir, { ...next, baseVersion: currentBase.version, stagedVersion: undefined });
		return { action: "current", baseVersion: currentBase.version };
	}
	copyBase(currentBase.dir, join(userlandDir, UPDATE_DIR));
	writeManifest(userlandDir, { ...next, stagedVersion: currentBase.version });
	return { action: "staged", baseVersion, stagedVersion: currentBase.version };
}

export function getActiveApp(userlandDir: string): "fork" | "base" {
	return readManifest(userlandDir)?.activeApp === "base" ? "base" : "fork";
}

export function setActiveApp(userlandDir: string, app: "fork" | "base"): void {
	assertUserlandStorage(userlandDir);
	const manifest = readManifest(userlandDir);
	if (manifest) writeManifest(userlandDir, { ...manifest, activeApp: app });
}

/** Is the fork byte-identical to its fork-time base? */
export function isUnmodified(userlandDir: string): boolean {
	const manifest = readManifest(userlandDir);
	if (!manifest) return false;
	const current = hashFiles(userlandDir);
	const recorded = manifest.files;
	const currentKeys = Object.keys(current);
	const recordedKeys = Object.keys(recorded);
	if (currentKeys.length !== recordedKeys.length) return false;
	return currentKeys.every((key) => current[key] === recorded[key]);
}

/**
 * Ensure the company has a userland fork, current or staged against the
 * given base. Returns what happened; never destroys an evolved fork.
 */
export function ensureUserland(companyRoot: string, baseDir: string, baseVersion: string): UserlandStatus {
	const userlandDir = join(companyRoot, "userland");
	assertUserlandStorage(userlandDir);

	if (!existsSync(join(userlandDir, MANIFEST))) {
		if (existsSync(userlandDir) && readdirSync(userlandDir).length > 0) {
			throw new Error(
				"Cannot initialize userland: existing content has no userland.json metadata; content was preserved for audit",
			);
		}
		// First open: fork the base into the company, keep a pristine copy.
		copyBase(baseDir, userlandDir);
		copyBase(baseDir, join(userlandDir, PRISTINE_DIR));
		const files = hashFiles(userlandDir);
		writeManifest(userlandDir, {
			baseVersion,
			forkedAt: new Date().toISOString(),
			files,
			lastSnapshotHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
		});
		return { action: "forked", baseVersion };
	}

	const manifest = readManifest(userlandDir);
	if (!manifest) {
		throw new Error("Cannot open userland: userland.json is invalid; content was preserved for audit");
	}

	// CONTENT decides, never the version label (founder direction 2026-08-06:
	// product changes must reflect in the controller — a dev tree rebuilds
	// base content under an unchanged productVersion, and a packaged release
	// can bump the label without touching the userland). manifest.files is
	// the base's content at fork/fast-forward time.
	if (JSON.stringify(hashFiles(baseDir)) === JSON.stringify(manifest.files)) {
		if (manifest.baseVersion !== baseVersion) {
			// Label-only movement: relabel and clear any staging a prior open
			// created for this phantom delta.
			rmSync(join(userlandDir, UPDATE_DIR), { recursive: true, force: true });
			writeManifest(userlandDir, { ...manifest, baseVersion, stagedVersion: undefined });
		}
		return { action: "current", baseVersion };
	}

	if (isUnmodified(userlandDir)) {
		// Untouched fork: fast-forward silently.
		for (const file of Object.keys(manifest.files)) {
			rmSync(join(userlandDir, file.split("/").join(sep)), { force: true });
		}
		copyBase(baseDir, userlandDir);
		rmSync(join(userlandDir, PRISTINE_DIR), { recursive: true, force: true });
		rmSync(join(userlandDir, UPDATE_DIR), { recursive: true, force: true });
		copyBase(baseDir, join(userlandDir, PRISTINE_DIR));
		const files = hashFiles(userlandDir);
		writeManifest(userlandDir, {
			baseVersion,
			forkedAt: new Date().toISOString(),
			files,
			activeApp: manifest.activeApp,
			lastSnapshotHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
		});
		return { action: "fast-forwarded", baseVersion };
	}

	// A finished merge must read back as "current", never as a new stage.
	// Two completion signals, either sufficient:
	//  - the pristine copy already matches the current base (the controller
	//    replaced .base under the old merge instructions), or
	//  - this exact stage's .update is gone (deleting it IS the controller's
	//    "done" signal under the current instructions; label-gated so a newer
	//    base arriving after the merge still stages normally).
	// The kernel heals the bookkeeping itself — manifest upkeep used to be
	// the merge session's job, and a merge that wrote `files: {}` re-staged
	// the same update forever.
	const pristineDir = join(userlandDir, PRISTINE_DIR);
	const updateDir = join(userlandDir, UPDATE_DIR);
	const merged =
		(existsSync(pristineDir) && sameContent(pristineDir, baseDir)) ||
		(manifest.stagedVersion === baseVersion && !existsSync(updateDir));
	if (merged) {
		rmSync(updateDir, { recursive: true, force: true });
		rmSync(pristineDir, { recursive: true, force: true });
		copyBase(baseDir, pristineDir);
		writeManifest(userlandDir, {
			...manifest,
			baseVersion,
			stagedVersion: undefined,
			files: hashFiles(baseDir),
		});
		return { action: "current", baseVersion };
	}

	// Evolved fork: stage the update for a controller merge session. Staging
	// is current only if the staged CONTENT still matches the base — a dev
	// tree can rebuild the base again while an earlier stage waits.
	if (
		manifest.stagedVersion === baseVersion &&
		existsSync(join(userlandDir, UPDATE_DIR)) &&
		sameContent(join(userlandDir, UPDATE_DIR), baseDir)
	) {
		return { action: "already-staged", baseVersion: manifest.baseVersion, stagedVersion: baseVersion };
	}
	rmSync(join(userlandDir, UPDATE_DIR), { recursive: true, force: true });
	copyBase(baseDir, join(userlandDir, UPDATE_DIR));
	writeManifest(userlandDir, { ...manifest, stagedVersion: baseVersion });
	return { action: "staged", baseVersion: manifest.baseVersion, stagedVersion: baseVersion };
}

/** The prompt that turns a staged update into a controller merge session. */
export function mergeTaskPrompt(status: UserlandStatus): string {
	return [
		`A Qorpera Base userland update is staged: your app's fork is based on v${status.baseVersion}, and v${status.stagedVersion} is waiting in userland/.update/.`,
		`Merge it: userland/ is your evolved app, userland/.base/ is the pristine v${status.baseVersion} you forked from, userland/.update/ is the new base — a classic 3-way merge (yours / base / theirs).`,
		"Preserve your evolutions, adopt the update's improvements, and verify the app still works (the founder will reopen it). When done, delete userland/.update/ — deleting it is the completion signal. Touch nothing else: the kernel refreshes userland/.base/ and userland.json itself once the update folder is gone.",
		"Cleanup note: recursive deletes (`rm -r`) trip the irreversibility gates and stall on the founder. Delete with your write/delete tools or plain per-file `rm` of listed files instead — past merges that used `rm -r` left stale gate requests the founder then had to deny.",
	].join("\n\n");
}
