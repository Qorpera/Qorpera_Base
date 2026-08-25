import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
	CloudContentAddressedStore,
	SupabaseCloudObjectTransport,
	type CloudObjectTransport,
} from "../packages/shell/src/cloud-object-store.ts";
import { captureCloudCompanyTree } from "../packages/shell/src/cloud-company-snapshot.ts";
import type { HostedPrimaryDatabase } from "../packages/shell/src/hosted-primary.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface Options {
	supabaseUrl: string;
	profileId: string;
	companyRoot: string;
	snapshotId: string;
	graphId: string;
	apply: boolean;
}

interface RecordedObject {
	sha256: string;
	bytes: number;
	mediaType: string;
}

const STORAGE_ATTEMPTS = 5;

function storageStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as Record<string, unknown>;
	const candidate = value.status ?? value.statusCode;
	if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
	if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
	return undefined;
}

function retryableStorageError(error: unknown): boolean {
	const status = storageStatus(error);
	if (status !== undefined) return status === 408 || status === 429 || status >= 500;
	if (!error || typeof error !== "object") return false;
	const value = error as Record<string, unknown>;
	return value.name === "StorageUnknownError" || String(value.message ?? "").toLowerCase().includes("fetch failed");
}

async function withStorageRetry<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (attempt >= STORAGE_ATTEMPTS || !retryableStorageError(error)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
		}
	}
}

function usage(): never {
	throw new Error(
		"Usage: tsx scripts/promote-company-file-snapshot-to-supabase.ts " +
			"--supabase-url <url> --profile-id <uuid> --company-root <path> " +
			"--snapshot-id <uuid> --graph-id <uuid> [--apply]",
	);
}

function parseOptions(args: string[]): Options {
	const values = new Map<string, string>();
	const valueOptions = new Set(["--supabase-url", "--profile-id", "--company-root", "--snapshot-id", "--graph-id"]);
	let apply = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--apply") {
			apply = true;
			continue;
		}
		if (!argument || !valueOptions.has(argument) || !args[index + 1]?.trim()) usage();
		values.set(argument, args[index + 1] as string);
		index += 1;
	}
	const supabaseUrl = values.get("--supabase-url");
	const profileId = values.get("--profile-id");
	const companyRoot = values.get("--company-root");
	const snapshotId = values.get("--snapshot-id");
	const graphId = values.get("--graph-id");
	if (!supabaseUrl || !profileId || !companyRoot || !snapshotId || !graphId) usage();
	if (!UUID_PATTERN.test(profileId) || !UUID_PATTERN.test(snapshotId) || !UUID_PATTERN.test(graphId)) usage();
	const parsedUrl = new URL(supabaseUrl);
	if (
		parsedUrl.protocol !== "https:" ||
		parsedUrl.username ||
		parsedUrl.password ||
		parsedUrl.pathname !== "/" ||
		parsedUrl.search ||
		parsedUrl.hash
	) {
		usage();
	}
	return { supabaseUrl: parsedUrl.origin, profileId, companyRoot, snapshotId, graphId, apply };
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
	return value;
}

function requiredInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
	return value as number;
}

class RecordingTransport implements CloudObjectTransport {
	readonly #delegate?: CloudObjectTransport;
	readonly #objects = new Map<string, RecordedObject>();

	constructor(delegate?: CloudObjectTransport) {
		this.#delegate = delegate;
	}

	async put(path: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored"> {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (!path.endsWith(`/${sha256}`)) throw new Error("Captured object path does not match its SHA-256");
		const existing = this.#objects.get(sha256);
		if (existing && (existing.bytes !== bytes.byteLength || existing.mediaType !== mediaType)) {
			throw new Error("Captured object address has inconsistent metadata");
		}
		this.#objects.set(sha256, { sha256, bytes: bytes.byteLength, mediaType });
		return this.#delegate ? this.#delegate.put(path, bytes, mediaType) : "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		if (!this.#delegate) throw new Error("Hash-only capture cannot read objects");
		return this.#delegate.get(path);
	}

	objects(): RecordedObject[] {
		return [...this.#objects.values()].sort((left, right) => left.sha256.localeCompare(right.sha256, "en"));
	}
}

class RetryingTransport implements CloudObjectTransport {
	readonly #delegate: CloudObjectTransport;

	constructor(delegate: CloudObjectTransport) {
		this.#delegate = delegate;
	}

