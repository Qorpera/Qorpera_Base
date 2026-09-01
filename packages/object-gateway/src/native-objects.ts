import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectGatewayReplication } from "./replication.ts";
import type { AuthorizedObject } from "./supabase-authority.ts";

export interface NativeCompanyObjectAuthority {
	authorizeNativeUpload(
		binding: Record<string, unknown>,
		companyId: string,
		sha256: string,
		bytes: number,
	): Promise<void>;
	confirmNativeUpload(
		binding: Record<string, unknown>,
		companyId: string,
		sha256: string,
		bytes: number,
	): Promise<void>;
	authorizeNativeDownload(
		binding: Record<string, unknown>,
		companyId: string,
		sha256: string,
	): Promise<AuthorizedObject>;
	readLegacyObject(companyId: string, sha256: string): Promise<Uint8Array>;
}

export interface NativeCompanyObjectOptions {
	token: string;
	authority: NativeCompanyObjectAuthority;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 8 * 1024 * 1024;

/** Trusted native-host staging, not a public raw-hash or model tool route.
 * The separate credential cannot delete objects or bypass the live run check.
 * Immutable staging does not publish a Company File change.
 */
export async function serveNativeCompanyObject(
	request: IncomingMessage,
	response: ServerResponse,
	options: NativeCompanyObjectOptions,
	store: FileSystemObjectStore,
	replication: ObjectGatewayReplication,
): Promise<void> {
	const header = request.headers.authorization;
	if (
		!header?.startsWith("Bearer ") ||
		!timingSafeEqual(
			createHash("sha256").update(header.slice(7)).digest(),
			createHash("sha256").update(options.token).digest(),
		)
	)
		throw new ObjectDependencyError(401);
	const match = /^\/v1\/native-company-objects\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(request.url ?? "");
	if (!match || !UUID.test(match[1]!)) throw new ObjectDependencyError(404);
	const companyId = match[1]!;
	const sha256 = match[2]!;
	const encoded = request.headers["x-qorpera-native-binding"];
	if (typeof encoded !== "string" || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded))
		throw new ObjectDependencyError(400);
	let value: unknown;
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new Error("Noncanonical binding");
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new ObjectDependencyError(400);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(400);
	const binding = value as Record<string, unknown>;
	const ids = ["leaseId", "runId", "jobId", "runnerId", "assignmentId", "credentialCapsuleId", "computeIdentityId"];
	if (
		ids.some((key) => typeof binding[key] !== "string" || !UUID.test(binding[key] as string)) ||
		Object.keys(binding).some((key) => ![...ids, "provider", "nativeHarness", "model"].includes(key)) ||
		binding.provider !== "openai" ||
		binding.nativeHarness !== "codex-cli" ||
		typeof binding.model !== "string" ||
		!binding.model.trim() ||
		binding.model.length > 160 ||
		/[\0\r\n]/.test(binding.model)
	)
		throw new ObjectDependencyError(400);
	if (request.method === "PUT") {
		const declared = request.headers["content-length"];
		if (!declared || !/^(0|[1-9][0-9]{0,7})$/.test(declared) || Number(declared) > MAX_BYTES)
			throw new ObjectDependencyError(413);
		const length = Number(declared);
		await options.authority.authorizeNativeUpload(binding, companyId, sha256, length);
		const bytes = await boundedObjectOperation(async () => {
			const chunks: Uint8Array[] = [];
			let count = 0;
			for await (const part of request) {
				const chunk = typeof part === "string" ? Buffer.from(part) : Buffer.from(part);
				count += chunk.byteLength;
				if (count > length) throw new ObjectDependencyError(413);
				chunks.push(chunk);
			}
			if (count !== length) throw new ObjectDependencyError(400);
			return Buffer.concat(chunks);
		});
		if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new ObjectDependencyError(400);
		const status = await replication.uploadWithAuthority(companyId, sha256, bytes, {
			authorize: () => options.authority.authorizeNativeUpload(binding, companyId, sha256, length),
			confirm: () => options.authority.confirmNativeUpload(binding, companyId, sha256, length),
		});
		response.writeHead(status === "stored" ? 201 : 200, {
			"cache-control": "no-store",
			"content-type": "application/json",
		});
		response.end(JSON.stringify({ status, sha256, bytes: length, replication: "pending" }));
		return;
	}
	if (request.method !== "GET") throw new ObjectDependencyError(405);
	const authority = await options.authority.authorizeNativeDownload(binding, companyId, sha256);
	let bytes: Uint8Array;
	try {
		bytes = await store.get(companyId, sha256, authority.bytes);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
		)
			throw error;
		bytes = await options.authority.readLegacyObject(companyId, sha256);
	}
	if (bytes.byteLength !== authority.bytes || createHash("sha256").update(bytes).digest("hex") !== sha256)
		throw new ObjectDependencyError(503);
	// No read grace for a native host. Recheck after potentially slow NAS I/O.
	const current = await options.authority.authorizeNativeDownload(binding, companyId, sha256);
	if (current.bytes !== authority.bytes) throw new ObjectDependencyError(503);
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": "application/octet-stream",
		"content-length": String(bytes.byteLength),
		etag: `"sha256-${sha256}"`,
	});
	response.end(bytes);
}
