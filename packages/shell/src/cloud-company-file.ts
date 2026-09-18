import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HostedCompanyFile, HostedCompanySnapshot } from "@qorpera/cloud-client/hosted-primary";
import {
	type CloudCompanyTreeReference,
	captureCloudCompanyTree,
	currentCloudCompanyTreeReference,
} from "@qorpera/cloud-client/node/cloud-company-snapshot";
import type { CloudContentAddressedStore } from "@qorpera/cloud-client/node/cloud-object-store";
import type { CompanyRuntimeLock } from "@qorpera/company/company-runtime-lock";
import { reconcileCloudCompanyCache, recoverInterruptedCloudCompanyMerges } from "./cloud-company-merge.ts";
import { readLegacyCloudCompanyWorkspaceBinding } from "./cloud-company-workspace.ts";
import { type ObjectReachabilityPrimary, publishCompanySnapshotRestoreProof } from "./cloud-object-reachability.ts";

const COMPANY_FILE_CACHE_SCHEMA = "qorpera.cloud-company-file-cache/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECONCILE_ATTEMPTS = 8;

interface PendingCompanyFileRevision {
	clientRevisionId: string;
	expectedHeadSnapshotId?: string;
	tree: CloudCompanyTreeReference;
}

interface AppliedCompanyFileRevision {
	snapshotId: string;
	tree: CloudCompanyTreeReference;
}

export interface CloudCompanyFileConflict {
	baseSnapshotId: string;
	remoteSnapshotId: string;
	paths: string[];
	localTree: CloudCompanyTreeReference;
	createdAt: string;
}

export interface CloudCompanyFileCacheBinding {
	schema: typeof COMPANY_FILE_CACHE_SCHEMA;
	profileId: string;
	environmentId: string;
	root: string;
	createdAt: string;
	applied?: AppliedCompanyFileRevision;
	pending?: PendingCompanyFileRevision;
	conflict?: CloudCompanyFileConflict;
}

export interface CompanyFilePrimary extends ObjectReachabilityPrimary {
	getCompanyFile(environmentId: string): Promise<HostedCompanyFile>;
	prepareCompanyFileRevision(input: {
		environmentId: string;
		clientRevisionId: string;
		expectedHeadSnapshotId?: string;
		tree: CloudCompanyTreeReference;
	}): Promise<HostedCompanySnapshot>;
	publishCompanyFileRevision(
		environmentId: string,
		snapshotId: string,
		expectedHeadSnapshotId?: string,
	): Promise<HostedCompanySnapshot>;
	getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot>;
}

export interface CheckpointCloudCompanyFileInput {
	userData: string;
	companyRoot: string;
	profileId: string;
	environmentId: string;
	primary: CompanyFilePrimary;
	objects: CloudContentAddressedStore;
	runtimeLock?: CompanyRuntimeLock;
	canWrite?: boolean | (() => boolean);
}

export interface CloudCompanyFileCheckpointResult {
	changed: boolean;
	merged: boolean;
	companyFile: HostedCompanyFile;
	snapshot: HostedCompanySnapshot;
}

function canonicalRoot(path: string): string {
	const root = resolve(path);
	return process.platform === "win32" ? root.toLowerCase() : root;
}

function bindingPath(userData: string, profileId: string, root: string): string {
	const rootHash = createHash("sha256").update(canonicalRoot(root)).digest("hex");
	return join(userData, "cloud-company-files", `${profileId}-${rootHash}.json`);
}

function validTree(value: unknown): value is CloudCompanyTreeReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const tree = value as Partial<CloudCompanyTreeReference>;
	return (
		SHA256_PATTERN.test(tree.manifestSha256 ?? "") &&
		Number.isSafeInteger(tree.manifestBytes) &&
		(tree.manifestBytes ?? -1) >= 1 &&
		(tree.contractVersion === 1 || tree.contractVersion === 2 || tree.contractVersion === 3) &&
		Number.isSafeInteger(tree.fileCount) &&
		(tree.fileCount ?? -1) >= 0 &&
		Number.isSafeInteger(tree.totalBytes) &&
		(tree.totalBytes ?? -1) >= 0
	);
}

