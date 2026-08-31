import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberRequestObservationSpan } from "./member-observability.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectBackend } from "./supabase-authority.ts";

export interface MemberCompanyObjectIdentity {
	environmentId: string;
	path: string;
	version: string;
	sha256: string;
}

export interface AuthorizedMemberCompanyObject extends MemberCompanyObjectIdentity {
	schema: "qorpera.member-company-object/v2";
	companyId: string;
	actorUserId: string;
	resourceId: string;
	resourceVersion: string;
	bytes: number;
	backend: ObjectBackend;
}

export interface MemberCompanyObjectAuthority {
	authorizeMemberCompanyObject(
		userToken: string,
		identity: MemberCompanyObjectIdentity,
	): Promise<AuthorizedMemberCompanyObject>;
	readLegacyObject(companyId: string, sha256: string): Promise<Uint8Array>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** This human route never accepts a native binding, private service token,
 * arbitrary company id or offline read lease. The database derives the human
 * and company from current path authority on every authorization call. */
export async function serveMemberCompanyObject(
	request: IncomingMessage,
	response: ServerResponse,
	authority: MemberCompanyObjectAuthority,
	store: FileSystemObjectStore,
	observation?: MemberRequestObservationSpan,
): Promise<void> {
	if (request.method !== "GET") throw new ObjectDependencyError(405);
	const match = /^\/v1\/member-company-objects\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(
		request.url ?? "",
	);
	if (!match || !UUID.test(match[1]!) || !UUID.test(match[2]!)) throw new ObjectDependencyError(404);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const token = header.slice(7);
	const encoded = request.headers["x-qorpera-company-path"];
	if (typeof encoded !== "string" || encoded.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(encoded))
		throw new ObjectDependencyError(400);
	let path: string;
	try {
		const decoded = Buffer.from(encoded, "base64url");
		if (decoded.length > 4096 || decoded.toString("base64url") !== encoded) throw new Error("Invalid encoding");
		path = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
		if (!path || path.includes("\0")) throw new Error("Invalid path");
	} catch {
		throw new ObjectDependencyError(400);
	}
	const identity: MemberCompanyObjectIdentity = {
		environmentId: match[1]!,
		path,
		version: match[2]!,
		sha256: match[3]!,
	};
	const admitted = await authority.authorizeMemberCompanyObject(token, identity);
	observation?.update({
		companyId: admitted.companyId,
		environmentId: admitted.environmentId,
		actorUserId: admitted.actorUserId,
		resourceId: admitted.resourceId,
		resourceVersion: admitted.resourceVersion,
	});
	let bytes: Uint8Array;
	try {
		bytes = await store.get(admitted.companyId, identity.sha256, admitted.bytes);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
		)
			throw error;
		bytes = await authority.readLegacyObject(admitted.companyId, identity.sha256);
	}
	if (bytes.byteLength !== admitted.bytes || createHash("sha256").update(bytes).digest("hex") !== identity.sha256)
		throw new ObjectDependencyError(503);
	observation?.update({ logicalObjectReadBytes: bytes.byteLength });
	const current = await authority.authorizeMemberCompanyObject(token, identity);
	if (current.companyId !== admitted.companyId || current.bytes !== admitted.bytes)
		throw new ObjectDependencyError(503);
	observation?.update({ responseBodyBytes: bytes.byteLength });
	response.writeHead(200, {
		"cache-control": "private, no-store",
		"content-type": "application/octet-stream",
		"content-length": String(bytes.byteLength),
		"x-content-type-options": "nosniff",
		"x-qorpera-access-mode": "live-path-authority",
		etag: `"sha256-${identity.sha256}"`,
	});
	response.end(bytes);
}
