/**
 * Userland management — the ratified fork model (spec §9a, 2026-08-04).
 *
 * The KERNEL (Electron main, preload bridge, authority, trail, updater) is
 * never forked and updates atomically. The USERLAND — the chrome the
 * company's app actually runs — is forked INTO the company folder
 * (`<company>/userland/`) on first open, where the controller may evolve it
 * freely: UI, behavior, features. Base updates never reset a fork:
 *
 *  - untouched fork (every file matches the fork-time hash manifest) →
 *    fast-forward to the new base silently;
 *  - evolved fork → the new base is STAGED at `userland/.update/` next to
 *    the pristine fork-time copy at `userland/.base/`, giving the
 *    controller classic 3-way merge materials (mine / base / theirs). The
 *    merge is a controller session, not kernel code.
 *
 * Pure filesystem logic — no Electron — so the semantics are unit-tested.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

function listFiles(dir: string, base = dir): string[] {
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
		if (name.isDirectory()) files.push(...listFiles(path, base));
		else files.push(relative(base, path).split(sep).join("/"));
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
		return JSON.parse(readFileSync(join(userlandDir, MANIFEST), "utf-8")) as UserlandManifest;
	} catch {
		return undefined;
	}
}

function writeManifest(userlandDir: string, manifest: UserlandManifest): void {
	writeFileSync(join(userlandDir, MANIFEST), `${JSON.stringify(manifest, null, "\t")}\n`, "utf-8");
}

function copyBase(baseDir: string, targetDir: string): void {
	mkdirSync(targetDir, { recursive: true });
	cpSync(baseDir, targetDir, { recursive: true });
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

/**
 * Snapshot the fork's current content into .versions/ if it changed since the
 * last snapshot (or since fork/fast-forward, whose state lives in .base
 * already). Returns the new version id, or undefined when nothing changed.
 */
export function snapshotIfChanged(userlandDir: string, label?: string): string | undefined {
	const manifest = readManifest(userlandDir);
	if (!manifest) return undefined;
	const hash = combinedHash(userlandDir);
	if (manifest.lastSnapshotHash === hash) return undefined;
	const id = new Date().toISOString().replace(/[:.]/g, "-") + (label ? `_${label}` : "");
	copyContent(userlandDir, join(userlandDir, VERSIONS_DIR, id));
	writeManifest(userlandDir, { ...manifest, lastSnapshotHash: hash });
	return id;
}

/** Saved versions, newest first (ids sort chronologically by construction). */
export function listVersions(userlandDir: string): UserlandVersion[] {
	const dir = join(userlandDir, VERSIONS_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const [stamp, ...rest] = entry.name.split("_");
			return { id: entry.name, savedAt: stamp, label: rest.join("_") || undefined };
		})
		.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Roll the fork's content back to a saved version. The current state is
 * snapshotted first, so a rollback is itself reversible. Manifest metadata
 * (baseVersion, staging) is untouched — this restores content only.
 */
export function restoreVersion(userlandDir: string, id: string): boolean {
	const snapshot = join(userlandDir, VERSIONS_DIR, id);
	if (!existsSync(snapshot) || !readManifest(userlandDir)) return false;
	snapshotIfChanged(userlandDir, "pre-restore");
	for (const file of listFiles(userlandDir)) {
		rmSync(join(userlandDir, file.split("/").join(sep)), { force: true });
	}
	copyContent(snapshot, userlandDir);
	const manifest = readManifest(userlandDir)!;
	writeManifest(userlandDir, { ...manifest, lastSnapshotHash: combinedHash(userlandDir) });
	return true;
}

export function getActiveApp(userlandDir: string): "fork" | "base" {
	return readManifest(userlandDir)?.activeApp === "base" ? "base" : "fork";
}

export function setActiveApp(userlandDir: string, app: "fork" | "base"): void {
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

	if (!existsSync(join(userlandDir, MANIFEST))) {
		// First open: fork the base into the company, keep a pristine copy.
		rmSync(userlandDir, { recursive: true, force: true });
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
	if (!manifest || manifest.baseVersion === baseVersion) {
		return { action: "current", baseVersion: manifest?.baseVersion ?? baseVersion };
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

	// Evolved fork: stage the update for a controller merge session.
	if (manifest.stagedVersion === baseVersion) {
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
		"Preserve your evolutions, adopt the update's improvements, and verify the app still works (the founder will reopen it). When done: replace userland/.base/ with a copy of the new base, delete userland/.update/, and update userland.json — set baseVersion to the new version, remove stagedVersion, and recompute nothing else (the files map only matters for fast-forward detection; set it to {} if unsure).",
	].join("\n\n");
}
