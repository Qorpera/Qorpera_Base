import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type CompanyRuntimeLock,
	canonicalCompanyRoot,
	claimCompanyRuntimeLock,
	releaseCompanyRuntimeLock,
} from "@qorpera/company/company-runtime-lock";
import { comparePath, entryMap, sameEntry } from "./cloud-company-merge.ts";
import {
	type CloudCompanyTreeContractVersion,
	type CloudCompanyTreeEntry,
	type CloudCompanyTreeReference,
	cloudCompanyPathBelongsToLogicalTree,
	currentCloudCompanyTreeReference,
	readCloudCompanyTreeManifest,
	validateCloudCompanyTreeEntries,
} from "./cloud-company-snapshot.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { HostedCompanyFile, HostedCompanySnapshot } from "./hosted-primary.ts";

/** One-directional delta sync for the Company Computer's standing checkout:
 * the working copy fast-forwards toward the verified head and is never the
 * authority. Publication stays on the capture/proposal/verifier path; a path
 * whose disk state no longer matches what this agent last applied is local
 * work in progress and is skipped, never overwritten or merged here. The same
 * guard makes an interrupted apply self-healing: paths already at the head
 * simply adopt on the next poll, so no journal or rollback is needed. */

const SYNC_STATE_SCHEMA = "qorpera.company-computer-sync/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIN_SYNC_POLL_SECONDS = 5;
const MAX_SYNC_POLL_SECONDS = 3_600;

export interface CloudCompanyComputerSyncHead {
	snapshotId: string;
	tree: CloudCompanyTreeReference;
}

export interface CloudCompanyComputerHeadResolver {
	/** Undefined while the Company File has no dispatchable verified head. */
	resolveVerifiedHead(): Promise<CloudCompanyComputerSyncHead | undefined>;
}

export interface CompanyComputerSyncPrimary {
	getCompanyFile(environmentId: string): Promise<HostedCompanyFile>;
	getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot>;
}

/** The verified head is qorpera_company_files.head_snapshot_id and nothing
 * else; a head that is not a published snapshot is a control-plane integrity
 * failure, not a candidate to apply. */
export function hostedCompanyComputerHeadResolver(
	primary: CompanyComputerSyncPrimary,
	profileId: string,
	environmentId: string,
): CloudCompanyComputerHeadResolver {
	return {
		async resolveVerifiedHead(): Promise<CloudCompanyComputerSyncHead | undefined> {
			const companyFile = await primary.getCompanyFile(environmentId);
			if (companyFile.profileId !== profileId || companyFile.environmentId !== environmentId) {
				throw new Error("Company File is outside this profile environment");
			}
			if (companyFile.state !== "ready" || !companyFile.headSnapshotId) return undefined;
			const snapshot = await primary.getCompanySnapshot(companyFile.headSnapshotId);
			if (
				snapshot.snapshotId !== companyFile.headSnapshotId ||
				snapshot.profileId !== profileId ||
				snapshot.environmentId !== environmentId
			) {
				throw new Error("Company File head snapshot is outside this profile environment");
			}
			if (snapshot.publicationState !== "published") {
				throw new Error("Company File head is not a published snapshot");
			}
			return { snapshotId: snapshot.snapshotId, tree: currentCloudCompanyTreeReference(snapshot.tree) };
		},
	};
}

/** Mirrors the sync block of qorpera.company-computer-bootstrap/v1 exactly;
 * unknown keys are ignored so an older agent keeps starting under a newer
 * provider. */
export interface CloudCompanyComputerSyncConfig {
	companyRoot: string;
	statePath: string;
	pollSeconds: number;
}

export function parseCloudCompanyComputerSyncConfig(value: unknown): CloudCompanyComputerSyncConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Company computer sync configuration is invalid");
	}
	const input = value as Record<string, unknown>;
	const companyRoot = input.company_root;
	const statePath = input.state_path;
	const pollSeconds = input.poll_seconds;
	if (typeof companyRoot !== "string" || !companyRoot.trim() || !isAbsolute(companyRoot)) {
		throw new Error("Company computer sync company root is invalid");
	}
	if (typeof statePath !== "string" || !statePath.trim() || !isAbsolute(statePath)) {
		throw new Error("Company computer sync state path is invalid");
	}
	if (
		!Number.isSafeInteger(pollSeconds) ||
		(pollSeconds as number) < MIN_SYNC_POLL_SECONDS ||
		(pollSeconds as number) > MAX_SYNC_POLL_SECONDS
	) {
		throw new Error("Company computer sync poll interval is invalid");
	}
	return { companyRoot, statePath, pollSeconds: pollSeconds as number };
}

export interface SyncCloudCompanyComputerCheckoutInput {
	companyRoot: string;
	statePath: string;
	profileId: string;
	environmentId: string;
	head: CloudCompanyComputerHeadResolver;
	objects: CloudContentAddressedStore;
	runtimeLock?: CompanyRuntimeLock;
}