	async put(path: string, bytes: Uint8Array, mediaType: string): Promise<"exists" | "stored"> {
		return withStorageRetry(() => this.#delegate.put(path, bytes, mediaType));
	}

	async get(path: string): Promise<Uint8Array> {
		return withStorageRetry(() => this.#delegate.get(path));
	}
}

function assertSameObjects(expected: Map<string, number>, actual: RecordedObject[]): void {
	if (expected.size !== actual.length) throw new Error("Local Company File closure does not match the live graph");
	for (const object of actual) {
		if (expected.get(object.sha256) !== object.bytes) {
			throw new Error("Local Company File object does not match the live graph");
		}
	}
}

async function verifyCatalogAuthority(
	client: SupabaseClient<HostedPrimaryDatabase>,
	profileId: string,
	expected: Map<string, number>,
): Promise<void> {
	const verified = new Set<string>();
	for (let offset = 0; ; offset += 1000) {
		const { data, error } = await client
			.from("qorpera_profile_objects")
			.select("sha256,bytes,backend")
			.eq("profile_id", profileId)
			.order("sha256")
			.range(offset, offset + 999);
		if (error) throw new Error("Promoted Company File catalog could not be loaded");
		for (const value of data ?? []) {
			const object = record(value, "promoted Company File catalog object");
			const sha256 = requiredString(object.sha256, "catalog object SHA-256");
			const expectedBytes = expected.get(sha256);
			if (expectedBytes === undefined) continue;
			if (
				requiredInteger(object.bytes, "catalog object bytes") !== expectedBytes ||
				object.backend !== "supabase-storage"
			) {
				throw new Error("Promoted Company File catalog authority is invalid");
			}
			verified.add(sha256);
		}
		if ((data?.length ?? 0) < 1000) break;
	}
	if (verified.size !== expected.size) throw new Error("Promoted Company File catalog closure is incomplete");
}

async function verifyObjects(
	store: CloudContentAddressedStore,
	profileId: string,
	objects: RecordedObject[],
): Promise<void> {
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(8, objects.length) }, async () => {
			while (cursor < objects.length) {
				const object = objects[cursor];
				cursor += 1;
				if (!object) return;
				await store.getObject(profileId, object);
			}
		}),
	);
}

const options = parseOptions(process.argv.slice(2));
const secretKey = process.env.QORPERA_SUPABASE_SECRET_KEY?.trim();
if (!secretKey) throw new Error("QORPERA_SUPABASE_SECRET_KEY is required");
const client = createClient<HostedPrimaryDatabase>(options.supabaseUrl, secretKey, {
	auth: { autoRefreshToken: false, persistSession: false },
});

const [fileResult, snapshotResult, graphResult] = await Promise.all([
	client
		.from("qorpera_company_files")
		.select("profile_id,environment_id,head_snapshot_id")
		.eq("profile_id", options.profileId)
		.maybeSingle(),
	client
		.from("qorpera_company_snapshots")
		.select(
			"id,profile_id,environment_id,tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes",
		)
		.eq("id", options.snapshotId)
		.maybeSingle(),
	client
		.from("qorpera_object_reachability_graphs")
		.select(
			"id,profile_id,environment_id,root_kind,root_id,root_object_sha256,object_count,storage_bytes,status,closure_verified",
		)
		.eq("id", options.graphId)
		.maybeSingle(),
]);
if (fileResult.error || snapshotResult.error || graphResult.error) {
	throw new Error("Company File promotion preflight query failed");
}
const file = record(fileResult.data, "Company File");
const snapshot = record(snapshotResult.data, "Company File snapshot");
const graph = record(graphResult.data, "Company File graph");
if (
	requiredString(file.profile_id, "Company File profile") !== options.profileId ||
	requiredString(file.head_snapshot_id, "Company File head") !== options.snapshotId ||
	requiredString(snapshot.profile_id, "snapshot profile") !== options.profileId ||
	requiredString(snapshot.id, "snapshot id") !== options.snapshotId ||
	requiredString(graph.profile_id, "graph profile") !== options.profileId ||
	requiredString(graph.id, "graph id") !== options.graphId ||
	requiredString(graph.root_kind, "graph root kind") !== "company_snapshot" ||
	requiredString(graph.root_id, "graph root") !== options.snapshotId ||
	requiredString(graph.status, "graph status") !== "complete" ||
	graph.closure_verified !== true ||
	requiredString(graph.root_object_sha256, "graph root object") !== snapshot.tree_manifest_sha256
) {
	throw new Error("Company File promotion is not pinned to the current verified head");
}

