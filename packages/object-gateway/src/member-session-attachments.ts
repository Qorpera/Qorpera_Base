import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { boundedObjectOperation, ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyFileOptions } from "./member-company-file.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function descriptor(
	value: unknown,
	sessionId: string,
	inputId: string,
	sha256: string,
	upload: boolean,
): {
	companyId: string;
	bytes: number;
	mediaType: string;
	uploadId?: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(503);
	const item = value as Record<string, unknown>;
	const keys = [
		"companyId",
		"sessionId",
		upload ? "clientInputId" : "inputId",
		"sha256",
		"bytes",
		"mediaType",
		...(upload ? ["uploadId"] : []),
	];
	if (
		Object.keys(item).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(item, key)) ||
		item.sessionId !== sessionId ||
		item[upload ? "clientInputId" : "inputId"] !== inputId ||
		item.sha256 !== sha256 ||
		typeof item.companyId !== "string" ||
		!UUID.test(item.companyId) ||
		!Number.isSafeInteger(item.bytes) ||
		(item.bytes as number) < 1 ||
		(item.bytes as number) > 8 * 1024 * 1024 ||
		typeof item.mediaType !== "string" ||
		!MEDIA.has(item.mediaType) ||
		(upload && (typeof item.uploadId !== "string" || !UUID.test(item.uploadId)))
	)
		throw new ObjectDependencyError(503);
	return {
		companyId: item.companyId,
		bytes: item.bytes as number,
		mediaType: item.mediaType,
		...(upload ? { uploadId: item.uploadId as string } : {}),
	};
}

/** Upload proof and download authority are separate. Neither a known hash nor
 * an unaccepted upload gives access to someone else's Company File bytes. */
export async function serveMemberSessionAttachment(
	request: IncomingMessage,
	response: ServerResponse,
	options: MemberCompanyFileOptions,
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
	const timer = setTimeout(() => controller.abort(), 30_000);
	const signal = controller.signal;
	try {
		if (kind === "upload") {
			if (request.method !== "PUT") throw new ObjectDependencyError(405);
			const length = request.headers["content-length"];
			const mediaType = request.headers["content-type"];
			if (
				!length ||
				!/^[1-9][0-9]{0,6}$/.test(length) ||
				Number(length) > 8 * 1024 * 1024 ||
				!mediaType ||
				!MEDIA.has(mediaType)
			)
				throw new ObjectDependencyError(400);
			const access = descriptor(
				await options.authority.member(
					"qorpera_begin_member_session_attachment_upload",
					token,
					{
						p_session_id: sessionId,
						p_client_input_id: inputId,
						p_sha256: sha256,
						p_bytes: Number(length),
						p_media_type: mediaType,
					},
					signal,
				),
				sessionId,
				inputId,
				sha256,
				true,
			);
			if (access.bytes !== Number(length) || access.mediaType !== mediaType) throw new ObjectDependencyError(503);
			const bytes = await boundedObjectOperation(async () => {
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const part of request) {
					const chunk = Buffer.from(part);
					size += chunk.length;
					if (size > access.bytes) throw new ObjectDependencyError(413);
					chunks.push(chunk);
				}
				if (size !== access.bytes) throw new ObjectDependencyError(400);
				return Buffer.concat(chunks);
			});
			if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new ObjectDependencyError(400);
			const check = async (confirm: boolean): Promise<void> => {
				signal.throwIfAborted();
				if (
					(await options.authority.publisher(
						"qorpera_stage_member_session_attachment",
						{ p_upload_id: access.uploadId, p_confirm: confirm },
						signal,
					)) !== access.companyId
				)
					throw new ObjectDependencyError(403);
			};
			await options.replication.uploadWithAuthority(access.companyId, sha256, bytes, {
				authorize: () => check(false),
				confirm: () => check(true),
			});
			signal.throwIfAborted();
			response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
			response.end(JSON.stringify({ sha256, bytes: access.bytes, mediaType }));
			return;
		}
		if (request.method !== "GET") throw new ObjectDependencyError(405);
		const authorize = async () =>
			descriptor(
				await options.authority.member(
					"qorpera_authorize_member_session_attachment",
					token,
					{ p_session_id: sessionId, p_input_id: inputId, p_sha256: sha256 },
					signal,
				),
				sessionId,
				inputId,
				sha256,
				false,
			);
		const access = await authorize();
		let bytes: Uint8Array;
		try {
			bytes = await options.store.get(access.companyId, sha256, access.bytes);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				(error.message !== "Object not found" && !(error instanceof ObjectDependencyError && error.unavailable))
			)
				throw error;
			bytes = await options.readLegacyObject(access.companyId, sha256);
		}
		if (bytes.length !== access.bytes || createHash("sha256").update(bytes).digest("hex") !== sha256)
			throw new ObjectDependencyError(503);
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
