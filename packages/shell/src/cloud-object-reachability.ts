import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { currentCloudCompanyTreeReference, verifyCloudCompanyTreeRestore } from "./cloud-company-snapshot.ts";
import type { CloudContentAddressedStore, CloudReachableObject } from "./cloud-object-store.ts";
import type {
	HostedArtifact,
	HostedCompanySnapshot,
	HostedObjectReachabilityGraph,
	HostedObjectRestoreProof,
	HostedObjectRootKind,
	QorperaHostedPrimary,
} from "./hosted-primary.ts";

const REACHABILITY_BATCH_SIZE = 500;
const REACHABILITY_STATE_SCHEMA = "qorpera.object-reachability-state/v1";
const RESTORE_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ObjectReachabilityPrimary = Pick<
	QorperaHostedPrimary,
	| "appendObjectReachabilityEntries"
	| "beginObjectReachabilityGraph"
	| "completeObjectReachabilityGraph"
	| "createObjectRestoreProof"
>;

export interface PublishedObjectRestoreProof {
	graph: HostedObjectReachabilityGraph;
	proof: HostedObjectRestoreProof;
}

interface VerifiedObjectRoot {
	rootKind: HostedObjectRootKind;
	rootId: string;
	rootObjectSha256: string;
	restoredContentSha256: string;
	restoredBytes: number;
	objects: CloudReachableObject[];
}

interface ObjectReachabilityState {
	schema: typeof REACHABILITY_STATE_SCHEMA;
	profileId: string;
	companyRoot: string;
	proofValidUntilBySnapshotId: Record<string, string>;
}

export interface PublishCompanySnapshotRestoreProofIfDueOptions {
	userData: string;
	companyRoot: string;
	snapshot: HostedCompanySnapshot;
	store: CloudContentAddressedStore;
	primary: ObjectReachabilityPrimary;
	now?: Date;
}

function canonicalObjects(objects: CloudReachableObject[]): CloudReachableObject[] {
	const unique = new Map<string, number>();
	for (const object of objects) {
		const existing = unique.get(object.sha256);
		if (existing !== undefined && existing !== object.bytes) {
			throw new Error("Object reachability contains inconsistent object sizes");
		}
		unique.set(object.sha256, object.bytes);
	}
	return [...unique.entries()]
		.map(([objectSha256, bytes]) => ({ sha256: objectSha256, bytes }))
		.sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
}

function reachabilityHash(objects: CloudReachableObject[]): string {
	return createHash("sha256")
		.update(objects.map((object) => `${object.sha256}:${object.bytes}`).join("\n"))
		.digest("hex");
}

function deterministicUuid(value: string): string {
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 32);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

function dailyProofId(rootKind: HostedObjectRootKind, rootId: string, now = new Date()): string {
	const day = now.toISOString().slice(0, 10);
	return deterministicUuid(`qorpera.restore-proof/v1:${rootKind}:${rootId}:${day}`);
}

async function publishVerifiedRoot(
	root: VerifiedObjectRoot,
	primary: ObjectReachabilityPrimary,
): Promise<PublishedObjectRestoreProof> {
	const objects = canonicalObjects(root.objects);
	if (!objects.some((object) => object.sha256 === root.rootObjectSha256)) {
		throw new Error("Object reachability does not contain its root object");
	}
	const storageBytes = objects.reduce((total, object) => total + object.bytes, 0);
	if (!Number.isSafeInteger(storageBytes)) throw new Error("Object reachability storage size is unsafe");
	let graph = await primary.beginObjectReachabilityGraph({
		rootKind: root.rootKind,
		rootId: root.rootId,
		clientGraphId: deterministicUuid(`qorpera.object-graph/v1:${root.rootKind}:${root.rootId}`),
		rootObjectSha256: root.rootObjectSha256,
		contentSha256: reachabilityHash(objects),
		objectCount: objects.length,
		storageBytes,
	});
	if (graph.status === "uploading") {
		for (let offset = 0; offset < objects.length; offset += REACHABILITY_BATCH_SIZE) {
			await primary.appendObjectReachabilityEntries(
				graph.graphId,
				objects.slice(offset, offset + REACHABILITY_BATCH_SIZE),
			);
		}
		graph = await primary.completeObjectReachabilityGraph(graph.graphId);
	}
	if (graph.status !== "complete") throw new Error("Object reachability graph did not complete");
	const proof = await primary.createObjectRestoreProof(
		graph.graphId,
		dailyProofId(root.rootKind, root.rootId),
		root.restoredContentSha256,
		root.restoredBytes,
	);
	return { graph, proof };
}

