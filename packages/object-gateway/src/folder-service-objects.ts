import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UUID_PATTERN } from "@qorpera/contracts";
import { ObjectDependencyError } from "./dependency.ts";
import { type FolderObjectAuthority, type FolderServiceActor, putFolderObject } from "./folder-objects.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

export interface FolderServiceObjectOptions {
	/** The folder service's own credential: no other client holds it, and it opens no other route. */
	token: string;
	authority: FolderObjectAuthority;
}

const PASS = /^[A-Za-z0-9_-]{43}$/;

/**
 * The folder service's byte route (F3 step 3, deploy/first-node/RUNTIME-FOLDER-WRITES.md): `PUT
 * /v1/folder-service-objects/<environmentId>/<sha256>` on the folder service's own token, naming the actor whose bytes
 * these are (`x-qorpera-folder-actor`) and its upload intent. The checks are a run's put's (`putFolderObject`): the
 * intent lists the object for that actor, the body is the object its hash names, then the catalog. The folder service
 * holds the database's service credential already, so naming the actor gives it nothing more; its own token keeps
 * every other credential off this route. Puts only: the folder service reads the NAS share itself.
 */
export async function serveFolderServiceObject(
	request: IncomingMessage,
	response: ServerResponse,
	options: FolderServiceObjectOptions,
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
	const match = /^\/v1\/folder-service-objects\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(request.url ?? "");
	if (!match || !UUID_PATTERN.test(match[1]!)) throw new ObjectDependencyError(404);
	if (request.method !== "PUT") throw new ObjectDependencyError(405);
	await putFolderObject(
		request,
		response,
		match[1]!,
		match[2]!,
		folderServiceActor(request.headers["x-qorpera-folder-actor"]),
		options.authority,
		replication,
	);
}

/** The actor from its header: canonical base64url JSON of exactly a member's, the platform's or a view's fields. */
export function folderServiceActor(encoded: string | string[] | undefined): FolderServiceActor {
	if (typeof encoded !== "string" || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded))
		throw new ObjectDependencyError(400);
	let value: unknown;
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.toString("base64url") !== encoded) throw new Error("Noncanonical actor");
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new ObjectDependencyError(400);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(400);
	const actor = value as Record<string, unknown>;
	const keys = Object.keys(actor).sort().join(",");
	if (actor.kind === "platform" && keys === "kind") return { kind: "platform" };
	if (
		actor.kind === "member" &&
		keys === "kind,userId" &&
		typeof actor.userId === "string" &&
		UUID_PATTERN.test(actor.userId)
	)
		return { kind: "member", userId: actor.userId };
	if (
		actor.kind === "view" &&
		keys === "kind,pass,viewId" &&
		typeof actor.viewId === "string" &&
		UUID_PATTERN.test(actor.viewId) &&
		typeof actor.pass === "string" &&
		PASS.test(actor.pass)
	)
		return { kind: "view", viewId: actor.viewId, pass: actor.pass };
	throw new ObjectDependencyError(400);
}
