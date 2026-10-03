import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberRequestObservationSpan } from "./member-observability.ts";
import type { FileSystemObjectStore } from "./object-store.ts";

/** The folder core's byte check for a member (folder core C4, P27a: `qorpera_member_folder_object`). */
export interface MemberFolderObjectAuthority {
	/** One object (a manifest or a chunk) of a file the member may read, now or in a version they may read. The
	 * database derives the member from the token and the company from the environment. */
	authorizeMemberFolderObject(
		userToken: string,
		environmentId: string,
		sha256: string,
	): Promise<{ profileId: string; bytes: number }>;
	readLegacyObject(companyId: string, sha256: string): Promise<Uint8Array>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A member's bytes of a folder-v2 company (deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §2):
 * `GET /v1/member-folder-objects/<environmentId>/<sha256>` with the member's own token, one manifest or chunk at a time,
 * as the runs' folder route serves them. It never accepts a native binding, a service token, a company id or a read
 * lease. The check runs before and after the NAS read, so access that ends meanwhile returns nothing.
 */
export async function serveMemberFolderObject(
	request: IncomingMessage,
	response: ServerResponse,
	authority: MemberFolderObjectAuthority,
	store: FileSystemObjectStore,
	observation?: MemberRequestObservationSpan,
): Promise<void> {
	if (request.method !== "GET") throw new ObjectDependencyError(405);
	const match = /^\/v1\/member-folder-objects\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(request.url ?? "");
	if (!match || !UUID.test(match[1]!)) throw new ObjectDependencyError(404);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const token = header.slice(7);
	const environmentId = match[1]!;
	const sha256 = match[2]!;
	const admitted = await authority.authorizeMemberFolderObject(token, environmentId, sha256);
	observation?.update({ companyId: admitted.profileId, environmentId });
	let bytes: Uint8Array;
	try {
		bytes = await store.get(admitted.profileId, sha256, admitted.bytes);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
		)
			throw error;
		try {
			bytes = await authority.readLegacyObject(admitted.profileId, sha256);
		} catch (fallback) {
			// A busy NAS lane and no Storage copy yet (replication pending) is the lane's 503, not Storage's miss.
			if (
				error instanceof ObjectDependencyError &&
				fallback instanceof ObjectDependencyError &&
				!fallback.unavailable
			)
				throw error;
			throw fallback;
		}
	}
	if (bytes.byteLength !== admitted.bytes || createHash("sha256").update(bytes).digest("hex") !== sha256)
		throw new ObjectDependencyError(503);
	observation?.update({ logicalObjectReadBytes: bytes.byteLength });
	const current = await authority.authorizeMemberFolderObject(token, environmentId, sha256);
	if (current.profileId !== admitted.profileId || current.bytes !== admitted.bytes)
		throw new ObjectDependencyError(503);
	observation?.update({ responseBodyBytes: bytes.byteLength });
	response.writeHead(200, {
		"cache-control": "private, no-store",
		"content-type": "application/octet-stream",
		"content-length": String(bytes.byteLength),
		"x-content-type-options": "nosniff",
		"x-qorpera-access-mode": "live-path-authority",
		etag: `"sha256-${sha256}"`,
	});
	response.end(bytes);
}
