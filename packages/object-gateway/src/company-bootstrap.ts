import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const RESPONSIBILITY_PATH =
	/^organization\/responsibilities\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const OMITTED_LAYERS = [
	"company-git-history",
	"session-trail",
	"staff-registry",
	"product-git-checkouts",
	"dependency-caches",
	"staff-instructions",
	"system-metadata",
] as const;

interface BootstrapClaim {
	jobId: string;
	profileId: string;
	environmentId: string;
	leaseOwner: string;
	cofounderStaffAgentId: string;
	formationDocument: string;
	cofounderAgentDocument: string;
	cofounderResponsibilityDocuments: Record<string, string>;
	pathGatewayVersion: 1 | null;
	baseSnapshotId: string | null;
	baseTreeSha256: string | null;
	baseTreeBytes: number | null;
}

interface TreeEntry {
	path: string;
	kind: "directory" | "file";
	executable?: boolean;
	file?: {
		manifestSha256: string;
		fileSha256: string;
		bytes: number;
		mediaType: "application/octet-stream";
	};
}

interface BaseTree {
	entries: TreeEntry[];
	organizationDocuments: Record<string, string>;
	organizationManifests: Record<string, string>;
}

export interface CompanyBootstrapOptions {
	workerId: string;
	authority: MemberCompanyAuthority;
	store: { get(profileId: string, sha256: string, expectedBytes: number): Promise<Uint8Array> };
	authorizeServiceDownload(profileId: string, sha256: string): Promise<{ bytes: number }>;
	replication: {
		uploadWithAuthority(
			profileId: string,
			sha256: string,
			bytes: Uint8Array,
			authority: { authorize(): Promise<void>; confirm(): Promise<void> },
		): Promise<unknown>;
	};
	readLegacyObject(profileId: string, sha256: string): Promise<Uint8Array>;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(503);
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
		throw new ObjectDependencyError(503);
	}
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new ObjectDependencyError(503);
	return value;
}

function sha(value: unknown): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new ObjectDependencyError(503);
	return value;
}

function nullableUuid(value: unknown): string | null {
	return value === null ? null : uuid(value);
}

function boundedBytes(value: unknown): number | null {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 8 * 1024 * 1024) {
		throw new ObjectDependencyError(503);
	}
	return value as number;
}

function claim(value: unknown, workerId: string): BootstrapClaim | null {
	if (value === null) return null;
	const input = record(value);
	exact(input, [
		"schema",
		"jobId",
		"profileId",
		"environmentId",
		"leaseOwner",
		"leaseExpiresAt",
		"createdByUserId",
		"cofounderStaffAgentId",
		"formationId",
		"memberSessionId",
		"formationDocument",
		"cofounderAgentDocument",
		"cofounderResponsibilityDocuments",
		"pathGatewayVersion",
		"baseSnapshotId",
		"baseTreeSha256",
		"baseTreeBytes",
	]);
	if (
		input.schema !== "qorpera.company-bootstrap-claim/v1" ||
		input.leaseOwner !== workerId ||
		typeof input.formationDocument !== "string" ||
		Buffer.byteLength(input.formationDocument) < 2 ||
		Buffer.byteLength(input.formationDocument) > 32 * 1024 ||
		typeof input.cofounderAgentDocument !== "string" ||
		Buffer.byteLength(input.cofounderAgentDocument) < 2 ||
		Buffer.byteLength(input.cofounderAgentDocument) > 32 * 1024 ||
		(input.pathGatewayVersion !== null && input.pathGatewayVersion !== 1) ||
		typeof input.leaseExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.leaseExpiresAt)) ||
		Date.parse(input.leaseExpiresAt) <= Date.now()
	) {
		throw new ObjectDependencyError(503);
	}
	for (const key of ["createdByUserId", "cofounderStaffAgentId", "formationId", "memberSessionId"]) uuid(input[key]);
	const responsibilityDocuments = record(input.cofounderResponsibilityDocuments);
	for (const [path, document] of Object.entries(responsibilityDocuments)) {
		if (
			!RESPONSIBILITY_PATH.test(path) ||
			typeof document !== "string" ||
			Buffer.byteLength(document) < 2 ||
			Buffer.byteLength(document) > 32 * 1024
		) {
			throw new ObjectDependencyError(503);
		}
	}
	const baseSnapshotId = nullableUuid(input.baseSnapshotId);
	const baseTreeSha256 = input.baseTreeSha256 === null ? null : sha(input.baseTreeSha256);
	const baseTreeBytes = boundedBytes(input.baseTreeBytes);
	if (
		(baseSnapshotId === null) !== (baseTreeSha256 === null) ||
		(baseSnapshotId === null) !== (baseTreeBytes === null)
	) {
		throw new ObjectDependencyError(503);
	}
	return {
		jobId: uuid(input.jobId),
		profileId: uuid(input.profileId),
		environmentId: uuid(input.environmentId),
		leaseOwner: workerId,
		cofounderStaffAgentId: uuid(input.cofounderStaffAgentId),
		formationDocument: input.formationDocument,
		cofounderAgentDocument: input.cofounderAgentDocument,
		cofounderResponsibilityDocuments: responsibilityDocuments as Record<string, string>,
		pathGatewayVersion: input.pathGatewayVersion,
		baseSnapshotId,
		baseTreeSha256,
		baseTreeBytes,
	};
}

