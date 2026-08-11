import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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

interface PendingProductCheckpoint {
	version: 2;
	companyRoot: string;
	worktreeRoot: string;
	companyTrailFile: string;
	dirtyPaths: Array<{ path: string; hash: string }>;
}

interface ProductWorktreeAssignment {
	version: 3;
	path: string;
	branch: string;
	departmentId: string;
	repositoryPath: string;
	sourceRemote: string;
	sourceHead?: string;
	recoveryHead?: string;
	recoveryBundles: ProductRecoveryBundle[];
	recoveryUpdatedAt?: string;
	sourceHistory: Array<{ sourceRemote: string; reboundAt: string }>;
	createdAt: string;
}

interface ProductRecoveryBundle {
	path: string;
	head: string;
	baseHead?: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
	const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toUpperCase().startsWith("GIT_")) delete env[key];
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = nullDevice;
	env.GIT_ATTR_NOSYSTEM = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

function localGitConfig(root: string, scope: "--local" | "--worktree", env: NodeJS.ProcessEnv): string[] {
	const result = spawnSync("git", ["-C", root, "config", scope, "--no-includes", "--null", "--list"], {
		encoding: "utf-8",
		shell: false,
		windowsHide: true,
		env,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		throw new Error(`could not inspect ${scope.slice(2)} Git config without includes`);
	}
	return result.stdout
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.split(/\r?\n/, 1)[0].toLowerCase());
}

function assertNoExternalLocalGitConfig(root: string, env: NodeJS.ProcessEnv): void {
	const local = localGitConfig(root, "--local", env);
	const keys = local.includes("extensions.worktreeconfig")
		? [...local, ...localGitConfig(root, "--worktree", env)]
		: local;
	const unsafe = keys.find(
		(key) => key.startsWith("include.") || key.startsWith("includeif.") || key.startsWith("filter."),
	);
	if (unsafe) {
		throw new Error(`repository-local Git execution config is not permitted in kernel checkpoints: ${unsafe}`);
	}
}

function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
	const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
	const env = gitEnvironment();
	assertNoExternalLocalGitConfig(root, env);
	return spawnSync(
		"git",
		[
			"--no-optional-locks",
			"-c",
			`core.hooksPath=${nullDevice}`,
			"-c",
			"core.fsmonitor=false",
			"-c",
			`core.attributesFile=${nullDevice}`,
			"-c",
			"credential.helper=",
			"-c",
			"commit.gpgSign=false",
			"-C",
			root,
			...args,
		],
		{ encoding: "utf-8", shell: false, windowsHide: true, env },
	);
}

function commitSnapshot(root: string, message: string): void {
	const committed = git(root, [
		"-c",
		"user.name=Qorpera Founder Snapshot",
		"-c",
		"user.email=founder-snapshot@qorpera.local",
		"commit",
		"-m",
		message,
	]);
	if (committed.status !== 0) {
		throw new Error(`founder state snapshot failed: ${committed.stderr || committed.stdout || "git commit failed"}`);
	}
}

/**
 * Preserve every pre-controller Git state before granting company-folder
 * write access. A staged version is committed first so a different working
 * version becomes a second recoverable snapshot instead of replacing it.
 */
export function snapshotFounderGitState(root: string, actor = "controller"): void {
	const staged = git(root, ["diff", "--cached", "--quiet"]);
	if (staged.status === 1) {
		commitSnapshot(
			root,
			`docs: preserve founder staged state\n\nQorpera-Trigger: ${actor} startup\nQorpera-Rationale: retain the founder index before any agent write can overlap it`,
		);
	} else if (staged.status !== 0) {
		throw new Error("could not inspect staged founder state");
	}
	const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.status !== 0 || typeof status.stdout !== "string") {
		throw new Error(
			`could not inspect founder working state: ${status.stderr || status.stdout || "git status failed"}`,
		);
	}
	if (!status.stdout.trim()) return;
	const added = git(root, ["add", "--all"]);
	if (added.status !== 0) {
		throw new Error(`could not stage founder working state: ${added.stderr || added.stdout || "git add failed"}`);
	}
	commitSnapshot(
		root,
		`docs: preserve founder working state\n\nQorpera-Trigger: ${actor} startup\nQorpera-Rationale: retain tracked, untracked, and deleted founder data before agent execution`,
	);
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
	// A path must exist on disk — or be a tracked file a kernel migration
	// just deleted, so the deletion lands in this commit, not a later turn's.
	const existingPaths = paths.filter(
		(path) => existsSync(join(root, path)) || git(root, ["ls-files", "--error-unmatch", "--", path]).status === 0,
	);
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