export async function publishCompanySnapshotRestoreProof(
	snapshot: HostedCompanySnapshot,
	store: CloudContentAddressedStore,
	primary: ObjectReachabilityPrimary,
): Promise<PublishedObjectRestoreProof> {
	const reference = currentCloudCompanyTreeReference(snapshot.tree);
	const restored = await verifyCloudCompanyTreeRestore(snapshot.profileId, reference, store);
	return publishVerifiedRoot(
		{
			rootKind: "company_snapshot",
			rootId: snapshot.snapshotId,
			rootObjectSha256: reference.manifestSha256,
			...restored,
		},
		primary,
	);
}

export async function publishCompanySnapshotRestoreProofIfDue(
	options: PublishCompanySnapshotRestoreProofIfDueOptions,
): Promise<PublishedObjectRestoreProof | undefined> {
	const companyRoot = resolve(options.companyRoot);
	const rootHash = createHash("sha256")
		.update(process.platform === "win32" ? companyRoot.toLowerCase() : companyRoot)
		.digest("hex")
		.slice(0, 24);
	const statePath = join(
		options.userData,
		"cloud-object-reachability",
		`${options.snapshot.profileId}-${rootHash}.json`,
	);
	let state: ObjectReachabilityState = {
		schema: REACHABILITY_STATE_SCHEMA,
		profileId: options.snapshot.profileId,
		companyRoot,
		proofValidUntilBySnapshotId: {},
	};
	try {
		const value: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const candidate = value as Partial<ObjectReachabilityState>;
			if (
				candidate.schema === REACHABILITY_STATE_SCHEMA &&
				candidate.profileId === options.snapshot.profileId &&
				candidate.companyRoot === companyRoot &&
				candidate.proofValidUntilBySnapshotId &&
				typeof candidate.proofValidUntilBySnapshotId === "object" &&
				!Array.isArray(candidate.proofValidUntilBySnapshotId)
			) {
				const validProofs: Record<string, string> = {};
				for (const [snapshotId, validUntil] of Object.entries(candidate.proofValidUntilBySnapshotId)) {
					if (
						/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId) &&
						typeof validUntil === "string" &&
						Number.isFinite(Date.parse(validUntil))
					) {
						validProofs[snapshotId] = validUntil;
					}
				}
				state = { ...state, proofValidUntilBySnapshotId: validProofs };
			}
		}
	} catch {
		// Missing or invalid advisory state causes a fresh verified restore.
	}
	const now = options.now ?? new Date();
	const validUntil = state.proofValidUntilBySnapshotId[options.snapshot.snapshotId];
	if (validUntil && Date.parse(validUntil) > now.getTime() + RESTORE_REFRESH_WINDOW_MS) return undefined;

	const published = await publishCompanySnapshotRestoreProof(options.snapshot, options.store, options.primary);
	state.proofValidUntilBySnapshotId[options.snapshot.snapshotId] = published.proof.validUntil;
	for (const [snapshotId, expiry] of Object.entries(state.proofValidUntilBySnapshotId)) {
		if (Date.parse(expiry) <= now.getTime()) delete state.proofValidUntilBySnapshotId[snapshotId];
	}
	const temporary = `${statePath}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, statePath);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return published;
}

export async function publishArtifactRestoreProof(
	artifact: HostedArtifact,
	store: CloudContentAddressedStore,
	primary: ObjectReachabilityPrimary,
): Promise<PublishedObjectRestoreProof> {
	if (artifact.rootContract === "qorpera.object/v1") {
		const bytes = await store.getObject(artifact.profileId, {
			sha256: artifact.rootObjectSha256,
			bytes: artifact.bytes,
			mediaType: artifact.mediaType,
		});
		return publishVerifiedRoot(
			{
				rootKind: "artifact",
				rootId: artifact.artifactId,
				rootObjectSha256: artifact.rootObjectSha256,
				restoredContentSha256: artifact.contentSha256,
				restoredBytes: bytes.byteLength,
				objects: [{ sha256: artifact.rootObjectSha256, bytes: bytes.byteLength }],
			},
			primary,
		);
	}
	const restored = await store.restoreFile(artifact.profileId, {
		manifestSha256: artifact.rootObjectSha256,
		fileSha256: artifact.contentSha256,
		bytes: artifact.bytes,
		mediaType: artifact.mediaType,
	});
	return publishVerifiedRoot(
		{
			rootKind: "artifact",
			rootId: artifact.artifactId,
			rootObjectSha256: artifact.rootObjectSha256,
			restoredContentSha256: artifact.contentSha256,
			restoredBytes: restored.bytes.byteLength,
			objects: restored.objects,
		},
		primary,
	);
}