function fileEntry(path: string, manifestSha256: string, fileSha256: string, bytes: number): TreeEntry {
	return {
		path,
		kind: "file",
		executable: false,
		file: { manifestSha256, fileSha256, bytes, mediaType: "application/octet-stream" },
	};
}

function organizationDocumentPath(path: string): boolean {
	return (
		path === "organization/formation.json" ||
		/^organization\/(agents|responsibilities|projects)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(
			path,
		)
	);
}

function parseTreeEntry(value: unknown): TreeEntry {
	const entry = record(value);
	if (typeof entry.path !== "string" || !entry.path || Buffer.byteLength(entry.path) > 4096) {
		throw new ObjectDependencyError(503);
	}
	if (entry.kind === "directory") {
		exact(entry, ["path", "kind"]);
		return { path: entry.path, kind: "directory" };
	}
	exact(entry, ["path", "kind", "executable", "file"]);
	const file = record(entry.file);
	exact(file, ["manifestSha256", "fileSha256", "bytes", "mediaType"]);
	if (
		entry.kind !== "file" ||
		typeof entry.executable !== "boolean" ||
		file.mediaType !== "application/octet-stream" ||
		!Number.isSafeInteger(file.bytes) ||
		(file.bytes as number) < 0
	) {
		throw new ObjectDependencyError(503);
	}
	return {
		path: entry.path,
		kind: "file",
		executable: entry.executable,
		file: {
			manifestSha256: sha(file.manifestSha256),
			fileSha256: sha(file.fileSha256),
			bytes: file.bytes as number,
			mediaType: file.mediaType,
		},
	};
}

async function storedObject(
	options: CompanyBootstrapOptions,
	profileId: string,
	sha256: string,
	expectedBytes: number,
): Promise<Uint8Array> {
	try {
		return await options.store.get(profileId, sha256, expectedBytes);
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "Object not found") throw error;
		return options.readLegacyObject(profileId, sha256);
	}
}