function checkpointGit(
	root: string,
	baseline: CompanyGitBaseline,
	options: { forcedPath?: string; name: string; email: string; title: string; trigger: string; rationale: string },
): CompanyCheckpointResult {
	let current: Map<string, string>;
	try {
		current = dirtyPaths(root);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return { baseline, success: false };
	}
	const sessionPaths = [...new Set([...current.keys(), ...baseline.dirtyPaths.keys()])].filter(
		(path) =>
			baseline.dirtyPaths.get(path) !== current.get(path) ||
			(options.forcedPath !== undefined && path.replace(/\\/g, "/") === options.forcedPath.replace(/\\/g, "/")),
	);
	if (sessionPaths.length === 0) return { baseline: { dirtyPaths: current }, success: true };
	const staged = git(root, ["add", "--", ...sessionPaths]);
	if (staged.status !== 0) {
		console.error(`company checkpoint staging failed: ${staged.stderr || staged.stdout || "git add failed"}`);
		return { baseline, success: false };
	}
	const committed = git(root, [
		"-c",
		`user.name=${options.name}`,
		"-c",
		`user.email=${options.email}`,
		"commit",
		"--only",
		"-m",
		`${options.title}\n\nQorpera-Trigger: ${options.trigger}\nQorpera-Rationale: ${options.rationale}`,
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

export function checkpointCompanyGit(
	root: string,
	baseline: CompanyGitBaseline,
	trailFile: string,
): CompanyCheckpointResult {
	return checkpointGit(root, baseline, {
		forcedPath: `trail/${trailFile}`,
		name: "Qorpera Controller",
		email: "controller@qorpera.local",
		title: "docs: checkpoint controller session",
		trigger: `trail/${trailFile}`,
		rationale: "preserve the settled controller change set",
	});
}

function writeAtomicJson(path: string, value: unknown): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, path);
}

function physicalFile(path: string): boolean {
	try {
		const entry = lstatSync(path);
		return (
			entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && resolve(realpathSync(path)) === resolve(path)
		);
	} catch {
		return false;
	}
}

function gitText(root: string, args: string[]): string | undefined {
	const result = git(root, args);
	return result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()
		? result.stdout.trim()
		: undefined;
}

function bundleContainsHead(root: string, bundle: string, branch: string, head: string): boolean {
	return gitText(root, ["bundle", "list-heads", bundle, `refs/heads/${branch}`]) === `${head} refs/heads/${branch}`;
}

function pathMatchesHead(root: string, path: string): boolean {
	const working = gitText(root, ["hash-object", "--no-filters", "--", path]);
	const committed = gitText(root, ["rev-parse", `HEAD:${path.replace(/\\/g, "/")}`]);
	return Boolean(working && committed && working === committed);
}

function validRecoveryChain(value: unknown, recoveryHead: unknown): value is ProductRecoveryBundle[] {
	if (!Array.isArray(value)) return false;
	let previousHead: string | undefined;
	const paths = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const candidate = entry as Partial<ProductRecoveryBundle>;
		const path = candidate.path?.replace(/\\/g, "/");
		if (
			typeof path !== "string" ||
			!/^\.qorpera\/w\/[a-f0-9]{32}\.bundle$/.test(path) ||
			paths.has(path) ||
			typeof candidate.head !== "string" ||
			!/^[a-f0-9]{40,64}$/i.test(candidate.head) ||
			(candidate.baseHead !== undefined && !/^[a-f0-9]{40,64}$/i.test(candidate.baseHead)) ||
			(candidate.baseHead ?? undefined) !== previousHead
		)
			return false;
		paths.add(path);
		previousHead = candidate.head;
	}
	return value.length === 0 ? true : typeof recoveryHead === "string" && previousHead === recoveryHead;
}

function commitProductRecoveryMetadata(company: string, trail: string, paths: string[]): void {
	const uniquePaths = [...new Set(paths)];
	const added = git(company, ["add", "--", ...uniquePaths]);
	if (added.status !== 0) throw new Error("product recovery staging failed");
	const committed = git(company, [
		"-c",
		"user.name=Qorpera Kernel",
		"-c",
		"user.email=kernel@qorpera.local",
		"commit",
		"--only",
		"-m",
		`docs: preserve product worktree recovery\n\nQorpera-Trigger: ${trail}\nQorpera-Rationale: keep active product commits portable with the company`,
		"--",
		...uniquePaths,
	]);
	if (committed.status !== 0) {
		git(company, ["restore", "--staged", "--", ...uniquePaths]);
		throw new Error(`product recovery commit failed: ${committed.stderr || committed.stdout || "git commit failed"}`);
	}
	if (!uniquePaths.every((path) => pathMatchesHead(company, path))) {
		throw new Error("product recovery commit did not preserve the exact assignment and bundle blobs");
	}
}

