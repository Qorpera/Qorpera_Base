import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CompanyGitBaseline {
	dirtyPaths: Set<string>;
}

export interface CompanyCheckpointResult {
	baseline: CompanyGitBaseline;
	success: boolean;
}

interface PendingCompanyCheckpoint {
	version: 1;
	root: string;
	trailFile: string;
	dirtyPaths: string[];
}

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false });
}

function dirtyPaths(root: string): Set<string> {
	const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (result.status !== 0 || typeof result.stdout !== "string") {
		throw new Error(`company checkpoint status failed: ${result.stderr || result.stdout || "git status failed"}`);
	}
	const records = result.stdout.split("\0");
	const paths = new Set<string>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length < 4) continue;
		paths.add(record.slice(3));
		if (record[0] === "R" || record[1] === "R" || record[0] === "C" || record[1] === "C") index++;
	}
	return paths;
}

export function captureCompanyGitBaseline(root: string): CompanyGitBaseline {
	return { dirtyPaths: dirtyPaths(root) };
}

export function checkpointCompanyGit(
	root: string,
	baseline: CompanyGitBaseline,
	trailFile: string,
): CompanyCheckpointResult {
	let current: Set<string>;
	try {
		current = dirtyPaths(root);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return { baseline, success: false };
	}
	const trailPath = `trail/${trailFile}`;
	const sessionPaths = [...current].filter(
		(path) => !baseline.dirtyPaths.has(path) || path.replace(/\\/g, "/") === trailPath,
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
		version: 1,
		root: resolve(root),
		trailFile,
		dirtyPaths: [...baseline.dirtyPaths],
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
				record.version !== 1 ||
				resolve(record.root ?? "") !== resolve(root) ||
				typeof record.trailFile !== "string" ||
				!Array.isArray(record.dirtyPaths) ||
				!record.dirtyPaths.every((entry) => typeof entry === "string")
			) {
				throw new Error("invalid pending checkpoint record");
			}
			const result = checkpointCompanyGit(root, { dirtyPaths: new Set(record.dirtyPaths) }, record.trailFile);
			if (result.success) rmSync(path, { force: true });
			else savePendingCompanyCheckpoint(path, root, result.baseline, record.trailFile);
		} catch (error) {
			throw new Error(
				`Could not reconcile pending company checkpoint ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
