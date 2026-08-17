import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CompanyRuntimeLock } from "@qorpera/pi-coding-agent/company";
import {
	type CloudCompanyTreeReference,
	captureCloudCompanyTree,
	currentCloudCompanyTreeReference,
} from "./cloud-company-snapshot.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { HostedCompanySnapshot, HostedCompanyWorkspace } from "./hosted-primary.ts";

const WORKSPACE_BINDING_SCHEMA = "qorpera.cloud-company-workspace/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface PendingCompanyCheckpoint {
	clientSnapshotId: string;
	expectedHeadSnapshotId?: string;
	tree: CloudCompanyTreeReference;
}

interface CompletedCompanyCheckpoint {
	snapshotId: string;
	tree: CloudCompanyTreeReference;
}

export interface CloudCompanyWorkspaceBinding {
	schema: typeof WORKSPACE_BINDING_SCHEMA;
	profileId: string;
	environmentId: string;
	root: string;
	clientWorkspaceId: string;
	createdAt: string;
	lastCheckpoint?: CompletedCompanyCheckpoint;
	pending?: PendingCompanyCheckpoint;
}

export interface CompanyWorkspacePrimary {
	ensureCompanyWorkspace(input: {
		environmentId: string;
		clientWorkspaceId: string;
		name: string;
		baseSnapshotId?: string;
	}): Promise<HostedCompanyWorkspace>;
	commitCompanySnapshot(input: {
		workspaceId: string;
		clientSnapshotId: string;
		expectedHeadSnapshotId?: string;
		tree: CloudCompanyTreeReference;
	}): Promise<HostedCompanySnapshot>;
	getCompanySnapshot(snapshotId: string): Promise<HostedCompanySnapshot>;
}

export interface CheckpointCloudCompanyWorkspaceInput {
	userData: string;
	companyRoot: string;
	profileId: string;
	environmentId: string;
	workspaceName: string;
	baseSnapshotId?: string;
	primary: CompanyWorkspacePrimary;
	objects: CloudContentAddressedStore;
	runtimeLock?: CompanyRuntimeLock;
}

function canonicalRoot(path: string): string {
	const root = resolve(path);
	return process.platform === "win32" ? root.toLowerCase() : root;
}

function bindingPath(userData: string, profileId: string, root: string): string {
	const rootHash = createHash("sha256").update(canonicalRoot(root)).digest("hex");
	return join(userData, "cloud-company-workspaces", `${profileId}-${rootHash}.json`);
}

function validTree(value: unknown): value is CloudCompanyTreeReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const tree = value as Partial<CloudCompanyTreeReference>;
	return (
		SHA256_PATTERN.test(tree.manifestSha256 ?? "") &&
		Number.isSafeInteger(tree.manifestBytes) &&
		(tree.manifestBytes ?? -1) >= 0 &&
		tree.contractVersion === 1 &&
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
): CloudCompanyWorkspaceBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Cloud company workspace binding is invalid");
	}
	const input = value as Partial<CloudCompanyWorkspaceBinding>;
	if (
		input.schema !== WORKSPACE_BINDING_SCHEMA ||
		input.profileId !== profileId ||
		input.environmentId !== environmentId ||
		input.root !== canonicalRoot(root) ||
		!UUID_PATTERN.test(input.clientWorkspaceId ?? "") ||
		typeof input.createdAt !== "string" ||
		!Number.isFinite(Date.parse(input.createdAt))
	) {
		throw new Error("Cloud company workspace binding is invalid");
	}
	if (input.pending !== undefined) {
		if (
			!input.pending ||
			!UUID_PATTERN.test(input.pending.clientSnapshotId) ||
			(input.pending.expectedHeadSnapshotId !== undefined &&
				!UUID_PATTERN.test(input.pending.expectedHeadSnapshotId)) ||
			!validTree(input.pending.tree)
		) {
			throw new Error("Cloud company workspace pending checkpoint is invalid");
		}
	}
	if (
		input.lastCheckpoint !== undefined &&
		(!input.lastCheckpoint ||
			!UUID_PATTERN.test(input.lastCheckpoint.snapshotId) ||
			!validTree(input.lastCheckpoint.tree))
	) {
		throw new Error("Cloud company workspace completed checkpoint is invalid");
	}
	return input as CloudCompanyWorkspaceBinding;
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