function persistProductWorktreeRecovery(companyRoot: string, worktreeRoot: string, companyTrailFile: string): void {
	const company = resolve(realpathSync(companyRoot));
	const worktree = resolve(realpathSync(worktreeRoot));
	const trail = resolve(companyTrailFile);
	const trailRelative = relative(resolve(company, "trail"), trail);
	if (
		!trailRelative ||
		trailRelative.startsWith("..") ||
		isAbsolute(trailRelative) ||
		!trailRelative.endsWith(".jsonl")
	) {
		throw new Error("product recovery provenance is outside the company trail");
	}
	const worktreeRelative = relative(company, worktree).replace(/\\/g, "/");
	const match = worktreeRelative.match(
		/^departments\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?-development)\/worktrees\/([^/]+)$/,
	);
	if (!match) throw new Error("product recovery worktree is outside an assigned product department");
	const departmentId = match[1];
	const taskId = match[2];
	const assignmentRelative = `.qorpera/product-worktrees/${departmentId}/${taskId}.json`;
	const assignmentPath = join(company, assignmentRelative);
	if (!physicalFile(assignmentPath)) throw new Error("product recovery assignment is not one physical file");
	const assignment = JSON.parse(readFileSync(assignmentPath, "utf-8")) as Partial<ProductWorktreeAssignment>;
	if (
		assignment.version !== 3 ||
		assignment.path?.replace(/\\/g, "/") !== worktreeRelative ||
		assignment.departmentId !== departmentId ||
		typeof assignment.branch !== "string" ||
		!assignment.branch ||
		typeof assignment.sourceRemote !== "string" ||
		!Array.isArray(assignment.sourceHistory) ||
		!validRecoveryChain(assignment.recoveryBundles, assignment.recoveryHead)
	) {
		throw new Error("product recovery assignment is invalid");
	}
	const branch = assignment.branch;
	const headHash = gitText(worktree, ["rev-parse", "HEAD"]) ?? "";
	if (!/^[a-f0-9]{40,64}$/i.test(headHash)) return;
	const currentBranch = gitText(worktree, ["branch", "--show-current"]);
	const branchHead = gitText(worktree, ["rev-parse", branch]);
	if (currentBranch !== branch || branchHead !== headHash) {
		throw new Error("product recovery checkpoint requires the exact assigned branch");
	}
	const existingChain = assignment.recoveryBundles;
	const existingChainIsValid =
		assignment.recoveryHead === headHash &&
		existingChain.at(-1)?.head === headHash &&
		existingChain.every((bundle) => {
			const path = bundle.path.replace(/\\/g, "/");
			const absolute = join(company, path);
			return physicalFile(absolute) && bundleContainsHead(worktree, absolute, branch, bundle.head);
		});
	if (existingChainIsValid) {
		const paths = [assignmentRelative, ...existingChain.map((bundle) => bundle.path.replace(/\\/g, "/"))];
		if (paths.every((path) => pathMatchesHead(company, path))) return;
		commitProductRecoveryMetadata(company, trail, paths);
		return;
	}
	const previousHead = existingChain.at(-1)?.head;
	if (previousHead && git(worktree, ["merge-base", "--is-ancestor", previousHead, headHash]).status !== 0) {
		throw new Error("product recovery history diverged from its last portable checkpoint");
	}
	const bundleDirectory = join(company, ".qorpera", "w");
	mkdirSync(bundleDirectory, { recursive: true });
	const temporary = join(bundleDirectory, `${randomUUID()}.tmp`);
	const bundled = git(worktree, [
		"bundle",
		"create",
		temporary,
		...(previousHead ? [`^${previousHead}`] : []),
		branch,
	]);
	if (
		bundled.status !== 0 ||
		git(worktree, ["bundle", "verify", temporary]).status !== 0 ||
		!bundleContainsHead(worktree, temporary, branch, headHash)
	) {
		rmSync(temporary, { force: true });
		throw new Error(`product recovery bundle failed: ${bundled.stderr || bundled.stdout || "invalid bundle"}`);
	}
	const objectId = gitText(company, ["hash-object", "--no-filters", "--", temporary]);
	if (!objectId) {
		rmSync(temporary, { force: true });
		throw new Error("product recovery bundle content identity failed");
	}
	const bundleRelative = `.qorpera/w/${objectId.slice(0, 32)}.bundle`;
	const bundlePath = join(company, bundleRelative);
	if (existsSync(bundlePath)) {
		if (
			!physicalFile(bundlePath) ||
			gitText(company, ["hash-object", "--no-filters", "--", bundlePath]) !== objectId
		) {
			rmSync(temporary, { force: true });
			throw new Error("product recovery bundle content address is occupied by different data");
		}
		rmSync(temporary, { force: true });
	} else {
		renameSync(temporary, bundlePath);
	}
	const bundleRecord: ProductRecoveryBundle = {
		path: bundleRelative,
		head: headHash,
		...(previousHead ? { baseHead: previousHead } : {}),
	};
	const updated: ProductWorktreeAssignment = {
		...(assignment as ProductWorktreeAssignment),
		recoveryHead: headHash,
		recoveryBundles: [...existingChain, bundleRecord],
		recoveryUpdatedAt: new Date().toISOString(),
	};
	writeAtomicJson(assignmentPath, updated);
	const paths = [assignmentRelative, bundleRelative];
	commitProductRecoveryMetadata(company, trail, paths);
}

