import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
	HostedArtifactIndex,
	HostedArtifactIndexEntry,
	HostedCompanyOperation,
	HostedCompanySnapshot,
	HostedCompanySubstrateVersion,
	QorperaHostedPrimary,
} from "./hosted-primary.ts";

const CLOUD_COMPANY_SUBSTRATE_STATE_SCHEMA = "qorpera.cloud-company-substrate/v2";

export type CompanySubstratePrimary = Pick<
	QorperaHostedPrimary,
	| "captureCompanySubstrateVersion"
	| "createArtifactIndex"
	| "getCompanySnapshot"
	| "getCompanySubstrateVersion"
	| "getArtifactIndex"
	| "listArtifactIndexEntries"
	| "listCompanySubstrateOperations"
>;

interface SubstratePublicationState {
	clientArtifactIndexId: string;
	artifactIndexId?: string;
	clientVersionId: string;
	versionId?: string;
}

interface CloudCompanySubstrateState {
	schema: typeof CLOUD_COMPANY_SUBSTRATE_STATE_SCHEMA;
	profileId: string;
	environmentId: string;
	root: string;
	publications: Record<string, SubstratePublicationState>;
}

export interface CloudCompanySubstrateOptions {
	userData: string;
	companyRoot: string;
	profileId: string;
	environmentId: string;
	primary: CompanySubstratePrimary;
}

export interface ResolvedCompanySubstrateReference {
	version: HostedCompanySubstrateVersion;
	snapshot: HostedCompanySnapshot;
	artifactIndex?: HostedArtifactIndex;
}

function normalizedRoot(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function cloudCompanySubstrateStatePath(userData: string, root: string, profileId: string): string {
	const rootHash = createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 24);
	return join(userData, "cloud-company-substrate", `${profileId}-${rootHash}.json`);
}

function emptyState(options: CloudCompanySubstrateOptions): CloudCompanySubstrateState {
	return {
		schema: CLOUD_COMPANY_SUBSTRATE_STATE_SCHEMA,
		profileId: options.profileId,
		environmentId: options.environmentId,
		root: normalizedRoot(options.companyRoot),
		publications: {},
	};
}

function validUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	);
}

function artifactSetHash(artifactIds: string[]): string {
	return createHash("sha256").update(JSON.stringify(artifactIds)).digest("hex");
}

function publicationKey(snapshotId: string, artifactIds: string[]): string {
	return `${snapshotId}:${artifactSetHash(artifactIds)}`;
}

function readState(path: string, options: CloudCompanySubstrateOptions): CloudCompanySubstrateState {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState(options);
		const input = value as Partial<CloudCompanySubstrateState>;
		if (
			input.schema !== CLOUD_COMPANY_SUBSTRATE_STATE_SCHEMA ||
			input.profileId !== options.profileId ||
			input.environmentId !== options.environmentId ||
			input.root !== normalizedRoot(options.companyRoot) ||
			!input.publications ||
			typeof input.publications !== "object" ||
			Array.isArray(input.publications)
		) {
			return emptyState(options);
		}
		const publications: Record<string, SubstratePublicationState> = {};
		for (const [key, candidate] of Object.entries(input.publications)) {
			const separator = key.indexOf(":");
			if (separator === -1 || key.indexOf(":", separator + 1) !== -1) continue;
			const snapshotId = key.slice(0, separator);
			const artifactIdsHash = key.slice(separator + 1);
			if (!validUuid(snapshotId) || !/^[0-9a-f]{64}$/i.test(artifactIdsHash)) continue;
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
			const publication = candidate as Partial<SubstratePublicationState>;
			if (!validUuid(publication.clientArtifactIndexId) || !validUuid(publication.clientVersionId)) continue;
			if (publication.artifactIndexId !== undefined && !validUuid(publication.artifactIndexId)) continue;
			if (publication.versionId !== undefined && !validUuid(publication.versionId)) continue;
			publications[key] = {
				clientArtifactIndexId: publication.clientArtifactIndexId,
				...(publication.artifactIndexId ? { artifactIndexId: publication.artifactIndexId } : {}),
				clientVersionId: publication.clientVersionId,
				...(publication.versionId ? { versionId: publication.versionId } : {}),
			};
		}
		return { ...emptyState(options), publications };
	} catch {
		return emptyState(options);
	}
}

