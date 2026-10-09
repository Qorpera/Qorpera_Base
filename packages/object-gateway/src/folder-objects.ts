import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import { assertNativeToken, type NativeBindingProof, nativeBinding, nativeHolder, UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/** A folder-v2 run as the folder core's actor (core C1b §1): its binding's run, job, runner and assignment. */
export interface FolderRunActor {
	readonly kind: "run";
	readonly runId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
}

/** The folder service's actors (F3 step 3, deploy/first-node/RUNTIME-FOLDER-WRITES.md): an operator's mount of a member
 * or of the platform, or a view (core C1b-3) with its pass. */
export type FolderServiceActor =
	| { readonly kind: "member"; readonly userId: string }
	| { readonly kind: "platform" }
	| { readonly kind: "view"; readonly viewId: string; readonly pass: string };

/** Any actor the folder core's byte checks take; SQL judges each (C1D §3). */
export type FolderActor = FolderRunActor | FolderServiceActor;

/** The folder core's byte checks (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §3, §7). */
export interface FolderObjectAuthority extends NativeBindingProof {
	/** Per chunk: the object is listed by this actor's open upload intent. Returns the company, the NAS place. */
	authorizeFolderUpload(
		environmentId: string,
		actor: FolderActor,
		intentId: string,
		sha256: string,
		bytes: number,
	): Promise<{ profileId: string }>;
	/** After the NAS put: the catalog row. */
	confirmFolderObject(
		environmentId: string,
		actor: FolderActor,
		intentId: string,
		sha256: string,
		bytes: number,
	): Promise<void>;
	/** An entry or path version the actor may read references the hash. */
	authorizeFolderDownload(
		environmentId: string,
		actor: FolderActor,
		sha256: string,
	): Promise<{ profileId: string; bytes: number }>;
	readLegacyObject(companyId: string, sha256: string): Promise<Uint8Array>;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The folder core's byte route for folder-v2 runs (core C1d): `/v1/folder-objects/<environmentId>/<sha256>` on the
 * native credential, with the run's binding. A put names its upload intent (`x-qorpera-upload-intent`), and each chunk
 * is authorized by that intent alone, with no run check per chunk (core §7). A get is allowed when an entry or path
 * version the run may read references the hash. Neither takes a company-wide lock. Staging publishes nothing: the
 * commit does.
 */
export async function serveFolderObject(
	request: IncomingMessage,
	response: ServerResponse,
	options: { token: string; authority: FolderObjectAuthority },
	store: FileSystemObjectStore,
	replication: ObjectGatewayReplication,
): Promise<void> {
	assertNativeToken(request, options.token);
	const match = /^\/v1\/folder-objects\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(request.url ?? "");
	if (!match || !UUID.test(match[1]!)) throw new ObjectDependencyError(404);
	const environmentId = match[1]!;
	const sha256 = match[2]!;
	const binding = nativeBinding(request);
	await options.authority.proveNativeBinding(binding, nativeHolder(request));
	// The folder core's run actor, in the lower case its checks compare.
	const actor: FolderRunActor = {
		kind: "run",
		runId: (binding.runId as string).toLowerCase(),
		jobId: (binding.jobId as string).toLowerCase(),
		runnerId: (binding.runnerId as string).toLowerCase(),
		assignmentId: (binding.assignmentId as string).toLowerCase(),
	};
	if (request.method === "PUT") {
		await putFolderObject(request, response, environmentId, sha256, actor, options.authority, replication);
		return;
	}
	if (request.method !== "GET") throw new ObjectDependencyError(405);
	const authority = await options.authority.authorizeFolderDownload(environmentId, actor, sha256);
	let bytes: Uint8Array;
	try {
		bytes = await store.get(authority.profileId, sha256, authority.bytes);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
		)
			throw error;
		try {
			bytes = await options.authority.readLegacyObject(authority.profileId, sha256);
		} catch (fallback) {
			// A busy NAS lane and no Storage copy yet (replication pending, right after staging) is the lane's 503,
			// which the runtime asks again, not Storage's miss.
			if (
				error instanceof ObjectDependencyError &&
				fallback instanceof ObjectDependencyError &&
				!fallback.unavailable
			)
				throw error;
			throw fallback;
		}
	}
	if (bytes.byteLength !== authority.bytes || createHash("sha256").update(bytes).digest("hex") !== sha256)
		throw new ObjectDependencyError(503);
	// Recheck after potentially slow NAS I/O.
	const current = await options.authority.authorizeFolderDownload(environmentId, actor, sha256);
	if (current.profileId !== authority.profileId || current.bytes !== authority.bytes)
		throw new ObjectDependencyError(503);
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": "application/octet-stream",
		"content-length": String(bytes.byteLength),
		etag: `"sha256-${sha256}"`,
	});
	response.end(bytes);
}

/** A put under an upload intent, for any folder actor: the intent lists the object for this actor (no other check per
 * chunk, core §7), the body is the object its hash names, then the NAS put with replication and the catalog row. */
export async function putFolderObject(
	request: IncomingMessage,
	response: ServerResponse,
	environmentId: string,
	sha256: string,
	actor: FolderActor,
	authority: FolderObjectAuthority,
	replication: ObjectGatewayReplication,
): Promise<void> {
	const intent = request.headers["x-qorpera-upload-intent"];
	if (typeof intent !== "string" || !UUID.test(intent)) throw new ObjectDependencyError(400);
	const declared = request.headers["content-length"];
	if (!declared || !/^(0|[1-9][0-9]{0,7})$/.test(declared) || Number(declared) > MAX_BYTES)
		throw new ObjectDependencyError(413);
	const length = Number(declared);
	const { profileId } = await authority.authorizeFolderUpload(environmentId, actor, intent, sha256, length);
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
	const status = await replication.uploadWithAuthority(profileId, sha256, bytes, {
		authorize: async () => {
			const again = await authority.authorizeFolderUpload(environmentId, actor, intent, sha256, length);
			if (again.profileId !== profileId) throw new ObjectDependencyError(403);
		},
		confirm: () => authority.confirmFolderObject(environmentId, actor, intent, sha256, length),
	});
	response.writeHead(status === "stored" ? 201 : 200, {
		"cache-control": "no-store",
		"content-type": "application/json",
	});
	response.end(JSON.stringify({ status, sha256, bytes: length, replication: "pending" }));
}