function parseBinding(
	value: unknown,
	profileId: string,
	environmentId: string,
	root: string,
): CloudCompanyFileCacheBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Company File cache binding is invalid");
	}
	const input = value as Partial<CloudCompanyFileCacheBinding>;
	if (
		input.schema !== COMPANY_FILE_CACHE_SCHEMA ||
		input.profileId !== profileId ||
		input.environmentId !== environmentId ||
		input.root !== canonicalRoot(root) ||
		typeof input.createdAt !== "string" ||
		!Number.isFinite(Date.parse(input.createdAt))
	) {
		throw new Error("Company File cache binding is invalid");
	}
	if (
		input.applied !== undefined &&
		(!UUID_PATTERN.test(input.applied.snapshotId ?? "") || !validTree(input.applied.tree))
	) {
		throw new Error("Applied Company File cache revision is invalid");
	}
	if (
		input.pending !== undefined &&
		(!UUID_PATTERN.test(input.pending.clientRevisionId ?? "") ||
			(input.pending.expectedHeadSnapshotId !== undefined &&
				!UUID_PATTERN.test(input.pending.expectedHeadSnapshotId)) ||
			!validTree(input.pending.tree))
	) {
		throw new Error("Pending Company File cache revision is invalid");
	}
	if (
		input.conflict !== undefined &&
		(!UUID_PATTERN.test(input.conflict.baseSnapshotId ?? "") ||
			!UUID_PATTERN.test(input.conflict.remoteSnapshotId ?? "") ||
			!Array.isArray(input.conflict.paths) ||
			input.conflict.paths.length < 1 ||
			input.conflict.paths.length > 10_000 ||
			!input.conflict.paths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 4096) ||
			!validTree(input.conflict.localTree) ||
			typeof input.conflict.createdAt !== "string" ||
			!Number.isFinite(Date.parse(input.conflict.createdAt)))
	) {
		throw new Error("Company File conflict record is invalid");
	}
	return input as CloudCompanyFileCacheBinding;
}

function sameTree(left: CloudCompanyTreeReference, right: CloudCompanyTreeReference): boolean {
	return (
		left.manifestSha256 === right.manifestSha256 &&
		left.manifestBytes === right.manifestBytes &&
		left.contractVersion === right.contractVersion &&
		left.fileCount === right.fileCount &&
		left.totalBytes === right.totalBytes
	);
}

function writeAtomic(path: string, binding: CloudCompanyFileCacheBinding): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx");
		writeFileSync(descriptor, `${JSON.stringify(binding, null, "\t")}\n`, "utf-8");
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
		throw error;
	}
}

export class CloudCompanyFileCacheState {
	readonly #path: string;
	#binding: CloudCompanyFileCacheBinding;

	private constructor(path: string, binding: CloudCompanyFileCacheBinding) {
		this.#path = path;
		this.#binding = binding;
	}

	static open(userData: string, profileId: string, environmentId: string, root: string): CloudCompanyFileCacheState {
		const path = bindingPath(userData, profileId, root);
		const normalizedRoot = canonicalRoot(root);
		if (existsSync(path)) {
			return new CloudCompanyFileCacheState(
				path,
				parseBinding(JSON.parse(readFileSync(path, "utf-8")), profileId, environmentId, normalizedRoot),
			);
		}
		const binding: CloudCompanyFileCacheBinding = {
			schema: COMPANY_FILE_CACHE_SCHEMA,
			profileId,
			environmentId,
			root: normalizedRoot,
			createdAt: new Date().toISOString(),
		};
		const legacy = readLegacyCloudCompanyWorkspaceBinding(userData, profileId, environmentId, normalizedRoot);
		if (legacy?.lastCheckpoint) {
			binding.applied = {
				snapshotId: legacy.lastCheckpoint.snapshotId,
				tree: legacy.lastCheckpoint.tree,
			};
		}
		writeAtomic(path, binding);
		return new CloudCompanyFileCacheState(path, binding);
	}

	get binding(): Readonly<CloudCompanyFileCacheBinding> {
		return this.#binding;
	}