function writeState(path: string, state: CloudCompanySubstrateState): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export class CloudCompanySubstrate {
	readonly #options: CloudCompanySubstrateOptions;
	readonly #statePath: string;
	#inFlight = new Map<string, Promise<HostedCompanySubstrateVersion>>();

	constructor(options: CloudCompanySubstrateOptions) {
		this.#options = options;
		this.#statePath = cloudCompanySubstrateStatePath(options.userData, options.companyRoot, options.profileId);
	}

	publish(snapshot: HostedCompanySnapshot, artifactIds: string[] = []): Promise<HostedCompanySubstrateVersion> {
		const canonicalArtifactIds = [...artifactIds].sort();
		if (new Set(canonicalArtifactIds).size !== canonicalArtifactIds.length) {
			return Promise.reject(new Error("Company substrate artifact index contains duplicate ids"));
		}
		const key = publicationKey(snapshot.snapshotId, canonicalArtifactIds);
		const existing = this.#inFlight.get(key);
		if (existing) return existing;
		const operation = this.#publishOnce(snapshot, canonicalArtifactIds, key).finally(() => {
			if (this.#inFlight.get(key) === operation) this.#inFlight.delete(key);
		});
		this.#inFlight.set(key, operation);
		return operation;
	}

	async #publishOnce(
		snapshot: HostedCompanySnapshot,
		artifactIds: string[],
		key: string,
	): Promise<HostedCompanySubstrateVersion> {
		this.#requireSnapshotScope(snapshot);
		const state = readState(this.#statePath, this.#options);
		let publication = state.publications[key];
		if (!publication) {
			publication = { clientArtifactIndexId: randomUUID(), clientVersionId: randomUUID() };
			state.publications[key] = publication;
			writeState(this.#statePath, state);
		}
		const artifactIndex = publication.artifactIndexId
			? await this.#options.primary.getArtifactIndex(publication.artifactIndexId)
			: await this.#options.primary.createArtifactIndex({
					environmentId: this.#options.environmentId,
					clientIndexId: publication.clientArtifactIndexId,
					artifactIds,
				});
		this.#requireArtifactIndexScope(artifactIndex, publication.clientArtifactIndexId, artifactIds.length);
		if (publication.artifactIndexId !== artifactIndex.indexId) {
			publication.artifactIndexId = artifactIndex.indexId;
			writeState(this.#statePath, state);
		}

		const version = publication.versionId
			? await this.#options.primary.getCompanySubstrateVersion(publication.versionId)
			: await this.#options.primary.captureCompanySubstrateVersion({
					snapshotId: snapshot.snapshotId,
					clientVersionId: publication.clientVersionId,
					artifactIndexId: artifactIndex.indexId,
				});
		this.#requireVersionScope(version, snapshot.snapshotId, publication.clientVersionId, artifactIndex.indexId);
		if (publication.versionId !== version.versionId) {
			publication.versionId = version.versionId;
			writeState(this.#statePath, state);
		}
		return version;
	}

	async resolve(versionId: string): Promise<ResolvedCompanySubstrateReference> {
		const version = await this.#options.primary.getCompanySubstrateVersion(versionId);
		this.#requireVersionScope(version);
		const snapshot = await this.#options.primary.getCompanySnapshot(version.companySnapshotId);
		this.#requireSnapshotScope(snapshot);
		if (!version.artifactIndexId) return { version, snapshot };
		const artifactIndex = await this.#options.primary.getArtifactIndex(version.artifactIndexId);
		this.#requireArtifactIndexScope(artifactIndex);
		return { version, snapshot, artifactIndex };
	}

	async listArtifacts(index: HostedArtifactIndex, afterOrdinal = 0, limit = 200): Promise<HostedArtifactIndexEntry[]> {
		this.#requireArtifactIndexScope(index);
		return this.#options.primary.listArtifactIndexEntries(index.indexId, afterOrdinal, limit);
	}

	async listOperations(
		version: HostedCompanySubstrateVersion,
		afterSequence = 0,
		limit = 200,
	): Promise<HostedCompanyOperation[]> {
		this.#requireVersionScope(version);
		const operations = await this.#options.primary.listCompanySubstrateOperations(
			version.versionId,
			afterSequence,
			limit,
		);
		let previousSequence = afterSequence;
		for (const operation of operations) {
			if (
				operation.profileId !== this.#options.profileId ||
				(operation.environmentId !== undefined && operation.environmentId !== this.#options.environmentId) ||
				operation.sequence <= previousSequence ||
				operation.sequence > version.operationSequence
			) {
				throw new Error("Hosted company operation is outside the resolved substrate version");
			}
			previousSequence = operation.sequence;
		}
		return operations;
	}

	#requireSnapshotScope(snapshot: HostedCompanySnapshot): void {
		if (snapshot.profileId !== this.#options.profileId || snapshot.environmentId !== this.#options.environmentId) {
			throw new Error("Company snapshot is outside this profile environment");
		}
	}

	#requireVersionScope(
		version: HostedCompanySubstrateVersion,
		snapshotId?: string,
		clientVersionId?: string,
		artifactIndexId?: string,
	): void {
		if (
			version.profileId !== this.#options.profileId ||
			version.environmentId !== this.#options.environmentId ||
			(snapshotId !== undefined && version.companySnapshotId !== snapshotId) ||
			(clientVersionId !== undefined && version.clientVersionId !== clientVersionId) ||
			(artifactIndexId !== undefined && version.artifactIndexId !== artifactIndexId)
		) {
			throw new Error("Company substrate version is outside this profile environment");
		}
	}

	#requireArtifactIndexScope(index: HostedArtifactIndex, clientIndexId?: string, artifactCount?: number): void {
		if (
			index.profileId !== this.#options.profileId ||
			index.environmentId !== this.#options.environmentId ||
			(clientIndexId !== undefined && index.clientIndexId !== clientIndexId) ||
			(artifactCount !== undefined && index.artifactCount !== artifactCount)
		) {
			throw new Error("Artifact index is outside this profile environment");
		}
	}
}
