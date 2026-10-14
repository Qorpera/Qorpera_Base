import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { memberFolderWriter } from "./member-folder-commits.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import { PlatformFolderWriter } from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * A member's chat images on folder-v2 (supabase/CLIENT-CONTRACT.md "Chat images", migration 20260930260000): each image
 * is a folder file under the conversation's tree root, `<root>/images/<client input id>/<sha256>.<ext>`, which only the
 * platform writes.
 * - `PUT …/upload/<sessionId>/<clientInputId>/<sha256>`: the member's begin (`qorpera_room_image_begin`, with their
 *   token) checks the room, the input and its limits and names the company's folder, and the writer check
 *   (`qorpera_member_folder_writer`, with their token) names the member. The body must be the bytes begun. The gateway
 *   stages them as the platform and saves the file for that member (`qorpera_room_image_commit`, with the service key).
 *   Answers `{sha256, bytes, mediaType}`.
 * - `GET …/input/<sessionId>/<inputId>/<sha256>`: one image of a posted input, for a member who may read the
 *   conversation (`qorpera_room_image_download`, with their token), read by its manifest as the platform, and served
 *   only if the member may still read it after the read.
 * The database's refusals keep their statuses: 42501 is 403, 22023 400, 23505 (another member's input) 409, 54000 (the
 * input's limits) 413, and 55000 (no folder, the file gone, a paused company) 423.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SHA256 = /^[0-9a-f]{64}$/;

export interface MemberSessionAttachmentOptions {
	readonly authority: Pick<MemberCompanyAuthority, "member" | "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly readFallback?: (profileId: string, sha256: string) => Promise<Uint8Array>;
}

/** The database's answer: exactly `keys`, with the values the route asked for in `expected`; 503 otherwise. */
function answer(value: unknown, keys: readonly string[], expected: Record<string, unknown>): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(503);
	const item = value as Record<string, unknown>;
	if (
		Object.keys(item).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(item, key)) ||
		Object.entries(expected).some(([key, wanted]) => item[key] !== wanted)
	)
		throw new ObjectDependencyError(503);
	return item;
}

/** An image the download names: its folder, its manifest and an image within the limits; 503 otherwise. */
function download(
	value: unknown,
	sessionId: string,
	inputId: string,
	sha256: string,
): { environmentId: string; manifestSha256: string; bytes: number } {
	const item = answer(
		value,
		[
			"schema",
			"environmentId",
			"sessionId",
			"inputId",
			"sha256",
			"bytes",
			"mediaType",
			"manifestSha256",
			"fileSha256",
			"path",
		],
		{ schema: "qorpera.room-image-download/v1", sessionId, inputId, sha256, fileSha256: sha256 },
	);
	if (
		typeof item.environmentId !== "string" ||
		!UUID.test(item.environmentId) ||
		typeof item.manifestSha256 !== "string" ||
		!SHA256.test(item.manifestSha256) ||
		!Number.isSafeInteger(item.bytes) ||
		(item.bytes as number) < 1 ||
		(item.bytes as number) > MAX_BYTES ||
		typeof item.mediaType !== "string" ||
		!MEDIA.has(item.mediaType) ||
		typeof item.path !== "string"
	)
		throw new ObjectDependencyError(503);
	return { environmentId: item.environmentId, manifestSha256: item.manifestSha256, bytes: item.bytes as number };
}

/** Upload proof and download authority are separate. Neither a known hash nor an unposted upload gives access to
 * another input's bytes. */
