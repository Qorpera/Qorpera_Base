import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionIdentity } from "@qorpera/contracts";
import {
	captureCloudCompanyTree,
	cloudCompanyPathBelongsToLogicalTree,
	cloudCompanyPathIsAuthorityCritical,
	validateCloudCompanyLogicalTree,
} from "./cloud-company-snapshot.ts";
import { publishCompanySnapshotRestoreProof } from "./cloud-object-reachability.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { HostedCompanyProposal, HostedCompanyProposalReason, QorperaHostedPrimary } from "./hosted-primary.ts";

const STATE_SCHEMA = "qorpera.cloud-company-execution/v1";
const REVIEW_ACCEPT_SCHEMA = "qorpera.cloud-company-review-accept/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_HASH_PATTERN = /^[0-9a-f]{40,64}$/i;

type ExecutionStateStatus = "active" | "proposed" | "requires_review";

interface ExecutionState {
	schema: typeof STATE_SCHEMA;
	profileId: string;
	checkoutId: string;
	companyRoot: string;
	checkoutRoot: string;
	hostInstanceId: string;
	baseHead: string;
	status: ExecutionStateStatus;
	execution?: ExecutionIdentity;
	proposalHead?: string;
	cloudProposalId?: string;
	cloudProposalSnapshotId?: string;
	createdAt: string;
	updatedAt: string;
}

interface ReviewAcceptanceJournal {
	schema: typeof REVIEW_ACCEPT_SCHEMA;
	profileId: string;
	checkoutId: string;
	companyRoot: string;
	expectedCanonicalHead: string;
	acceptedHead: string;
	indexPath: string;
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
	execution?: ExecutionIdentity;
	cloudProposalId?: string;
	cloudProposalSnapshotId?: string;
	updatedAt: string;
	expectedCanonicalHead: string;
}

export type CloudCompanyProposalPrimary = Pick<
	QorperaHostedPrimary,
	| "appendObjectReachabilityEntries"
	| "beginObjectReachabilityGraph"
	| "completeObjectReachabilityGraph"
	| "createObjectRestoreProof"
	| "prepareCompanyFileProposal"
	| "submitCompanyProposal"
	| "verifyCompanySnapshotClosure"
>;

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

function gitAsync(
	root: string,
	args: string[],
	timeoutMs = 60_000,
	extraEnvironment?: NodeJS.ProcessEnv,
): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const child = spawn("git", gitArguments(root, args), {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...gitEnvironment(), ...extraEnvironment },
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

function deterministicUuid(value: string): string {
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 32);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

function writeAtomicJson(path: string, value: object): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, {
		encoding: "utf-8",
		flag: "wx",
		mode: 0o600,
	});
	renameSync(temporary, path);
}

function writeState(path: string, state: ExecutionState): void {
	writeAtomicJson(path, state);
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
		(state.cloudProposalId !== undefined && !UUID_PATTERN.test(state.cloudProposalId)) ||
		(state.cloudProposalSnapshotId !== undefined && !UUID_PATTERN.test(state.cloudProposalSnapshotId)) ||
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
	hostInstanceId: string;
}): CloudCompanyExecutionCheckout {
	if (!UUID_PATTERN.test(options.profileId)) throw new Error("Company execution profile id is invalid");
	if (!UUID_PATTERN.test(options.hostInstanceId)) throw new Error("Company execution host identity is invalid");
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
		hostInstanceId: options.hostInstanceId,
		baseHead,
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
	return { profileId: options.profileId, checkoutId, companyRoot, checkoutRoot, statePath };
}

export function bindCloudCompanyExecution(checkout: CloudCompanyExecutionCheckout, execution: ExecutionIdentity): void {
	if (!UUID_PATTERN.test(execution.id) || !UUID_PATTERN.test(execution.claimantId)) {
		throw new Error("Company execution identity is invalid");
	}
	const state = readState(checkout);
	if (state.execution && JSON.stringify(state.execution) !== JSON.stringify(execution)) {
		throw new Error("Company execution checkout is already bound to another durable execution");
	}
	writeState(checkout.statePath, { ...state, execution: { ...execution }, updatedAt: new Date().toISOString() });
}

