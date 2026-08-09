import { spawnSync } from "node:child_process";

export interface CompanyGitBaseline {
	dirtyPaths: Set<string>;
}

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false });
}

function dirtyPaths(root: string): Set<string> {
	const result = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (result.status !== 0 || typeof result.stdout !== "string") return new Set();
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
): CompanyGitBaseline {
	const current = dirtyPaths(root);
	const sessionPaths = [...current].filter((path) => !baseline.dirtyPaths.has(path));
	if (sessionPaths.length === 0) return { dirtyPaths: current };
	const staged = git(root, ["add", "--", ...sessionPaths]);
	if (staged.status !== 0) {
		console.error(`company checkpoint staging failed: ${staged.stderr || staged.stdout || "git add failed"}`);
		return baseline;
	}
	const committed = git(root, [
		"-c",
		"user.name=Qorpera Controller",
		"-c",
		"user.email=controller@qorpera.local",
		"commit",
		"-m",
		`docs: checkpoint controller session\n\nQorpera-Trigger: trail/${trailFile}\nQorpera-Rationale: preserve the settled controller change set`,
	]);
	if (committed.status !== 0) {
		console.error(`company checkpoint commit failed: ${committed.stderr || committed.stdout || "git commit failed"}`);
		return baseline;
	}
	return captureCompanyGitBaseline(root);
}
