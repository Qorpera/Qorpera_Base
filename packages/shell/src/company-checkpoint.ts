import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CompanyGitBaseline {
	dirtyPaths: Map<string, string>;
}

export interface CompanyCheckpointResult {
	baseline: CompanyGitBaseline;
	success: boolean;
}

interface PendingCompanyCheckpoint {
	version: 2;
	root: string;
	trailFile: string;
	dirtyPaths: Array<{ path: string; hash: string }>;
}

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false });
}

function pathIdentity(root: string, path: string, status: string): string {
	const working = git(root, ["hash-object", "--no-filters", "--", path]);
	const index = git(root, ["rev-parse", `:${path}`]);
	const workingHash = working.status === 0 && typeof working.stdout === "string" ? working.stdout.trim() : "missing";
	const indexHash = index.status === 0 && typeof index.stdout === "string" ? index.stdout.trim() : "missing";
	return `${status}:${indexHash}:${workingHash}`;
}

function dirtyPaths(root: string): Map<string, string> {
	const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (result.status !== 0 || typeof result.stdout !== "string") {
		throw new Error(`company checkpoint status failed: ${result.stderr || result.stdout || "git status failed"}`);
	}
	const records = result.stdout.split("\0");
	const paths = new Map<string, string>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length < 4) continue;
		const path = record.slice(3);
		paths.set(path, pathIdentity(root, path, record.slice(0, 2)));
		if (record[0] === "R" || record[1] === "R" || record[0] === "C" || record[1] === "C") index++;
	}
	return paths;
}

export function captureCompanyGitBaseline(root: string): CompanyGitBaseline {
	return { dirtyPaths: dirtyPaths(root) };
}

export function commitCompanyMaterialization(root: string, paths: string[]): void {
	const existingPaths = paths.filter((path) => existsSync(join(root, path)));
	if (existingPaths.length === 0) return;
	const staged = git(root, ["add", "--", ...existingPaths]);
	if (staged.status !== 0) {
		throw new Error(`company materialization staging failed: ${staged.stderr || staged.stdout || "git add failed"}`);
	}
	const changed = git(root, ["diff", "--cached", "--quiet", "--", ...existingPaths]);
	if (changed.status === 0) return;
	if (changed.status !== 1) throw new Error("could not inspect the company materialization snapshot");
	const committed = git(root, [
		"-c",
		"user.name=Qorpera Kernel",
		"-c",
		"user.email=kernel@qorpera.local",
		"commit",
		"--only",
		"-m",
		"docs: materialize company runtime\n\nQorpera-Trigger: desktop kernel open\nQorpera-Rationale: preserve kernel scaffolding, migrations, and evolved userland before controller execution",
		"--",
		...existingPaths,
	]);
	if (committed.status !== 0) {
		git(root, ["restore", "--staged", "--", ...existingPaths]);
		throw new Error(
			`company materialization commit failed: ${committed.stderr || committed.stdout || "git commit failed"}`,
		);
	}
}

export function checkpointCompanyGit(
	root: string,
	baseline: CompanyGitBaseline,
	trailFile: string,
): CompanyCheckpointResult {
	let current: Map<string, string>;
	try {
		current = dirtyPaths(root);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return { baseline, success: false };
	}
	const trailPath = `trail/${trailFile}`;
	const sessionPaths = [...current.keys()].filter(
		(path) => baseline.dirtyPaths.get(path) !== current.get(path) || path.replace(/\\/g, "/") === trailPath,
	);
	if (sessionPaths.length === 0) return { baseline: { dirtyPaths: current }, success: true };
	const staged = git(root, ["add", "--", ...sessionPaths]);
	if (staged.status !== 0) {
		console.error(`company checkpoint staging failed: ${staged.stderr || staged.stdout || "git add failed"}`);
		return { baseline, success: false };
	}
	const committed = git(root, [
		"-c",
		"user.name=Qorpera Controller",
		"-c",
		"user.email=controller@qorpera.local",
		"commit",
		"--only",
		"-m",
		`docs: checkpoint controller session\n\nQorpera-Trigger: trail/${trailFile}\nQorpera-Rationale: preserve the settled controller change set`,
		"--",
		...sessionPaths,
	]);
	if (committed.status !== 0) {
		git(root, ["restore", "--staged", "--", ...sessionPaths]);
		console.error(`company checkpoint commit failed: ${committed.stderr || committed.stdout || "git commit failed"}`);
		return { baseline, success: false };
	}
	return { baseline: captureCompanyGitBaseline(root), success: true };
}

export function savePendingCompanyCheckpoint(
	path: string,
	root: string,
	baseline: CompanyGitBaseline,
	trailFile: string,
): void {
	const record: PendingCompanyCheckpoint = {
		version: 2,
		root: resolve(root),
		trailFile,
		dirtyPaths: [...baseline.dirtyPaths].map(([path, hash]) => ({ path, hash })),
	};
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(record, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, path);
}

export function finishPendingCompanyCheckpoint(path: string, result: CompanyCheckpointResult): void {
	if (result.success) rmSync(path, { force: true });
}

export function reconcilePendingCompanyCheckpoints(dir: string, root: string): void {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		try {
			const record = JSON.parse(readFileSync(path, "utf-8")) as Partial<PendingCompanyCheckpoint>;
			if (
				record.version !== 2 ||
				resolve(record.root ?? "") !== resolve(root) ||
				typeof record.trailFile !== "string" ||
				!Array.isArray(record.dirtyPaths) ||
				!record.dirtyPaths.every(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { path?: unknown }).path === "string" &&
						typeof (entry as { hash?: unknown }).hash === "string",
				)
			) {
				throw new Error("invalid pending checkpoint record");
			}
			const result = checkpointCompanyGit(
				root,
				{ dirtyPaths: new Map(record.dirtyPaths.map((entry) => [entry.path, entry.hash])) },
				record.trailFile,
			);
			if (result.success) rmSync(path, { force: true });
			else savePendingCompanyCheckpoint(path, root, result.baseline, record.trailFile);
		} catch (error) {
			throw new Error(
				`Could not reconcile pending company checkpoint ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