export type CloudCompanyComputerSyncResult =
	| { status: "no-head" }
	| { status: "up-to-date"; snapshotId: string }
	| { status: "applied"; snapshotId: string; appliedPaths: string[]; skippedPaths: string[] };

interface CloudCompanyComputerSyncState {
	schema: typeof SYNC_STATE_SCHEMA;
	profileId: string;
	environmentId: string;
	root: string;
	appliedSnapshotId: string;
	appliedManifestSha256: string;
	contractVersion: CloudCompanyTreeContractVersion;
	fullyApplied: boolean;
	entries: CloudCompanyTreeEntry[];
}

type DiskPathState =
	| { kind: "absent" }
	| { kind: "directory" }
	| { kind: "file"; executable: boolean; fileSha256: string; bytes: number }
	| { kind: "other" };

function normalizedRoot(root: string): string {
	const resolved = resolve(root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertLockRoot(lock: CompanyRuntimeLock | undefined, root: string): void {
	if (lock && normalizedRoot(lock.root) !== normalizedRoot(root)) {
		throw new Error("Cloud company sync lock belongs to another company");
	}
}

function logicalPath(root: string, path: string): string {
	const absolute = resolve(root, ...path.split("/"));
	const rootRelative = relative(root, absolute);
	if (!rootRelative || rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) {
		throw new Error("Cloud company sync path escapes the company folder");
	}
	return absolute;
}

function validSyncEntries(value: unknown, contractVersion: CloudCompanyTreeContractVersion): CloudCompanyTreeEntry[] {
	if (!Array.isArray(value)) throw new Error("Cloud company sync entries are invalid");
	for (const entry of value as Array<Partial<CloudCompanyTreeEntry>>) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.path !== "string" ||
			(entry.kind !== "directory" && entry.kind !== "file") ||
			(entry.kind === "file" && typeof entry.executable !== "boolean")
		) {
			throw new Error("Cloud company sync entry is invalid");
		}
	}
	const entries = value as CloudCompanyTreeEntry[];
	validateCloudCompanyTreeEntries(entries, contractVersion);
	return entries;
}

async function readSyncState(
	path: string,
	profileId: string,
	environmentId: string,
	root: string,
): Promise<CloudCompanyComputerSyncState | undefined> {
	/* Any mismatch degrades to no state: with no last-applied record every
	 * divergent path is skipped and every matching path adopts, so a corrupt
	 * or foreign state file can never cause local work to be overwritten. */
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const input = value as Partial<CloudCompanyComputerSyncState>;
		if (
			input.schema !== SYNC_STATE_SCHEMA ||
			input.profileId !== profileId ||
			input.environmentId !== environmentId ||
			input.root !== normalizedRoot(root) ||
			!UUID_PATTERN.test(input.appliedSnapshotId ?? "") ||
			!SHA256_PATTERN.test(input.appliedManifestSha256 ?? "") ||
			(input.contractVersion !== 1 && input.contractVersion !== 2 && input.contractVersion !== 3) ||
			typeof input.fullyApplied !== "boolean"
		) {
			return undefined;
		}
		return {
			...input,
			entries: validSyncEntries(input.entries, input.contractVersion),
		} as CloudCompanyComputerSyncState;
	} catch {
		return undefined;
	}
}