export async function serveMemberSessionAttachment(
	request: IncomingMessage,
	response: ServerResponse,
	options: MemberSessionAttachmentOptions,
): Promise<void> {
	const match =
		/^\/v1\/member-session-attachments\/(upload|input)\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(
			request.url ?? "",
		);
	if (!match || !UUID.test(match[2]) || !UUID.test(match[3])) throw new ObjectDependencyError(404);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const token = header.slice(7);
	const [, kind, sessionId, inputId, sha256] = match;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new ObjectDependencyError(503)), 30_000);
	const signal = controller.signal;
	const folder = new PlatformFolderWriter({
		authority: options.authority,
		store: options.store,
		replication: options.replication,
		...(options.readFallback ? { readFallback: options.readFallback } : {}),
	});
	try {
		if (kind === "upload") {
			if (request.method !== "PUT") throw new ObjectDependencyError(405);
			const length = request.headers["content-length"];
			const mediaType = request.headers["content-type"];
			if (
				!length ||
				!/^[1-9][0-9]{0,6}$/.test(length) ||
				Number(length) > MAX_BYTES ||
				!mediaType ||
				!MEDIA.has(mediaType)
			)
				throw new ObjectDependencyError(400);
			const size = Number(length);
			const begun = answer(
				await options.authority.member(
					"qorpera_room_image_begin",
					token,
					{
						p_session_id: sessionId,
						p_client_input_id: inputId,
						p_sha256: sha256,
						p_bytes: size,
						p_media_type: mediaType,
					},
					signal,
				),
				["schema", "environmentId", "sessionId", "clientInputId", "sha256", "bytes", "mediaType", "path"],
				{
					schema: "qorpera.room-image-begin/v1",
					sessionId,
					clientInputId: inputId,
					sha256,
					bytes: size,
					mediaType,
				},
			);
			if (
				typeof begun.environmentId !== "string" ||
				!UUID.test(begun.environmentId) ||
				typeof begun.path !== "string"
			)
				throw new ObjectDependencyError(503);
			const environmentId = begun.environmentId;
			// The commit is the service key's, for the member the database names for this token.
			const member = memberFolderWriter(
				await options.authority.member(
					"qorpera_member_folder_writer",
					token,
					{ p_environment_id: environmentId },
					signal,
				),
			);
			const bytes = await boundedObjectOperation(async () => {
				const chunks: Buffer[] = [];
				let count = 0;
				for await (const part of request) {
					const chunk = Buffer.from(part);
					count += chunk.length;
					if (count > size) throw new ObjectDependencyError(413);
					chunks.push(chunk);
				}
				if (count !== size) throw new ObjectDependencyError(400);
				return Buffer.concat(chunks);
			});
			if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new ObjectDependencyError(400);
			const file = await folder.stage(environmentId, bytes, { mediaType, executable: false }, signal);
			answer(
				await options.authority.publisher(
					"qorpera_room_image_commit",
					{ p_user_id: member.actor.userId, p_session_id: sessionId, p_client_input_id: inputId, p_file: file },
					signal,
				),
				["schema", "sha256", "bytes", "mediaType", "path"],
				{ schema: "qorpera.room-image/v1", sha256, bytes: size, mediaType, path: begun.path },
			);
			signal.throwIfAborted();
			response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
			response.end(JSON.stringify({ sha256, bytes: size, mediaType }));
			return;
		}
		if (request.method !== "GET") throw new ObjectDependencyError(405);
		const authorize = async () =>
			download(
				await options.authority.member(
					"qorpera_room_image_download",
					token,
					{ p_session_id: sessionId, p_input_id: inputId, p_sha256: sha256 },
					signal,
				),
				sessionId,
				inputId,
				sha256,
			);
		const access = await authorize();
		// The read checks the bytes against the file's hash, which is the URL's.
		const bytes = await folder.read(
			access.environmentId,
			{ manifestSha256: access.manifestSha256, fileSha256: sha256, bytes: access.bytes },
			MAX_BYTES,
			signal,
		);
		if (!isDeepStrictEqual(await authorize(), access)) throw new ObjectDependencyError(403);
		signal.throwIfAborted();
		response.writeHead(200, {
			"content-type": "application/octet-stream",
			"content-length": bytes.length,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(bytes);
	} finally {
		clearTimeout(timer);
	}
}