function writeAtomic(path: string, binding: CloudCompanyWorkspaceBinding): void {
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

export class CloudCompanyWorkspaceState {
	readonly #path: string;
	#binding: CloudCompanyWorkspaceBinding;

	private constructor(path: string, binding: CloudCompanyWorkspaceBinding) {
		this.#path = path;
		this.#binding = binding;
	}

	static open(userData: string, profileId: string, environmentId: string, root: string): CloudCompanyWorkspaceState {
		const path = bindingPath(userData, profileId, root);
		const normalizedRoot = canonicalRoot(root);
		if (existsSync(path)) {
			const binding = parseBinding(
				JSON.parse(readFileSync(path, "utf-8")),
				profileId,
				environmentId,
				normalizedRoot,
			);
			return new CloudCompanyWorkspaceState(path, binding);
		}
		const binding: CloudCompanyWorkspaceBinding = {
			schema: WORKSPACE_BINDING_SCHEMA,
			profileId,
			environmentId,
			root: normalizedRoot,
			clientWorkspaceId: randomUUID(),
			createdAt: new Date().toISOString(),
		};
		writeAtomic(path, binding);
		return new CloudCompanyWorkspaceState(path, binding);
	}

	get binding(): Readonly<CloudCompanyWorkspaceBinding> {
		return this.#binding;
	}

	stage(tree: CloudCompanyTreeReference, expectedHeadSnapshotId?: string): PendingCompanyCheckpoint {
		if (this.#binding.pending) return this.#binding.pending;
		const pending: PendingCompanyCheckpoint = {
			clientSnapshotId: randomUUID(),
			...(expectedHeadSnapshotId ? { expectedHeadSnapshotId } : {}),
			tree,
		};
		this.#binding = { ...this.#binding, pending };
		writeAtomic(this.#path, this.#binding);
		return pending;
	}

	adopt(snapshot: HostedCompanySnapshot): void {
		if (this.#binding.pending) throw new Error("Cloud company workspace has a pending checkpoint");
		this.#binding = {
			...this.#binding,
			lastCheckpoint: {
				snapshotId: snapshot.snapshotId,
				tree: currentCloudCompanyTreeReference(snapshot.tree),
			},
		};
		writeAtomic(this.#path, this.#binding);
	}

	complete(clientSnapshotId: string, snapshot: HostedCompanySnapshot): void {
		if (!this.#binding.pending || this.#binding.pending.clientSnapshotId !== clientSnapshotId) {
			throw new Error("Cloud company workspace checkpoint completion is stale");
		}
		const { pending: _pending, ...binding } = this.#binding;
		this.#binding = {
			...binding,
			lastCheckpoint: {
				snapshotId: snapshot.snapshotId,
				tree: currentCloudCompanyTreeReference(snapshot.tree),
			},
		};
		writeAtomic(this.#path, this.#binding);
	}
}

export async function checkpointCloudCompanyWorkspace(
	input: CheckpointCloudCompanyWorkspaceInput,
): Promise<{ changed: boolean; workspace: HostedCompanyWorkspace; snapshot: HostedCompanySnapshot }> {
	const state = CloudCompanyWorkspaceState.open(
		input.userData,
		input.profileId,
		input.environmentId,
		input.companyRoot,
	);
	const workspace = await input.primary.ensureCompanyWorkspace({
		environmentId: input.environmentId,
		clientWorkspaceId: state.binding.clientWorkspaceId,
		name: input.workspaceName,
		...(input.baseSnapshotId ? { baseSnapshotId: input.baseSnapshotId } : {}),
	});
	if (state.binding.pending) {
		const pending = state.binding.pending;
		const snapshot = await input.primary.commitCompanySnapshot({
			workspaceId: workspace.workspaceId,
			clientSnapshotId: pending.clientSnapshotId,
			...(pending.expectedHeadSnapshotId ? { expectedHeadSnapshotId: pending.expectedHeadSnapshotId } : {}),
			tree: pending.tree,
		});
		state.complete(pending.clientSnapshotId, snapshot);
		return {
			changed: true,
			workspace: { ...workspace, headSnapshotId: snapshot.snapshotId, updatedAt: snapshot.createdAt },
			snapshot,
		};
	}
	const tree = await captureCloudCompanyTree(input.companyRoot, input.profileId, input.objects, {
		...(input.runtimeLock ? { runtimeLock: input.runtimeLock } : {}),
	});
	const completed = state.binding.lastCheckpoint;
	if (completed) {
		if (workspace.headSnapshotId !== completed.snapshotId) {
			throw new Error("Cloud company workspace head changed on another computer");
		}
		if (sameTree(completed.tree, tree)) {
			return {
				changed: false,
				workspace,
				snapshot: await input.primary.getCompanySnapshot(completed.snapshotId),
			};
		}
	} else if (workspace.headSnapshotId) {
		const remoteHead = await input.primary.getCompanySnapshot(workspace.headSnapshotId);
		if (sameTree(currentCloudCompanyTreeReference(remoteHead.tree), tree)) {
			state.adopt(remoteHead);
			return { changed: false, workspace, snapshot: remoteHead };
		}
		if (input.baseSnapshotId !== workspace.headSnapshotId) {
			throw new Error("Cloud company workspace head exists without a matching local checkpoint");
		}
	}
	const pending = state.stage(tree, workspace.headSnapshotId);
	const snapshot = await input.primary.commitCompanySnapshot({
		workspaceId: workspace.workspaceId,
		clientSnapshotId: pending.clientSnapshotId,
		...(pending.expectedHeadSnapshotId ? { expectedHeadSnapshotId: pending.expectedHeadSnapshotId } : {}),
		tree: pending.tree,
	});
	state.complete(pending.clientSnapshotId, snapshot);
	return {
		changed: true,
		workspace: { ...workspace, headSnapshotId: snapshot.snapshotId, updatedAt: snapshot.createdAt },
		snapshot,
	};
}