	stage(tree: CloudCompanyTreeReference, expectedHeadSnapshotId?: string): PendingCompanyFileRevision {
		if (this.#binding.pending) return this.#binding.pending;
		const pending: PendingCompanyFileRevision = {
			clientRevisionId: randomUUID(),
			...(expectedHeadSnapshotId ? { expectedHeadSnapshotId } : {}),
			tree,
		};
		this.#binding = { ...this.#binding, pending };
		writeAtomic(this.#path, this.#binding);
		return pending;
	}

	adopt(snapshot: HostedCompanySnapshot): void {
		if (snapshot.profileId !== this.#binding.profileId || snapshot.environmentId !== this.#binding.environmentId) {
			throw new Error("Company File revision is outside this cache");
		}
		if (this.#binding.pending) throw new Error("Company File cache has a pending revision");
		this.#binding = {
			...this.#binding,
			applied: {
				snapshotId: snapshot.snapshotId,
				tree: currentCloudCompanyTreeReference(snapshot.tree),
			},
		};
		writeAtomic(this.#path, this.#binding);
	}

	complete(clientRevisionId: string, snapshot: HostedCompanySnapshot): void {
		if (!this.#binding.pending || this.#binding.pending.clientRevisionId !== clientRevisionId) {
			throw new Error("Company File revision completion is stale");
		}
		const { pending: _pending, ...binding } = this.#binding;
		this.#binding = binding;
		this.adopt(snapshot);
	}

	discard(clientRevisionId: string): void {
		if (!this.#binding.pending || this.#binding.pending.clientRevisionId !== clientRevisionId) {
			throw new Error("Company File revision discard is stale");
		}
		const { pending: _pending, ...binding } = this.#binding;
		this.#binding = binding;
		writeAtomic(this.#path, this.#binding);
	}

	recordConflict(conflict: Omit<CloudCompanyFileConflict, "createdAt">): void {
		if (this.#binding.pending) throw new Error("Company File cache has a pending revision");
		this.#binding = {
			...this.#binding,
			conflict: { ...conflict, paths: [...new Set(conflict.paths)].sort(), createdAt: new Date().toISOString() },
		};
		writeAtomic(this.#path, this.#binding);
	}

	resolveConflictAgainst(remote: HostedCompanySnapshot): void {
		const conflict = this.#binding.conflict;
		if (!conflict || conflict.remoteSnapshotId !== remote.snapshotId) {
			throw new Error("Company File conflict changed before review completed");
		}
		const { conflict: _conflict, ...binding } = this.#binding;
		this.#binding = binding;
		this.adopt(remote);
	}
}

export function readCloudCompanyFileConflict(
	userData: string,
	profileId: string,
	environmentId: string,
	root: string,
): CloudCompanyFileConflict | undefined {
	return CloudCompanyFileCacheState.open(userData, profileId, environmentId, root).binding.conflict;
}

function requireCompanyFileScope(file: HostedCompanyFile, input: CheckpointCloudCompanyFileInput): void {
	if (file.profileId !== input.profileId || file.environmentId !== input.environmentId) {
		throw new Error("Company File is outside this company");
	}
}

function isHeadConflict(error: unknown): boolean {
	return error instanceof Error && /\(PT409\)$/.test(error.message);
}

function isMissingCloudObject(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { message?: unknown; status?: unknown; statusCode?: unknown };
	return (
		candidate.status === 404 ||
		candidate.statusCode === "404" ||
		(typeof candidate.message === "string" &&
			/(?:object|manifest|chunk).*(?:not found|missing)|(?:not found|missing).*(?:object|manifest|chunk)/i.test(
				candidate.message,
			))
	);
}

function canWrite(input: CheckpointCloudCompanyFileInput): boolean {
	return typeof input.canWrite === "function" ? input.canWrite() : input.canWrite !== false;
}

export async function checkpointCloudCompanyFile(
	input: CheckpointCloudCompanyFileInput,
): Promise<CloudCompanyFileCheckpointResult> {
	await recoverInterruptedCloudCompanyMerges(input.companyRoot, input.runtimeLock);
	const state = CloudCompanyFileCacheState.open(
		input.userData,
		input.profileId,
		input.environmentId,
		input.companyRoot,
	);
	if (state.binding.conflict) {
		throw new Error(`Company File has ${state.binding.conflict.paths.length} change conflict(s) waiting for review`);
	}
	let changed = false;
	let merged = false;
	let reuploadedPendingRevisionId: string | undefined;
	for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
		let companyFile = await input.primary.getCompanyFile(input.environmentId);
		requireCompanyFileScope(companyFile, input);
		if (!companyFile.headSnapshotId && !state.binding.applied) {
			throw new Error("Canonical Company File cloud bootstrap is still provisioning");
		}
		const pending = state.binding.pending;
		if (pending) {
			try {
				const prepared = await input.primary.prepareCompanyFileRevision({
					environmentId: input.environmentId,
					clientRevisionId: pending.clientRevisionId,
					...(pending.expectedHeadSnapshotId ? { expectedHeadSnapshotId: pending.expectedHeadSnapshotId } : {}),
					tree: pending.tree,
				});
				await publishCompanySnapshotRestoreProof(prepared, input.objects, input.primary);
				const snapshot = await input.primary.publishCompanyFileRevision(
					input.environmentId,
					prepared.snapshotId,
					pending.expectedHeadSnapshotId,
				);
				state.complete(pending.clientRevisionId, snapshot);
				changed = true;
				companyFile = await input.primary.getCompanyFile(input.environmentId);
				requireCompanyFileScope(companyFile, input);
				// A durable pending revision can predate newer local bytes. Publishing
				// it repairs the interrupted transaction, but it is not a checkpoint
				// of the current checkout until the loop captures and compares again.
				continue;
			} catch (error) {
				if (isMissingCloudObject(error) && reuploadedPendingRevisionId !== pending.clientRevisionId) {
					// Prepared revisions are intentionally resumable, but their abandoned
					// object upload may have aged out while this device was offline. Capture
					// re-uploads the exact closure when the checkout is unchanged. If newer
					// bytes exist, the old pending transaction is obsolete and a fresh
					// revision will be staged from those current bytes on the next pass.
					const current = await captureCloudCompanyTree(input.companyRoot, input.profileId, input.objects, {
						...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
						userData: input.userData,
						forceFullVerification: true,
					});
					if (sameTree(current, pending.tree)) {
						reuploadedPendingRevisionId = pending.clientRevisionId;
						continue;
					}
					state.discard(pending.clientRevisionId);
					continue;
				}
				if (!isHeadConflict(error)) throw error;
				state.discard(pending.clientRevisionId);
			}
		}

		const tree = await captureCloudCompanyTree(input.companyRoot, input.profileId, input.objects, {
			...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
			userData: input.userData,
		});
		const applied = state.binding.applied;
		if (!applied) {
			if (companyFile.headSnapshotId) {
				const remote = await input.primary.getCompanySnapshot(companyFile.headSnapshotId);
				if (!sameTree(currentCloudCompanyTreeReference(remote.tree), tree)) {
					throw new Error("This cache was not materialized from the canonical Company File revision");
				}
				state.adopt(remote);
				return { changed, merged, companyFile, snapshot: remote };
			}
			if (!canWrite(input)) throw new Error("This Company File is read-only for your account");
			state.stage(tree);
			continue;
		}

		if (companyFile.headSnapshotId === applied.snapshotId) {
			if (sameTree(applied.tree, tree)) {
				return {
					changed,
					merged,
					companyFile,
					snapshot: await input.primary.getCompanySnapshot(applied.snapshotId),
				};
			}
			if (!canWrite(input)) throw new Error("This Company File is read-only for your account");
			state.stage(tree, applied.snapshotId);
			continue;
		}
		if (!companyFile.headSnapshotId) {
			throw new Error("Canonical Company File lost its applied head");
		}

		const remote = await input.primary.getCompanySnapshot(companyFile.headSnapshotId);
		const reconciliation = await reconcileCloudCompanyCache({
			companyRoot: input.companyRoot,
			profileId: input.profileId,
			environmentId: input.environmentId,
			baseSnapshotId: applied.snapshotId,
			localTree: tree,
			remoteSnapshotId: remote.snapshotId,
			primary: input.primary,
			objects: input.objects,
			...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
		});
		if (reconciliation.plan.conflicts.length > 0) {
			const reviewedTree = reconciliation.applied
				? await captureCloudCompanyTree(input.companyRoot, input.profileId, input.objects, {
						...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
						userData: input.userData,
					})
				: tree;
			state.recordConflict({
				baseSnapshotId: applied.snapshotId,
				remoteSnapshotId: remote.snapshotId,
				paths: reconciliation.plan.conflicts.map((conflict) => conflict.path),
				localTree: reviewedTree,
			});
			throw new Error(
				`Company File has ${reconciliation.plan.conflicts.length} change conflict(s) waiting for review`,
			);
		}
		merged ||= reconciliation.applied || reconciliation.plan.conflicts.length > 0;
		state.adopt(remote);
	}
	throw new Error("Company File changed repeatedly while this cache was synchronizing");
}