async function writeSyncState(path: string, state: CloudCompanyComputerSyncState): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function inspectDiskPath(absolutePath: string): Promise<DiskPathState> {
	let entryStat: Awaited<ReturnType<typeof lstat>>;
	try {
		entryStat = await lstat(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
	if (entryStat.isSymbolicLink()) return { kind: "other" };
	if (entryStat.isDirectory()) return { kind: "directory" };
	if (!entryStat.isFile() || entryStat.nlink !== 1) return { kind: "other" };
	const bytes = await readFile(absolutePath);
	return {
		kind: "file",
		executable: (entryStat.mode & 0o111) !== 0,
		fileSha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.byteLength,
	};
}

function diskMatchesEntry(disk: DiskPathState, entry: CloudCompanyTreeEntry | undefined): boolean {
	if (!entry) return disk.kind === "absent";
	if (entry.kind === "directory") return disk.kind === "directory";
	return (
		disk.kind === "file" &&
		disk.fileSha256 === entry.file.fileSha256 &&
		disk.bytes === entry.file.bytes &&
		disk.executable === entry.executable
	);
}

async function stageSyncFiles(
	root: string,
	profileId: string,
	target: Map<string, CloudCompanyTreeEntry>,
	changedPaths: readonly string[],
	objects: CloudContentAddressedStore,
): Promise<{ transactionRoot: string; stagedRoot: string }> {
	const transactionRoot = join(root, ".qorpera", "w", `cloud-sync-${randomUUID()}`);
	if (cloudCompanyPathBelongsToLogicalTree(relative(root, transactionRoot))) {
		throw new Error("Cloud company sync transaction path is not isolated");
	}
	const stagedRoot = join(transactionRoot, "staged");
	try {
		await mkdir(stagedRoot, { recursive: true });
		for (const path of changedPaths) {
			const entry = target.get(path);
			if (!entry || entry.kind !== "file") continue;
			const staged = logicalPath(stagedRoot, path);
			await mkdir(dirname(staged), { recursive: true });
			await writeFile(staged, await objects.getFile(profileId, entry.file), { flag: "wx" });
			if (entry.executable && process.platform !== "win32") await chmod(staged, 0o755);
		}
	} catch (error) {
		await rm(transactionRoot, { recursive: true, force: true });
		throw error;
	}
	return { transactionRoot, stagedRoot };
}

/** Staging directories carry no rollback state, so anything left behind by a
 * crashed sync is garbage once this process holds the runtime lock. Merge
 * transactions (cloud-merge-*) journal real rollback state and are owned by
 * recoverInterruptedCloudCompanyMerges — never touched here. */
async function removeStaleSyncTransactions(root: string, currentTransactionRoot: string): Promise<void> {
	const transactionParent = join(root, ".qorpera", "w");
	let names: string[];
	try {
		names = await readdir(transactionParent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const name of names) {
		if (!name.startsWith("cloud-sync-")) continue;
		const stale = join(transactionParent, name);
		if (stale === currentTransactionRoot) continue;
		await rm(stale, { recursive: true, force: true });
	}
}

async function removeDirectoryIfUnoccupied(absolutePath: string): Promise<boolean> {
	try {
		await rmdir(absolutePath);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOTEMPTY" || code === "EEXIST") return false;
		throw error;
	}
}

export async function syncCloudCompanyComputerCheckout(
	input: SyncCloudCompanyComputerCheckoutInput,
): Promise<CloudCompanyComputerSyncResult> {
	const root = canonicalCompanyRoot(input.companyRoot);
	assertLockRoot(input.runtimeLock, root);
	const head = await input.head.resolveVerifiedHead();
	if (!head) return { status: "no-head" };
	const statePath = resolve(input.statePath);
	const state = await readSyncState(statePath, input.profileId, input.environmentId, root);
	if (
		state?.fullyApplied &&
		state.appliedSnapshotId === head.snapshotId &&
		state.appliedManifestSha256 === head.tree.manifestSha256
	) {
		return { status: "up-to-date", snapshotId: head.snapshotId };
	}
	if (state && state.contractVersion > head.tree.contractVersion) {
		/* An older tree contract omits paths the applied state tracks; diffing
		 * across that boundary would read the omissions as mass deletions. */
		throw new Error("Company File head uses an older tree contract than the applied sync state");
	}
	const manifest = await readCloudCompanyTreeManifest(input.profileId, head.tree, input.objects);
	const applied = entryMap(state?.entries ?? []);
	const target = entryMap(manifest.entries);
	for (const path of [...applied.keys()]) {
		/* Paths the current contract keeps out of the logical tree are
		 * machine-local state, not deletions: stop tracking, never touch disk. */
		if (!target.has(path) && !cloudCompanyPathBelongsToLogicalTree(path)) applied.delete(path);
	}
	const changedPaths = [...new Set([...applied.keys(), ...target.keys()])]
		.filter((path) => !sameEntry(applied.get(path), target.get(path)))
		.sort(comparePath);
	const writeAppliedState = async (fullyApplied: boolean): Promise<void> => {
		await writeSyncState(statePath, {
			schema: SYNC_STATE_SCHEMA,
			profileId: input.profileId,
			environmentId: input.environmentId,
			root: normalizedRoot(root),
			appliedSnapshotId: head.snapshotId,
			appliedManifestSha256: head.tree.manifestSha256,
			contractVersion: manifest.contractVersion,
			fullyApplied,
			entries: [...applied.values()].sort((left, right) => comparePath(left.path, right.path)),
		});
	};
	if (changedPaths.length === 0) {
		await writeAppliedState(true);
		return { status: "up-to-date", snapshotId: head.snapshotId };
	}
	const transaction = await stageSyncFiles(root, input.profileId, target, changedPaths, input.objects);
	const appliedPaths: string[] = [];
	const skippedPaths: string[] = [];
	const suppliedLock = input.runtimeLock;
	const lock = suppliedLock ?? claimCompanyRuntimeLock(root);
	try {
		await removeStaleSyncTransactions(root, transaction.transactionRoot);
		const removals = changedPaths
			.filter((path) => !target.has(path))
			.sort((left, right) => right.split("/").length - left.split("/").length);
		for (const path of removals) {
			const appliedEntry = applied.get(path) as CloudCompanyTreeEntry;
			const absolute = logicalPath(root, path);
			const disk = await inspectDiskPath(absolute);
			if (disk.kind === "absent") {
				applied.delete(path);
				appliedPaths.push(path);
				continue;
			}
			if (!diskMatchesEntry(disk, appliedEntry)) {
				skippedPaths.push(path);
				continue;
			}
			if (disk.kind === "directory") {
				if (!(await removeDirectoryIfUnoccupied(absolute))) {
					skippedPaths.push(path);
					continue;
				}
			} else {
				await rm(absolute, { force: true });
			}
			applied.delete(path);
			appliedPaths.push(path);
		}
		const installs = changedPaths.filter((path) => target.has(path));
		for (const path of installs) {
			const targetEntry = target.get(path) as CloudCompanyTreeEntry;
			const appliedEntry = applied.get(path);
			const absolute = logicalPath(root, path);
			const disk = await inspectDiskPath(absolute);
			if (diskMatchesEntry(disk, targetEntry)) {
				applied.set(path, targetEntry);
				appliedPaths.push(path);
				continue;
			}
			if (!diskMatchesEntry(disk, appliedEntry)) {
				skippedPaths.push(path);
				continue;
			}
			if (targetEntry.kind === "directory") {
				if (disk.kind === "file") await rm(absolute, { force: true });
				await mkdir(absolute, { recursive: true });
			} else {
				if (disk.kind === "directory" && !(await removeDirectoryIfUnoccupied(absolute))) {
					skippedPaths.push(path);
					continue;
				}
				await mkdir(dirname(absolute), { recursive: true });
				/* rename replaces an existing file atomically, so a fast-forward
				 * never exposes a missing or half-written path. */
				await rename(logicalPath(transaction.stagedRoot, path), absolute);
			}
			applied.set(path, targetEntry);
			appliedPaths.push(path);
		}
		validateCloudCompanyTreeEntries(
			[...applied.values()].sort((left, right) => comparePath(left.path, right.path)),
			manifest.contractVersion,
		);
		await writeAppliedState(skippedPaths.length === 0);
	} finally {
		if (!suppliedLock) releaseCompanyRuntimeLock(lock);
		await rm(transaction.transactionRoot, { recursive: true, force: true });
	}
	return {
		status: "applied",
		snapshotId: head.snapshotId,
		appliedPaths: appliedPaths.sort(comparePath),
		skippedPaths: skippedPaths.sort(comparePath),
	};
}

/** Prepares the checkout leaf on an already-mounted dataset. The parent must
 * exist: creating it would fabricate a checkout on the VM disk behind an
 * unmounted NAS share instead of failing closed. */
export function initializeCloudCompanyComputerCheckout(companyRoot: string): void {
	const root = resolve(companyRoot);
	try {
		mkdirSync(root);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error("Company computer dataset is not mounted", { cause: error });
		}
		if (code !== "EEXIST") throw error;
	}
	if (!existsSync(join(root, ".git"))) {
		const git = spawnSync("git", ["init"], { cwd: root, stdio: "ignore", shell: false });
		if (git.status !== 0) throw new Error("Company computer checkout could not initialize its Git repository");
	}
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveDelay) => {
		if (signal.aborted) {
			resolveDelay();
			return;
		}
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolveDelay();
		};
		const timer = setTimeout(finish, milliseconds);
		signal.addEventListener("abort", finish, { once: true });
	});
}