async function baseTree(
	options: CompanyBootstrapOptions,
	current: BootstrapClaim,
	signal: AbortSignal,
): Promise<BaseTree> {
	if (!current.baseTreeSha256 || !current.baseTreeBytes) {
		return { entries: [], organizationDocuments: {}, organizationManifests: {} };
	}
	const bytes = await storedObject(options, current.profileId, current.baseTreeSha256, current.baseTreeBytes);
	if (
		bytes.byteLength !== current.baseTreeBytes ||
		createHash("sha256").update(bytes).digest("hex") !== current.baseTreeSha256
	) {
		throw new ObjectDependencyError(503);
	}
	const tree = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	exact(tree, ["schema", "contractVersion", "omittedLayers", "entries"]);
	if (
		tree.schema !== "qorpera.company-tree/v1" ||
		tree.contractVersion !== 3 ||
		!isDeepStrictEqual(tree.omittedLayers, OMITTED_LAYERS) ||
		!Array.isArray(tree.entries) ||
		tree.entries.length > 50_000
	) {
		throw new ObjectDependencyError(503);
	}
	const treeText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (
		(await options.authority.publisher(
			"qorpera_verify_company_path_tree",
			{ p_profile_id: current.profileId, p_manifest_text: treeText },
			signal,
		)) !== current.baseTreeSha256
	) {
		throw new ObjectDependencyError(503);
	}
	const entries = tree.entries.map(parseTreeEntry);
	const organizationDocuments: Record<string, string> = {};
	const organizationManifests: Record<string, string> = {};
	for (const entry of entries) {
		if (entry.kind !== "file" || !entry.file) continue;
		const manifestLength = boundedBytes(
			(await options.authorizeServiceDownload(current.profileId, entry.file.manifestSha256)).bytes,
		);
		if (manifestLength === null) throw new ObjectDependencyError(503);
		const manifestBytes = await storedObject(options, current.profileId, entry.file.manifestSha256, manifestLength);
		if (
			manifestBytes.byteLength !== manifestLength ||
			createHash("sha256").update(manifestBytes).digest("hex") !== entry.file.manifestSha256
		) {
			throw new ObjectDependencyError(503);
		}
		const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
		const manifest = record(JSON.parse(manifestText));
		exact(manifest, ["schema", "fileSha256", "bytes", "mediaType", "chunks"]);
		if (
			manifest.schema !== "qorpera.cloud-file-manifest/v1" ||
			manifest.fileSha256 !== entry.file.fileSha256 ||
			manifest.bytes !== entry.file.bytes ||
			manifest.mediaType !== "application/octet-stream" ||
			!Array.isArray(manifest.chunks) ||
			manifest.chunks.length > 64
		) {
			throw new ObjectDependencyError(503);
		}
		await options.authority.publisher(
			"qorpera_verify_company_path_file",
			{ p_profile_id: current.profileId, p_manifest_text: manifestText },
			signal,
		);
		if (!organizationDocumentPath(entry.path)) continue;
		organizationManifests[entry.path] = manifestText;
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (const value of manifest.chunks) {
			const chunk = record(value);
			exact(chunk, ["sha256", "bytes"]);
			const chunkSha = sha(chunk.sha256);
			if (
				!Number.isSafeInteger(chunk.bytes) ||
				(chunk.bytes as number) < 1 ||
				(chunk.bytes as number) > 4 * 1024 * 1024
			) {
				throw new ObjectDependencyError(503);
			}
			const chunkBytes = await storedObject(options, current.profileId, chunkSha, chunk.bytes as number);
			if (
				chunkBytes.byteLength !== chunk.bytes ||
				createHash("sha256").update(chunkBytes).digest("hex") !== chunkSha
			) {
				throw new ObjectDependencyError(503);
			}
			chunks.push(chunkBytes);
			total += chunkBytes.byteLength;
		}
		const document = Buffer.concat(
			chunks.map((chunk) => Buffer.from(chunk)),
			total,
		);
		if (total !== entry.file.bytes || createHash("sha256").update(document).digest("hex") !== entry.file.fileSha256) {
			throw new ObjectDependencyError(503);
		}
		organizationDocuments[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(document);
	}
	return { entries, organizationDocuments, organizationManifests };
}

export class CompanyBootstrapProvisioner {
	readonly #options: CompanyBootstrapOptions;

	constructor(options: CompanyBootstrapOptions) {
		if (!UUID.test(options.workerId)) throw new Error("Company bootstrap worker identity is invalid");
		this.#options = options;
	}

	async provisionOne(): Promise<boolean> {
		const signal = AbortSignal.timeout(240_000);
		const current = claim(
			await this.#options.authority.publisher(
				"qorpera_claim_company_bootstrap",
				{ p_worker_id: this.#options.workerId, p_lease_seconds: 300 },
				signal,
			),
			this.#options.workerId,
		);
		if (!current) return false;
		const base = await baseTree(this.#options, current, signal);
		const formationPath = "organization/formation.json";
		const agentPath = `organization/agents/${current.cofounderStaffAgentId}.json`;
		const formationDocument = base.organizationDocuments[formationPath] ?? current.formationDocument;
		const agentDocument = base.organizationDocuments[agentPath] ?? current.cofounderAgentDocument;
		const formationContent = Buffer.from(formationDocument);
		const formationContentSha = createHash("sha256").update(formationContent).digest("hex");
		const formationManifest = Buffer.from(
			base.organizationManifests[formationPath] ??
				JSON.stringify({
					schema: "qorpera.cloud-file-manifest/v1",
					fileSha256: formationContentSha,
					bytes: formationContent.length,
					mediaType: "application/octet-stream",
					chunks: formationContent.length ? [{ sha256: formationContentSha, bytes: formationContent.length }] : [],
				}),
		);
		const formationManifestSha = createHash("sha256").update(formationManifest).digest("hex");
		const agentContent = Buffer.from(agentDocument);
		const agentContentSha = createHash("sha256").update(agentContent).digest("hex");
		const agentManifest = Buffer.from(
			base.organizationManifests[agentPath] ??
				JSON.stringify({
					schema: "qorpera.cloud-file-manifest/v1",
					fileSha256: agentContentSha,
					bytes: agentContent.length,
					mediaType: "application/octet-stream",
					chunks: agentContent.length ? [{ sha256: agentContentSha, bytes: agentContent.length }] : [],
				}),
		);
		const agentManifestSha = createHash("sha256").update(agentManifest).digest("hex");
		// The Co-Founder's company-level responsibilities are minted by the job;
		// an already governed company keeps its evolved bytes, a genesis or
		// upgrade takes the exact job documents.
		const responsibilities = Object.entries(current.cofounderResponsibilityDocuments)
			.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
			.map(([path, jobDocument]) => {
				const document = base.organizationDocuments[path] ?? jobDocument;
				const content = Buffer.from(document);
				const contentSha = createHash("sha256").update(content).digest("hex");
				const manifest = Buffer.from(
					base.organizationManifests[path] ??
						JSON.stringify({
							schema: "qorpera.cloud-file-manifest/v1",
							fileSha256: contentSha,
							bytes: content.length,
							mediaType: "application/octet-stream",
							chunks: content.length ? [{ sha256: contentSha, bytes: content.length }] : [],
						}),
				);
				return {
					path,
					jobDocument,
					document,
					content,
					contentSha,
					manifest,
					manifestSha: createHash("sha256").update(manifest).digest("hex"),
				};
			});
		const byPath = new Map(base.entries.map((entry) => [entry.path, entry]));
		const requiredEntries: TreeEntry[] = [
			{ path: "organization", kind: "directory" },
			{ path: "organization/agents", kind: "directory" },
			{ path: "organization/projects", kind: "directory" },
			{ path: "organization/responsibilities", kind: "directory" },
			fileEntry(formationPath, formationManifestSha, formationContentSha, formationContent.length),
			fileEntry(agentPath, agentManifestSha, agentContentSha, agentContent.length),
			...responsibilities.map((item) =>
				fileEntry(item.path, item.manifestSha, item.contentSha, item.content.length),
			),
		];
		const missing: TreeEntry[] = [];
		for (const required of requiredEntries) {
			const existing = byPath.get(required.path);
			if (existing && existing.kind !== required.kind) throw new ObjectDependencyError(409);
			if (!existing) missing.push(required);
		}
		for (const required of current.pathGatewayVersion === 1 ? missing.slice(0, 1) : missing) {
			byPath.set(required.path, required);
			if (required.path === formationPath) {
				base.organizationDocuments[formationPath] = formationDocument;
				base.organizationManifests[formationPath] = formationManifest.toString("utf8");
			}
			if (required.path === agentPath) {
				base.organizationDocuments[agentPath] = agentDocument;
				base.organizationManifests[agentPath] = agentManifest.toString("utf8");
			}
			const responsibility = responsibilities.find((item) => item.path === required.path);
			if (responsibility) {
				base.organizationDocuments[responsibility.path] = responsibility.document;
				base.organizationManifests[responsibility.path] = responsibility.manifest.toString("utf8");
			}
		}
		const candidateEntries = [...byPath.values()].sort((left, right) =>
			Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
		);
		const tree = Buffer.from(
			JSON.stringify({
				schema: "qorpera.company-tree/v1",
				contractVersion: 3,
				omittedLayers: OMITTED_LAYERS,
				entries: candidateEntries,
			}),
		);
		if (tree.length > 8 * 1024 * 1024) throw new ObjectDependencyError(413);
		if (formationDocument === current.formationDocument) {
			await this.#stage(current, "formation_content", formationContent, signal);
		}
		if (agentDocument === current.cofounderAgentDocument) {
			await this.#stage(current, "cofounder_agent_content", agentContent, signal);
		}
		await this.#stage(current, "formation_manifest", formationManifest, signal);
		await this.#stage(current, "cofounder_agent_manifest", agentManifest, signal);
		for (const responsibility of responsibilities) {
			if (responsibility.document === responsibility.jobDocument) {
				await this.#stage(current, "cofounder_responsibility_content", responsibility.content, signal);
			}
			await this.#stage(
				current,
				"cofounder_responsibility_manifest",
				responsibility.manifest,
				signal,
				responsibility.path,
			);
			await this.#options.authority.publisher(
				"qorpera_verify_company_path_file",
				{ p_profile_id: current.profileId, p_manifest_text: responsibility.manifest.toString("utf8") },
				signal,
			);
		}
		await this.#options.authority.publisher(
			"qorpera_verify_company_path_file",
			{ p_profile_id: current.profileId, p_manifest_text: formationManifest.toString("utf8") },
			signal,
		);
		await this.#options.authority.publisher(
			"qorpera_verify_company_path_file",
			{ p_profile_id: current.profileId, p_manifest_text: agentManifest.toString("utf8") },
			signal,
		);
		await this.#stage(current, "tree", tree, signal);
		const treeSha = createHash("sha256").update(tree).digest("hex");
		if (
			(await this.#options.authority.publisher(
				"qorpera_verify_company_path_tree",
				{ p_profile_id: current.profileId, p_manifest_text: tree.toString("utf8") },
				signal,
			)) !== treeSha
		) {
			throw new ObjectDependencyError(503);
		}
		const result = record(
			await this.#options.authority.publisher(
				"qorpera_finalize_company_bootstrap",
				{
					p_job_id: current.jobId,
					p_worker_id: current.leaseOwner,
					p_formation_document: formationDocument,
					p_formation_manifest_text: formationManifest.toString("utf8"),
					p_cofounder_agent_manifest_text: agentManifest.toString("utf8"),
					p_tree_manifest_text: tree.toString("utf8"),
					p_organization_documents: base.organizationDocuments,
				},
				signal,
			),
		);
		if (
			result.schema !== "qorpera.company-bootstrap-result/v1" ||
			(result.state !== "completed" && result.state !== "provisioning") ||
			result.profileId !== current.profileId ||
			result.environmentId !== current.environmentId
		) {
			throw new ObjectDependencyError(503);
		}
		uuid(result.snapshotId);
		nullableUuid(result.firstRunInputId);
		return true;
	}

	async #stage(
		current: BootstrapClaim,
		kind:
			| "formation_content"
			| "formation_manifest"
			| "cofounder_agent_content"
			| "cofounder_agent_manifest"
			| "cofounder_responsibility_content"
			| "cofounder_responsibility_manifest"
			| "tree",
		bytes: Buffer,
		signal: AbortSignal,
		path?: string,
	): Promise<void> {
		const digest = createHash("sha256").update(bytes).digest("hex");
		const check = async (confirm: boolean): Promise<void> => {
			if (
				(await this.#options.authority.publisher(
					"qorpera_stage_company_bootstrap_object",
					{
						p_job_id: current.jobId,
						p_worker_id: current.leaseOwner,
						p_kind: kind,
						p_sha256: digest,
						p_bytes: bytes.length,
						p_confirm: confirm,
						...(path ? { p_path: path } : {}),
					},
					signal,
				)) !== current.profileId
			) {
				throw new ObjectDependencyError(403);
			}
		};
		await this.#options.replication.uploadWithAuthority(current.profileId, digest, bytes, {
			authorize: () => check(false),
			confirm: () => check(true),
		});
	}
}