export function cloudCompanyExecutionMatchesCanonical(checkout: CloudCompanyExecutionCheckout): boolean {
	const state = readState(checkout);
	const canonicalHead = requiredGitOutput(
		gitSync(checkout.companyRoot, ["rev-parse", "HEAD"]),
		"Canonical company revision inspection",
	);
	const checkoutHead = requiredGitOutput(
		gitSync(checkout.checkoutRoot, ["rev-parse", "HEAD"]),
		"Company execution revision inspection",
	);
	const checkoutStatus = gitSync(checkout.checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	return (
		state.status === "active" &&
		state.baseHead === canonicalHead &&
		checkoutHead === canonicalHead &&
		checkoutStatus.status === 0 &&
		checkoutStatus.stdout.trim().length === 0
	);
}

async function prepareProposal(checkout: CloudCompanyExecutionCheckout): Promise<string | undefined> {
	await validateCloudCompanyLogicalTree(checkout.checkoutRoot);
	const initialState = readState(checkout);
	const resetIndex = await gitAsync(checkout.checkoutRoot, ["reset", "--mixed", "HEAD"]);
	if (resetIndex.status !== 0) throw new Error(`Company execution index reset failed: ${resetIndex.stderr}`);
	const tracked = await gitAsync(checkout.checkoutRoot, ["diff", "--name-only", "-z", "HEAD", "--", "."]);
	const untracked = await gitAsync(checkout.checkoutRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (tracked.status !== 0 || untracked.status !== 0) throw new Error("Company execution path inspection failed");
	const logicalPaths = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")])]
		.filter(Boolean)
		.filter(cloudCompanyPathBelongsToLogicalTree);
	if (logicalPaths.length > 0) {
		const added = await gitAsync(checkout.checkoutRoot, ["add", "--all", "--", ...logicalPaths]);
		if (added.status !== 0) throw new Error(`Company execution staging failed: ${added.stderr || added.stdout}`);
	}
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
	const tree = await gitAsync(checkout.checkoutRoot, ["ls-tree", "-r", "-z", "--full-tree", proposalHead]);
	if (tree.status !== 0) throw new Error("Company execution proposal tree could not be validated");
	for (const record of tree.stdout.split("\0").filter(Boolean)) {
		const match = /^([0-7]{6}) ([a-z]+) [0-9a-f]{40,64}\t(.+)$/.exec(record);
		if (!match) throw new Error("Company execution proposal contains an invalid Git tree entry");
		if (
			cloudCompanyPathBelongsToLogicalTree(match[3]) &&
			!(match[2] === "blob" && /^(100644|100755)$/.test(match[1]))
		) {
			throw new Error(`Company execution proposal contains an unsupported file kind: ${match[3]}`);
		}
	}
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

async function deleteExecutionRef(checkout: CloudCompanyExecutionCheckout): Promise<void> {
	const removed = await gitAsync(checkout.companyRoot, [
		"update-ref",
		"-d",
		`refs/qorpera/executions/${checkout.checkoutId}`,
	]);
	if (removed.status !== 0) throw new Error(`Company execution proposal cleanup failed: ${removed.stderr}`);
}

export async function cloudCompanyExecutionTouchesAuthorityCritical(
	checkout: Pick<RecoverableCloudCompanyExecution, "checkoutRoot" | "proposalHead">,
): Promise<boolean> {
	const changed = await gitAsync(checkout.checkoutRoot, [
		"diff",
		"--name-only",
		"-z",
		`${checkout.proposalHead}^`,
		checkout.proposalHead,
	]);
	if (changed.status !== 0) throw new Error("Company execution authority-path inspection failed");
	return changed.stdout.split("\0").filter(Boolean).some(cloudCompanyPathIsAuthorityCritical);
}

export async function promoteCloudCompanyExecution(
	checkout: CloudCompanyExecutionCheckout,
	options: { requireReview?: boolean } = {},
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
			cloudProposalId: undefined,
			cloudProposalSnapshotId: undefined,
			updatedAt: new Date().toISOString(),
		});
		return { status: "no_changes" };
	}
	if (
		options.requireReview ||
		(await cloudCompanyExecutionTouchesAuthorityCritical({ checkoutRoot: checkout.checkoutRoot, proposalHead }))
	) {
		const state = readState(checkout);
		writeState(checkout.statePath, {
			...state,
			status: "requires_review",
			proposalHead,
			updatedAt: new Date().toISOString(),
		});
		return { status: "requires_review", proposalHead };
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
	await deleteExecutionRef(checkout);
	const state = readState(checkout);
	writeState(checkout.statePath, {
		...state,
		baseHead: canonicalHead,
		status: "active",
		execution: undefined,
		proposalHead: undefined,
		cloudProposalId: undefined,
		cloudProposalSnapshotId: undefined,
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

export async function publishCloudCompanyExecutionProposal(options: {
	userData: string;
	environmentId: string;
	baseSnapshotId: string;
	checkout: CloudCompanyExecutionCheckout;
	execution: ExecutionIdentity;
	sessionId: string;
	trailEndSequence: number;
	reason: HostedCompanyProposalReason;
	policyKey?: string;
	title: string;
	reviewerStaffIds?: string[];
	objects: CloudContentAddressedStore;
	primary: CloudCompanyProposalPrimary;
}): Promise<HostedCompanyProposal> {
	if (
		!UUID_PATTERN.test(options.environmentId) ||
		!UUID_PATTERN.test(options.baseSnapshotId) ||
		!UUID_PATTERN.test(options.sessionId) ||
		!UUID_PATTERN.test(options.execution.id) ||
		!UUID_PATTERN.test(options.execution.claimantId) ||
		!Number.isSafeInteger(options.trailEndSequence) ||
		options.trailEndSequence < 0
	) {
		throw new Error("Company execution proposal identity is invalid");
	}
	const proposalHead = await prepareProposal(options.checkout);
	if (!proposalHead) throw new Error("Company execution proposal contains no logical changes");
	const state = readState(options.checkout);
	if (
		state.proposalHead !== proposalHead ||
		state.status !== "requires_review" ||
		JSON.stringify(state.execution) !== JSON.stringify(options.execution)
	) {
		throw new Error("Company execution proposal is not bound to the active durable execution");
	}
	const tree = await captureCloudCompanyTree(
		options.checkout.checkoutRoot,
		options.checkout.profileId,
		options.objects,
		{
			userData: options.userData,
		},
	);
	const identity = `${options.checkout.checkoutId}:${proposalHead}`;
	const snapshot = await options.primary.prepareCompanyFileProposal({
		environmentId: options.environmentId,
		clientRevisionId: deterministicUuid(`qorpera.company-proposal-revision/v1:${identity}`),
		baseSnapshotId: options.baseSnapshotId,
		tree,
	});
	await publishCompanySnapshotRestoreProof(snapshot, options.objects, options.primary);
	const proposal = await options.primary.submitCompanyProposal({
		environmentId: options.environmentId,
		clientProposalId: deterministicUuid(`qorpera.company-proposal/v1:${identity}`),
		proposalSnapshotId: snapshot.snapshotId,
		execution: options.execution,
		sessionId: options.sessionId,
		trailEndSequence: options.trailEndSequence,
		reason: options.reason,
		...(options.policyKey ? { policyKey: options.policyKey } : {}),
		title: options.title,
		reviewerStaffIds: options.reviewerStaffIds ?? [],
	});
	const currentState = readState(options.checkout);
	writeState(options.checkout.statePath, {
		...currentState,
		cloudProposalId: proposal.proposalId,
		cloudProposalSnapshotId: proposal.proposalSnapshot.snapshotId,
		updatedAt: new Date().toISOString(),
	});
	return proposal;
}

export async function discardCleanCloudCompanyExecution(checkout: CloudCompanyExecutionCheckout): Promise<void> {
	const dirty = await gitAsync(checkout.checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("Company execution checkout still contains work");
	await deleteExecutionRef(checkout);
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
			const companyRoot = resolve(value.companyRoot);
			const expectedCanonicalHead = requiredGitOutput(
				gitSync(companyRoot, ["rev-parse", "HEAD"]),
				"Company review canonical revision inspection",
			);
			recoverable.push({
				profileId,
				checkoutId,
				companyRoot,
				checkoutRoot: resolve(value.checkoutRoot),
				statePath: join(directory, name),
				status: value.status,
				proposalHead,
				...(value.execution ? { execution: value.execution } : {}),
				...(typeof value.cloudProposalId === "string" && UUID_PATTERN.test(value.cloudProposalId)
					? { cloudProposalId: value.cloudProposalId }
					: {}),
				...(typeof value.cloudProposalSnapshotId === "string" && UUID_PATTERN.test(value.cloudProposalSnapshotId)
					? { cloudProposalSnapshotId: value.cloudProposalSnapshotId }
					: {}),
				updatedAt: value.updatedAt,
				expectedCanonicalHead,
			});
		} catch {}
	}
	return recoverable.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function resolvePublishedCloudCompanyExecution(options: {
	userData: string;
	profileId: string;
	companyRoot: string;
	proposalId: string;
	proposalSnapshotId: string;
}): Promise<number> {
	if (
		!UUID_PATTERN.test(options.profileId) ||
		!UUID_PATTERN.test(options.proposalId) ||
		!UUID_PATTERN.test(options.proposalSnapshotId)
	) {
		throw new Error("Company proposal resolution identity is invalid");
	}
	const companyRoot = resolve(options.companyRoot);
	const canonicalHead = requiredGitOutput(
		await gitAsync(companyRoot, ["rev-parse", "HEAD"]),
		"Resolved Company File revision inspection",
	);
	let resolved = 0;
	for (const checkout of listRecoverableCloudCompanyExecutions(options.userData, options.profileId)) {
		if (
			checkout.cloudProposalId !== options.proposalId ||
			checkout.cloudProposalSnapshotId !== options.proposalSnapshotId ||
			checkout.companyRoot !== companyRoot
		) {
			continue;
		}
		const reset = await gitAsync(checkout.checkoutRoot, ["reset", "--hard", canonicalHead]);
		if (reset.status !== 0) throw new Error(`Resolved Company File checkout refresh failed: ${reset.stderr}`);
		await discardCleanCloudCompanyExecution(checkout);
		resolved += 1;
	}
	return resolved;
}

export function findRecoverableCloudCompanyExecution(
	userData: string,
	profileId: string,
	checkoutId: string,
	proposalHead: string,
	expectedCanonicalHead: string,
): RecoverableCloudCompanyExecution | undefined {
	if (
		!UUID_PATTERN.test(checkoutId) ||
		!GIT_HASH_PATTERN.test(proposalHead) ||
		!GIT_HASH_PATTERN.test(expectedCanonicalHead)
	) {
		return undefined;
	}
	return listRecoverableCloudCompanyExecutions(userData, profileId).find(
		(checkout) =>
			checkout.checkoutId === checkoutId &&
			checkout.proposalHead === proposalHead &&
			checkout.expectedCanonicalHead === expectedCanonicalHead,
	);
}

export async function recoverOrphanedCloudCompanyExecutions(options: {
	userData: string;
	profileId: string;
	companyRoot: string;
	hostInstanceId: string;
	exclusiveHost: boolean;
	liveCheckoutIds?: ReadonlySet<string>;
}): Promise<{ discarded: number; reviewable: number }> {
	if (!options.exclusiveHost) throw new Error("Company execution recovery requires the exclusive host lease");
	if (!UUID_PATTERN.test(options.profileId) || !UUID_PATTERN.test(options.hostInstanceId)) {
		throw new Error("Company execution recovery identity is invalid");
	}
	const directory = join(options.userData, "cloud-company-executions", options.profileId, "states");
	if (!existsSync(directory)) return { discarded: 0, reviewable: 0 };
	const companyRoot = resolve(options.companyRoot);
	const base = join(options.userData, "cloud-company-executions", options.profileId);
	let discarded = 0;
	let reviewable = 0;
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json")) continue;
		const statePath = join(directory, name);
		let value: Partial<ExecutionState>;
		try {
			value = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<ExecutionState>;
		} catch {
			continue;
		}
		if (
			value.schema !== STATE_SCHEMA ||
			value.status !== "active" ||
			value.profileId !== options.profileId ||
			typeof value.checkoutId !== "string" ||
			!UUID_PATTERN.test(value.checkoutId) ||
			options.liveCheckoutIds?.has(value.checkoutId) === true ||
			typeof value.companyRoot !== "string" ||
			resolve(value.companyRoot) !== companyRoot ||
			typeof value.checkoutRoot !== "string"
		) {
			continue;
		}
		assertOwnedCheckout(base, value.checkoutRoot);
		assertOwnedCheckout(base, statePath);
		const checkout: CloudCompanyExecutionCheckout = {
			profileId: options.profileId,
			checkoutId: value.checkoutId,
			companyRoot,
			checkoutRoot: resolve(value.checkoutRoot),
			statePath,
		};
		if (!existsSync(checkout.checkoutRoot)) {
			rmSync(statePath, { force: true });
			continue;
		}
		const quarantine = await quarantineCloudCompanyExecution(checkout);
		if (quarantine.proposalHead) {
			reviewable += 1;
		} else {
			await discardCleanCloudCompanyExecution(checkout);
			discarded += 1;
		}
	}
	return { discarded, reviewable };
}

async function finishReviewedAcceptance(checkout: CloudCompanyExecutionCheckout): Promise<void> {
	const dirty = await gitAsync(checkout.checkoutRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (dirty.status !== 0) throw new Error("Reviewed checkout state could not be inspected");
	if (dirty.stdout.trim()) {
		await quarantineCloudCompanyExecution(checkout);
		return;
	}
	const removed = await gitAsync(checkout.companyRoot, ["worktree", "remove", checkout.checkoutRoot]);
	if (removed.status !== 0) {
		await quarantineCloudCompanyExecution(checkout);
		return;
	}
	await deleteExecutionRef(checkout);
	rmSync(checkout.statePath, { force: true });
}

export async function recoverInterruptedCloudCompanyReviewAcceptance(options: {
	userData: string;
	profileId: string;
	companyRoot: string;
}): Promise<number> {
	if (!UUID_PATTERN.test(options.profileId)) throw new Error("Company review recovery profile is invalid");
	const directory = join(options.userData, "cloud-company-executions", options.profileId, "states");
	if (!existsSync(directory)) return 0;
	const companyRoot = resolve(options.companyRoot);
	let recovered = 0;
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".json.accept.json")) continue;
		const journalPath = join(directory, name);
		let journal: ReviewAcceptanceJournal;
		try {
			const value = JSON.parse(readFileSync(journalPath, "utf-8")) as Partial<ReviewAcceptanceJournal>;
			if (
				value.schema !== REVIEW_ACCEPT_SCHEMA ||
				value.profileId !== options.profileId ||
				typeof value.checkoutId !== "string" ||
				!UUID_PATTERN.test(value.checkoutId) ||
				resolve(value.companyRoot ?? "") !== companyRoot ||
				!GIT_HASH_PATTERN.test(value.expectedCanonicalHead ?? "") ||
				!GIT_HASH_PATTERN.test(value.acceptedHead ?? "") ||
				typeof value.indexPath !== "string" ||
				dirname(resolve(value.indexPath)) !== resolve(directory)
			) {
				throw new Error("Company review recovery journal is invalid");
			}
			journal = value as ReviewAcceptanceJournal;
		} catch (error) {
			throw new Error(`Company review recovery failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const currentHead = requiredGitOutput(
			await gitAsync(companyRoot, ["rev-parse", "HEAD"]),
			"Company review recovery head inspection",
		);
		const reset = await gitAsync(companyRoot, ["reset", "--hard", currentHead]);
		if (reset.status !== 0) throw new Error(`Company review recovery materialization failed: ${reset.stderr}`);
		if (currentHead === journal.acceptedHead) {
			const statePath = join(directory, `${journal.checkoutId}.json`);
			if (existsSync(statePath)) {
				const state = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<ExecutionState>;
				if (typeof state.checkoutRoot === "string" && existsSync(state.checkoutRoot)) {
					await finishReviewedAcceptance({
						profileId: options.profileId,
						checkoutId: journal.checkoutId,
						companyRoot,
						checkoutRoot: resolve(state.checkoutRoot),
						statePath,
					});
				}
			}
		}
		rmSync(journal.indexPath, { force: true });
		rmSync(journalPath, { force: true });
		recovered += 1;
	}
	return recovered;
}

export async function acceptReviewedCloudCompanyExecution(checkout: RecoverableCloudCompanyExecution): Promise<string> {
	const initialState = readState(checkout);
	if (
		initialState.status !== "requires_review" ||
		initialState.proposalHead !== checkout.proposalHead ||
		checkout.expectedCanonicalHead !==
			requiredGitOutput(gitSync(checkout.companyRoot, ["rev-parse", "HEAD"]), "Company review head validation")
	) {
		throw new Error("Company File proposal or canonical head changed; review the current version first");
	}
	const proposalHead = await prepareProposal(checkout);
	if (!proposalHead) throw new Error("Reviewed Company File proposal is empty");
	if (proposalHead !== checkout.proposalHead) {
		throw new Error("Company File proposal changed after it was opened; review the current version first");
	}
	const state = readState(checkout);
	const canonicalDirty = await gitAsync(checkout.companyRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (canonicalDirty.status !== 0 || canonicalDirty.stdout.trim()) {
		throw new Error("Canonical Company File is not ready for review");
	}
	const changed = await gitAsync(checkout.companyRoot, ["diff", "--name-only", "-z", state.baseHead, proposalHead]);
	if (changed.status !== 0) throw new Error(`Company File proposal inspection failed: ${changed.stderr}`);
	const paths = changed.stdout.split("\0").filter(Boolean);
	if (paths.length === 0 || paths.some((path) => !cloudCompanyPathBelongsToLogicalTree(path))) {
		throw new Error("Company File proposal contains no safe logical changes");
	}

	const indexPath = `${checkout.statePath}.${randomUUID()}.index`;
	const journalPath = `${checkout.statePath}.accept.json`;
	const candidateRoot = join(dirname(checkout.checkoutRoot), `.candidate-${randomUUID().slice(0, 8)}`);
	const indexEnvironment = { GIT_INDEX_FILE: indexPath };
	try {
		const readTree = await gitAsync(
			checkout.companyRoot,
			["read-tree", checkout.expectedCanonicalHead],
			60_000,
			indexEnvironment,
		);
		if (readTree.status !== 0) throw new Error(`Company File review index failed: ${readTree.stderr}`);
		for (const path of paths) {
			const source = await gitAsync(checkout.companyRoot, ["ls-tree", "-z", proposalHead, "--", path]);
			if (source.status !== 0) throw new Error(`Company File proposal lookup failed: ${source.stderr}`);
			if (!source.stdout) {
				const removed = await gitAsync(
					checkout.companyRoot,
					["update-index", "--force-remove", "--", path],
					60_000,
					indexEnvironment,
				);
				if (removed.status !== 0) throw new Error(`Company File review deletion failed: ${removed.stderr}`);
				continue;
			}
			const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(source.stdout);
			if (!match) throw new Error("Company File proposal contains an unsupported path kind");
			const updated = await gitAsync(
				checkout.companyRoot,
				["update-index", "--add", "--cacheinfo", match[1], match[2], path],
				60_000,
				indexEnvironment,
			);
			if (updated.status !== 0) throw new Error(`Company File review index update failed: ${updated.stderr}`);
		}
		const tree = requiredGitOutput(
			await gitAsync(checkout.companyRoot, ["write-tree"], 60_000, indexEnvironment),
			"Reviewed Company File tree capture",
		);
		const acceptedHead = requiredGitOutput(
			await gitAsync(checkout.companyRoot, [
				"-c",
				"user.name=Qorpera Reviewer",
				"-c",
				"user.email=review@qorpera.local",
				"commit-tree",
				tree,
				"-p",
				checkout.expectedCanonicalHead,
				"-m",
				"docs: accept reviewed company execution",
			]),
			"Reviewed Company File commit capture",
		);
		const candidate = await gitAsync(checkout.companyRoot, [
			"worktree",
			"add",
			"--detach",
			candidateRoot,
			acceptedHead,
		]);
		if (candidate.status !== 0)
			throw new Error(`Reviewed Company File validation checkout failed: ${candidate.stderr}`);
		await validateCloudCompanyLogicalTree(candidateRoot);
		writeAtomicJson(journalPath, {
			schema: REVIEW_ACCEPT_SCHEMA,
			profileId: checkout.profileId,
			checkoutId: checkout.checkoutId,
			companyRoot: checkout.companyRoot,
			expectedCanonicalHead: checkout.expectedCanonicalHead,
			acceptedHead,
			indexPath,
		} satisfies ReviewAcceptanceJournal);
		const advanced = await gitAsync(checkout.companyRoot, [
			"update-ref",
			"HEAD",
			acceptedHead,
			checkout.expectedCanonicalHead,
		]);
		if (advanced.status !== 0) {
			throw new Error("The canonical Company File changed while the reviewed proposal was being accepted");
		}
		const reset = await gitAsync(checkout.companyRoot, ["reset", "--hard", acceptedHead]);
		if (reset.status !== 0) throw new Error(`Reviewed Company File materialization failed: ${reset.stderr}`);
		await finishReviewedAcceptance(checkout);
		rmSync(journalPath, { force: true });
		return acceptedHead;
	} finally {
		if (existsSync(candidateRoot)) {
			await gitAsync(checkout.companyRoot, ["worktree", "remove", "--force", candidateRoot]);
			rmSync(candidateRoot, { recursive: true, force: true });
		}
		rmSync(indexPath, { force: true });
	}
}

export async function rejectReviewedCloudCompanyExecution(checkout: RecoverableCloudCompanyExecution): Promise<void> {
	const state = readState(checkout);
	if (state.status !== "requires_review" || state.proposalHead !== checkout.proposalHead) {
		throw new Error("Company File proposal changed after it was opened; review the current version first");
	}
	const removed = await gitAsync(checkout.companyRoot, ["worktree", "remove", "--force", checkout.checkoutRoot]);
	if (removed.status !== 0) throw new Error(`Company File proposal cleanup failed: ${removed.stderr}`);
	await gitAsync(checkout.companyRoot, ["update-ref", "-d", `refs/qorpera/executions/${checkout.checkoutId}`]);
	rmSync(checkout.statePath, { force: true });
}