export interface RunCloudCompanyComputerSyncAgentInput {
	config: CloudCompanyComputerSyncConfig;
	profileId: string;
	environmentId: string;
	head: CloudCompanyComputerHeadResolver;
	objects: CloudContentAddressedStore;
	signal: AbortSignal;
	onResult?: (result: CloudCompanyComputerSyncResult) => void;
	onError?: (error: unknown) => void;
}

/** The standing poll loop for the Company Computer guest. Sync failures are
 * reported and retried on the next tick: a shed cloud or NAS must never kill
 * the agent while staff keep working on the shared machine. */
export async function runCloudCompanyComputerSyncAgent(input: RunCloudCompanyComputerSyncAgentInput): Promise<void> {
	initializeCloudCompanyComputerCheckout(input.config.companyRoot);
	while (!input.signal.aborted) {
		try {
			const result = await syncCloudCompanyComputerCheckout({
				companyRoot: input.config.companyRoot,
				statePath: input.config.statePath,
				profileId: input.profileId,
				environmentId: input.environmentId,
				head: input.head,
				objects: input.objects,
			});
			input.onResult?.(result);
		} catch (error) {
			if (!input.signal.aborted) input.onError?.(error);
		}
		await abortableDelay(input.config.pollSeconds * 1_000, input.signal);
	}
}