const graphObjects = new Map<string, number>();
for (let offset = 0; ; offset += 1000) {
	const { data, error } = await client
		.from("qorpera_object_reachability_entries")
		.select("object_sha256,bytes")
		.eq("graph_id", options.graphId)
		.order("object_sha256")
		.range(offset, offset + 999);
	if (error) throw new Error("Company File graph entries could not be loaded");
	for (const value of data ?? []) {
		const entry = record(value, "Company File graph entry");
		const sha256 = requiredString(entry.object_sha256, "graph object SHA-256");
		const bytes = requiredInteger(entry.bytes, "graph object bytes");
		if (!SHA256_PATTERN.test(sha256) || graphObjects.has(sha256)) throw new Error("Invalid Company File graph entry");
		graphObjects.set(sha256, bytes);
	}
	if ((data?.length ?? 0) < 1000) break;
}
const graphBytes = [...graphObjects.values()].reduce((total, bytes) => total + bytes, 0);
if (
	graphObjects.size !== requiredInteger(graph.object_count, "graph object count") ||
	graphBytes !== requiredInteger(graph.storage_bytes, "graph storage bytes")
) {
	throw new Error("Company File graph totals are invalid");
}

const hashOnlyTransport = new RecordingTransport();
const localTree = await captureCloudCompanyTree(
	options.companyRoot,
	options.profileId,
	new CloudContentAddressedStore(hashOnlyTransport),
	{ forceFullVerification: true },
);
if (
	localTree.manifestSha256 !== requiredString(snapshot.tree_manifest_sha256, "snapshot manifest SHA-256") ||
	localTree.manifestBytes !== requiredInteger(snapshot.tree_manifest_bytes, "snapshot manifest bytes") ||
	localTree.contractVersion !== requiredInteger(snapshot.tree_contract_version, "snapshot contract version") ||
	localTree.fileCount !== requiredInteger(snapshot.file_count, "snapshot file count") ||
	localTree.totalBytes !== requiredInteger(snapshot.total_bytes, "snapshot total bytes")
) {
	throw new Error("Local Company File does not match the current cloud head");
}
assertSameObjects(graphObjects, hashOnlyTransport.objects());

if (!options.apply) {
	console.log("SUPABASE_PROMOTION_PREFLIGHT_READY");
	console.log(`snapshot_id=${options.snapshotId}`);
	console.log(`graph_id=${options.graphId}`);
	console.log(`manifest_sha256=${localTree.manifestSha256}`);
	console.log(`object_count=${graphObjects.size}`);
	console.log(`storage_bytes=${graphBytes}`);
	process.exit(0);
}

const uploadTransport = new RecordingTransport(
	new RetryingTransport(new SupabaseCloudObjectTransport(client)),
);
const store = new CloudContentAddressedStore(uploadTransport);
const uploadedTree = await captureCloudCompanyTree(options.companyRoot, options.profileId, store, {
	forceFullVerification: true,
});
if (JSON.stringify(uploadedTree) !== JSON.stringify(localTree)) {
	throw new Error("Local Company File changed during Supabase publication");
}
const uploadedObjects = uploadTransport.objects();
assertSameObjects(graphObjects, uploadedObjects);
await verifyObjects(store, options.profileId, uploadedObjects);

const { data: promotionData, error: promotionError } = await client.rpc(
	"qorpera_promote_company_file_graph_to_supabase",
	{
		p_profile_id: options.profileId,
		p_graph_id: options.graphId,
	},
);
if (promotionError) throw new Error("Verified Supabase graph promotion failed");
const promotion = record(promotionData, "Supabase graph promotion receipt");
if (
	requiredString(promotion.profile_id, "promotion profile") !== options.profileId ||
	requiredString(promotion.graph_id, "promotion graph") !== options.graphId ||
	requiredString(promotion.snapshot_id, "promotion snapshot") !== options.snapshotId ||
	requiredInteger(promotion.object_count, "promotion object count") !== graphObjects.size ||
	requiredInteger(promotion.storage_bytes, "promotion storage bytes") !== graphBytes ||
	promotion.backend !== "supabase-storage"
) {
	throw new Error("Supabase graph promotion returned an invalid receipt");
}
const promoted = requiredInteger(promotion.changed_objects, "changed promotion objects");
await verifyCatalogAuthority(client, options.profileId, graphObjects);

console.log("SUPABASE_COMPANY_FILE_PROMOTION_VERIFIED");
console.log(`snapshot_id=${options.snapshotId}`);
console.log(`graph_id=${options.graphId}`);
console.log(`manifest_sha256=${localTree.manifestSha256}`);
console.log(`object_count=${graphObjects.size}`);
console.log(`storage_bytes=${graphBytes}`);
console.log(`promoted_objects=${promoted}`);
console.log(`catalog_verified_objects=${graphObjects.size}`);
