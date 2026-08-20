import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { KernelExecutionIdentity } from "@qorpera/pi-protocol";
import { cloudCompanyPathBelongsToLogicalTree } from "./cloud-company-snapshot.ts";

const STATE_SCHEMA = "qorpera.cloud-company-execution/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_HASH_PATTERN = /^[0-9a-f]{40,64}$/i;

type ExecutionStateStatus = "active" | "proposed" | "requires_review";

interface ExecutionState {
	schema: typeof STATE_SCHEMA;
	profileId: string;
	checkoutId: string;
	companyRoot: string;
	checkoutRoot: string;
	baseHead: string;
	status: ExecutionStateStatus;
	execution?: KernelExecutionIdentity;
	proposalHead?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CloudCompanyExecutionCheckout {
	profileId: string;
	checkoutId: string;
	companyRoot: string;
	checkoutRoot: string;
	statePath: string;
}

export type CloudCompanyExecutionPromotion =
	| { status: "no_changes" }
	| { status: "promoted"; proposalHead: string; canonicalHead: string }
	| { status: "requires_review"; proposalHead: string };

export interface RecoverableCloudCompanyExecution extends CloudCompanyExecutionCheckout {
	status: "proposed" | "requires_review";
	proposalHead: string;
	execution?: KernelExecutionIdentity;
	updatedAt: string;
}

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
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

function gitArguments(root: string, args: string[]): string[] {
	const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
	return [
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
	];
}

function gitSync(root: string, args: string[]): GitResult {
	const result = spawnSync("git", gitArguments(root, args), {
		encoding: "utf-8",
		env: gitEnvironment(),
		shell: false,
		windowsHide: true,
	});
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function gitAsync(root: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const child = spawn("git", gitArguments(root, args), {
			stdio: ["ignore", "pipe", "pipe"],
			env: gitEnvironment(),
			shell: false,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (status: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			setImmediate(() => resolvePromise({ status, stdout, stderr }));
		};
		const timer = setTimeout(() => {
			child.kill();
			settle(null);
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", () => settle(null));
		child.on("exit", (code) => settle(code));
	});
}

function requiredGitOutput(result: GitResult, operation: string): string {
	const value = result.stdout.trim();
	if (result.status !== 0 || !GIT_HASH_PATTERN.test(value)) {
		throw new Error(`${operation} failed: ${result.stderr || result.stdout || "Git returned no object id"}`);
	}
	return value;
}

function writeState(path: string, state: ExecutionState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
	renameSync(temporary, path);
}

function readState(checkout: CloudCompanyExecutionCheckout): ExecutionState {
	const parsed: unknown = JSON.parse(readFileSync(checkout.statePath, "utf-8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Company execution state is invalid");
	const state = parsed as Partial<ExecutionState>;
	if (
		state.schema !== STATE_SCHEMA ||
		state.profileId !== checkout.profileId ||
		state.checkoutId !== checkout.checkoutId ||
		resolve(state.companyRoot ?? "") !== checkout.companyRoot ||
		resolve(state.checkoutRoot ?? "") !== checkout.checkoutRoot ||
		!GIT_HASH_PATTERN.test(state.baseHead ?? "") ||
		!state.createdAt ||
		!state.updatedAt ||
		!(["active", "proposed", "requires_review"] as const).includes(state.status as ExecutionStateStatus)
	) {
		throw new Error("Company execution state is invalid");
	}
	return state as ExecutionState;
}

function assertOwnedCheckout(base: string, path: string): void {
	const containment = relative(resolve(base), resolve(path));
	if (!containment || containment.startsWith("..") || isAbsolute(containment)) {
		throw new Error("Company execution checkout escaped its owned directory");
	}
}

export function createCloudCompanyExecutionCheckout(options: {
	userData: string;
	profileId: string;
	companyRoot: string;
}): CloudCompanyExecutionCheckout {
	if (!UUID_PATTERN.test(options.profileId)) throw new Error("Company execution profile id is invalid");
	const companyRoot = resolve(options.companyRoot);
	const checkoutId = randomUUID();
	const base = join(options.userData, "cloud-company-executions", options.profileId);
	const checkoutRoot = join(base, "worktrees", checkoutId);
	const statePath = join(base, "states", `${checkoutId}.json`);
	assertOwnedCheckout(base, checkoutRoot);
	assertOwnedCheckout(base, statePath);
	const baseHead = requiredGitOutput(gitSync(companyRoot, ["rev-parse", "HEAD"]), "Company execution base capture");
	mkdirSync(dirname(checkoutRoot), { recursive: true });
	const added = gitSync(companyRoot, ["worktree", "add", "--detach", checkoutRoot, baseHead]);
	if (added.status !== 0) {
		rmSync(checkoutRoot, { recursive: true, force: true });
		throw new Error(`Company execution checkout failed: ${added.stderr || added.stdout || "git worktree failed"}`);
	}
	const now = new Date().toISOString();
	writeState(statePath, {
		schema: STATE_SCHEMA,
		profileId: options.profileId,
		checkoutId,
		companyRoot,
		checkoutRoot,
		baseHead,
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	return { profileId: options.profileId, checkoutId, companyRoot, checkoutRoot, statePath };
}

export function bindCloudCompanyExecution(
	checkout: CloudCompanyExecutionCheckout,
	execution: KernelExecutionIdentity,
): void {
	if (!UUID_PATTERN.test(execution.id) || !UUID_PATTERN.test(execution.claimantId)) {
		throw new Error("Company execution identity is invalid");
	}
	const state = readState(checkout);
	if (state.execution && JSON.stringify(state.execution) !== JSON.stringify(execution)) {
		throw new Error("Company execution checkout is already bound to another durable execution");
	}
	writeState(checkout.statePath, { ...state, execution: { ...execution }, updatedAt: new Date().toISOString() });
}

async function prepareProposal(checkout: CloudCompanyExecutionCheckout): Promise<string | undefined> {
	const initialState = readState(checkout);
	const added = await gitAsync(checkout.checkoutRoot, ["add", "--all", "--", "."]);
	if (added.status !== 0) throw new Error(`Company execution staging failed: ${added.stderr || added.stdout}`);
	const ignored = await gitAsync(checkout.checkoutRoot, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"-z",
	]);
	if (ignored.status !== 0) throw new Error("Company execution ignored-path inspection failed");
	const ignoredCompanyPaths = ignored.stdout.split("\0").filter(Boolean).filter(cloudCompanyPathBelongsToLogicalTree);
	if (ignoredCompanyPaths.length > 0) {
		const forced = await gitAsync(checkout.checkoutRoot, ["add", "--force", "--", ...ignoredCompanyPaths]);
		if (forced.status !== 0) throw new Error(`Company execution ignored-path staging failed: ${forced.stderr}`);
	}
	const changed = await gitAsync(checkout.checkoutRoot, ["diff", "--cached", "--quiet"]);
	if (changed.status === 0) return initialState.proposalHead;
	if (changed.status !== 1) throw new Error("Company execution change inspection failed");
	const committed = await gitAsync(
		checkout.checkoutRoot,
		initialState.proposalHead
			? ["-c", "user.name=Qorpera Agent", "-c", "user.email=agent@qorpera.local", "commit", "--amend", "--no-edit"]
			: [
					"-c",
					"user.name=Qorpera Agent",
					"-c",
					"user.email=agent@qorpera.local",
					"commit",
					"-m",
					"docs: propose settled company execution",
				],
	);
	if (committed.status !== 0) {
		throw new Error(`Company execution proposal failed: ${committed.stderr || committed.stdout}`);
	}
	const proposalHead = requiredGitOutput(
		await gitAsync(checkout.checkoutRoot, ["rev-parse", "HEAD"]),
		"Company execution proposal capture",
	);
	const ref = `refs/qorpera/executions/${checkout.checkoutId}`;
	const retained = await gitAsync(checkout.companyRoot, ["update-ref", ref, proposalHead]);
	if (retained.status !== 0) throw new Error(`Company execution proposal retention failed: ${retained.stderr}`);
	const state = readState(checkout);
	writeState(checkout.statePath, {
		...state,
		status: initialState.status === "requires_review" ? "requires_review" : "proposed",
		proposalHead,
		updatedAt: new Date().toISOString(),
	});
	return proposalHead;
}

export async function promoteCloudCompanyExecution(
	checkout: CloudCompanyExecutionCheckout,
): Promise<CloudCompanyExecutionPromotion> {
	const proposalHead = await prepareProposal(checkout);
	const dirty = await gitAsync(checkout.companyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (dirty.status !== 0 || dirty.stdout.trim()) {
		throw new Error("Canonical company checkout changed before execution promotion");
	}
	if (!proposalHead) {
		const canonicalHead = requiredGitOutput(
			await gitAsync(checkout.companyRoot, ["rev-parse", "HEAD"]),
			"Canonical company refresh capture",
		);
		const reset = await gitAsync(checkout.checkoutRoot, ["reset", "--hard", canonicalHead]);
		if (reset.status !== 0) throw new Error(`Company execution checkout refresh failed: ${reset.stderr}`);
		const state = readState(checkout);
		writeState(checkout.statePath, {
			...state,
			baseHead: canonicalHead,
			status: "active",
			execution: undefined,
			proposalHead: undefined,
			updatedAt: new Date().toISOString(),
		});
		return { status: "no_changes" };
	}
	const alreadyPromoted = await gitAsync(checkout.companyRoot, ["merge-base", "--is-ancestor", proposalHead, "HEAD"]);
	if (alreadyPromoted.status !== 0) {
		const picked = await gitAsync(checkout.companyRoot, [
			"-c",
			"user.name=Qorpera Host",
			"-c",
			"user.email=host@qorpera.local",
			"cherry-pick",
			proposalHead,
		]);
		if (picked.status !== 0) {
			await gitAsync(checkout.companyRoot, ["cherry-pick", "--abort"]);
			const state = readState(checkout);
			writeState(checkout.statePath, {
				...state,
				status: "requires_review",
				proposalHead,
				updatedAt: new Date().toISOString(),
			});
			return { status: "requires_review", proposalHead };
		}
	}
	const canonicalHead = requiredGitOutput(
		await gitAsync(checkout.companyRoot, ["rev-parse", "HEAD"]),
		"Canonical company promotion capture",
	);
	const reset = await gitAsync(checkout.checkoutRoot, ["reset", "--hard", canonicalHead]);
	if (reset.status !== 0) throw new Error(`Company execution checkout refresh failed: ${reset.stderr}`);
	const state = readState(checkout);
	writeState(checkout.statePath, {
		...state,
		baseHead: canonicalHead,
		status: "active",
		execution: undefined,
		proposalHead: undefined,
		updatedAt: new Date().toISOString(),
	});
	return { status: "promoted", proposalHead, canonicalHead };
}

export async function quarantineCloudCompanyExecution(
	checkout: CloudCompanyExecutionCheckout,
): Promise<{ proposalHead?: string }> {
	const proposalHead = await prepareProposal(checkout);
	if (!proposalHead) return {};
	const state = readState(checkout);
	writeState(checkout.statePath, {
		...state,
		status: "requires_review",
		proposalHead,
		updatedAt: new Date().toISOString(),
	});
	return { proposalHead };
}

export async function discardCleanCloudCompanyExecution(checkout: CloudCompanyExecutionCheckout): Promise<void> {
	const dirty = await gitAsync(checkout.checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Company execution checkout still contains work");
	const removed = await gitAsync(checkout.companyRoot, ["worktree", "remove", "--force", checkout.checkoutRoot]);
	if (removed.status !== 0) throw new Error(`Company execution checkout cleanup failed: ${removed.stderr}`);
	rmSync(checkout.statePath, { force: true });
}

export function recoverableCloudCompanyExecutions(userData: string, profileId: string): number {
	return listRecoverableCloudCompanyExecutions(userData, profileId).length;
}

export function listRecoverableCloudCompanyExecutions(
	userData: string,
	profileId: string,
): RecoverableCloudCompanyExecution[] {
	if (!UUID_PATTERN.test(profileId)) return [];
	const directory = join(userData, "cloud-company-executions", profileId, "states");
	if (!existsSync(directory)) return [];
	const base = join(userData, "cloud-company-executions", profileId);
	const recoverable: RecoverableCloudCompanyExecution[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json")) continue;
		try {
			const value = JSON.parse(readFileSync(join(directory, name), "utf-8")) as Partial<ExecutionState>;
			const checkoutId = value.checkoutId;
			const proposalHead = value.proposalHead;
			if (
				value.schema !== STATE_SCHEMA ||
				(value.status !== "proposed" && value.status !== "requires_review") ||
				value.profileId !== profileId ||
				typeof checkoutId !== "string" ||
				!UUID_PATTERN.test(checkoutId) ||
				typeof proposalHead !== "string" ||
				!GIT_HASH_PATTERN.test(proposalHead) ||
				typeof value.companyRoot !== "string" ||
				typeof value.checkoutRoot !== "string" ||
				typeof value.updatedAt !== "string"
			) {
				continue;
			}
			assertOwnedCheckout(base, value.checkoutRoot);
			assertOwnedCheckout(base, join(directory, name));
			if (!existsSync(value.checkoutRoot)) continue;
			recoverable.push({
				profileId,
				checkoutId,
				companyRoot: resolve(value.companyRoot),
				checkoutRoot: resolve(value.checkoutRoot),
				statePath: join(directory, name),
				status: value.status,
				proposalHead,
				...(value.execution ? { execution: value.execution } : {}),
				updatedAt: value.updatedAt,
			});
		} catch {}
	}
	return recoverable.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function acceptReviewedCloudCompanyExecution(checkout: RecoverableCloudCompanyExecution): Promise<string> {
	const proposalHead = await prepareProposal(checkout);
	if (!proposalHead) throw new Error("Reviewed Company File proposal is empty");
	const state = readState(checkout);
	if (state.status !== "requires_review") throw new Error("Company File proposal does not require review");
	const dirty = await gitAsync(checkout.companyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Canonical Company File is not ready for review");
	const changed = await gitAsync(checkout.companyRoot, ["diff", "--name-only", "-z", state.baseHead, proposalHead]);
	if (changed.status !== 0) throw new Error(`Company File proposal inspection failed: ${changed.stderr}`);
	const paths = changed.stdout.split("\0").filter(Boolean);
	if (paths.length === 0 || paths.some((path) => !cloudCompanyPathBelongsToLogicalTree(path))) {
		throw new Error("Company File proposal contains no safe logical changes");
	}
	try {
		for (const path of paths) {
			const existsAtProposal = await gitAsync(checkout.companyRoot, ["cat-file", "-e", `${proposalHead}:${path}`]);
			const applied =
				existsAtProposal.status === 0
					? await gitAsync(checkout.companyRoot, ["checkout", proposalHead, "--", path])
					: await gitAsync(checkout.companyRoot, ["rm", "--force", "--ignore-unmatch", "--", path]);
			if (applied.status !== 0) throw new Error(`Company File review apply failed: ${applied.stderr}`);
		}
		const committed = await gitAsync(checkout.companyRoot, [
			"-c",
			"user.name=Qorpera Reviewer",
			"-c",
			"user.email=review@qorpera.local",
			"commit",
			"-m",
			"docs: accept reviewed company execution",
		]);
		if (committed.status !== 0) throw new Error(`Company File review commit failed: ${committed.stderr}`);
	} catch (error) {
		await gitAsync(checkout.companyRoot, ["reset", "--hard", "HEAD"]);
		throw error;
	}
	const canonicalHead = requiredGitOutput(
		await gitAsync(checkout.companyRoot, ["rev-parse", "HEAD"]),
		"Reviewed Company File capture",
	);
	const reset = await gitAsync(checkout.checkoutRoot, ["reset", "--hard", canonicalHead]);
	if (reset.status !== 0) throw new Error(`Reviewed checkout refresh failed: ${reset.stderr}`);
	writeState(checkout.statePath, {
		...state,
		baseHead: canonicalHead,
		status: "active",
		execution: undefined,
		proposalHead: undefined,
		updatedAt: new Date().toISOString(),
	});
	await discardCleanCloudCompanyExecution(checkout);
	return canonicalHead;
}

export async function rejectReviewedCloudCompanyExecution(checkout: RecoverableCloudCompanyExecution): Promise<void> {
	const state = readState(checkout);
	if (state.status !== "requires_review") throw new Error("Company File proposal does not require review");
	const removed = await gitAsync(checkout.companyRoot, ["worktree", "remove", "--force", checkout.checkoutRoot]);
	if (removed.status !== 0) throw new Error(`Company File proposal cleanup failed: ${removed.stderr}`);
	await gitAsync(checkout.companyRoot, ["update-ref", "-d", `refs/qorpera/executions/${checkout.checkoutId}`]);
	rmSync(checkout.statePath, { force: true });
}