export function checkpointProductWorktreeGit(
	companyRoot: string,
	root: string,
	baseline: CompanyGitBaseline,
	companyTrailFile: string,
): CompanyCheckpointResult {
	const result = checkpointGit(root, baseline, {
		name: "Qorpera Product Worker",
		email: "product-worker@qorpera.local",
		title: "fix: checkpoint product-worker session",
		trigger: companyTrailFile,
		rationale: "preserve uncommitted product work with its company trail provenance",
	});
	if (!result.success) return result;
	try {
		persistProductWorktreeRecovery(companyRoot, root, companyTrailFile);
		return result;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return { baseline: result.baseline, success: false };
	}
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

export function savePendingProductCheckpoint(
	path: string,
	companyRoot: string,
	worktreeRoot: string,
	baseline: CompanyGitBaseline,
	companyTrailFile: string,
): void {
	const record: PendingProductCheckpoint = {
		version: 2,
		companyRoot: resolve(companyRoot),
		worktreeRoot: resolve(worktreeRoot),
		companyTrailFile: resolve(companyTrailFile),
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
		if (!name.endsWith(".json") || name.endsWith(".product.json")) continue;
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

/** Reconcile a failed product-worker checkpoint before that assigned clone is
 * granted write access again. The record retains the exact company trail path
 * that caused the worktree changes. */
export function reconcilePendingProductCheckpoints(dir: string, companyRoot: string): void {
	if (!existsSync(dir)) return;
	const canonicalCompany = resolve(companyRoot);
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".product.json")) continue;
		const path = join(dir, name);
		try {
			const record = JSON.parse(readFileSync(path, "utf-8")) as Partial<PendingProductCheckpoint>;
			if (
				record.version !== 2 ||
				typeof record.companyRoot !== "string" ||
				typeof record.worktreeRoot !== "string" ||
				typeof record.companyTrailFile !== "string" ||
				!Array.isArray(record.dirtyPaths) ||
				!record.dirtyPaths.every(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { path?: unknown }).path === "string" &&
						typeof (entry as { hash?: unknown }).hash === "string",
				)
			) {
				throw new Error("invalid pending product checkpoint record");
			}
			const trailRoot = resolve(canonicalCompany, "trail");
			const trailRelative = relative(trailRoot, resolve(record.companyTrailFile));
			if (
				resolve(record.companyRoot) !== canonicalCompany ||
				!trailRelative ||
				trailRelative.startsWith("..") ||
				isAbsolute(trailRelative) ||
				!trailRelative.endsWith(".jsonl")
			) {
				throw new Error("pending product checkpoint provenance is outside the company trail");
			}
			const canonicalWorktree = resolve(record.worktreeRoot);
			const worktreeRelative = relative(canonicalCompany, canonicalWorktree);
			if (!worktreeRelative || worktreeRelative.startsWith("..") || isAbsolute(worktreeRelative)) {
				throw new Error("pending product checkpoint worktree is outside the company");
			}
			if (!existsSync(canonicalWorktree)) {
				throw new Error("pending product checkpoint worktree is missing");
			}
			const result = checkpointProductWorktreeGit(
				canonicalCompany,
				canonicalWorktree,
				{ dirtyPaths: new Map(record.dirtyPaths.map((entry) => [entry.path, entry.hash])) },
				record.companyTrailFile,
			);
			if (result.success) rmSync(path, { force: true });
			else
				savePendingProductCheckpoint(
					path,
					canonicalCompany,
					canonicalWorktree,
					result.baseline,
					record.companyTrailFile,
				);
		} catch (error) {
			throw new Error(
				`Could not reconcile pending product checkpoint ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
