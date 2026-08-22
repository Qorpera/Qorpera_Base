import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectGatewayAuthority } from "./supabase-authority.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_PATH_PATTERN = /^\/v1\/profile-objects\/([^/]+)\/([^/]+)$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

export interface ObjectGatewayServiceOptions {
	store: FileSystemObjectStore;
	authority: ObjectGatewayAuthority;
	controlToken: string;
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function bearer(request: IncomingMessage): string {
	const value = request.headers.authorization;
	if (!value?.startsWith("Bearer ") || value.length <= 7) throw new HttpError(401, "Unauthorized");
	return value.slice(7).trim();
}

function secureEqual(left: string, right: string): boolean {
	const leftHash = createHash("sha256").update(left).digest();
	const rightHash = createHash("sha256").update(right).digest();
	return timingSafeEqual(leftHash, rightHash);
}

function boundedInteger(value: string | undefined, label: string, maximum: number): number {
	if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new HttpError(400, `${label} is invalid`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
		throw new HttpError(413, `${label} exceeds the supported limit`);
	}
	return parsed;
}

async function readBody(request: IncomingMessage, expectedBytes: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let received = 0;
	for await (const chunk of request) {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		received += bytes.byteLength;
		if (received > MAX_OBJECT_BYTES || received > expectedBytes) {
			throw new HttpError(413, "Object body exceeds the declared limit");
		}
		chunks.push(bytes);
	}
	if (received !== expectedBytes) throw new HttpError(400, "Object body length does not match Content-Length");
	return Buffer.concat(chunks, received);
}

function objectIdentity(request: IncomingMessage): { profileId: string; sha256: string } {
	const path = new URL(request.url ?? "/", "http://object-gateway.invalid").pathname;
	const match = OBJECT_PATH_PATTERN.exec(path);
	if (!match || !UUID_PATTERN.test(match[1] ?? "") || !SHA256_PATTERN.test(match[2] ?? "")) {
		throw new HttpError(404, "Not found");
	}
	return { profileId: match[1]!, sha256: match[2]! };
}

function verified(bytes: Uint8Array, sha256: string, expectedBytes: number): Uint8Array {
	if (bytes.byteLength !== expectedBytes || createHash("sha256").update(bytes).digest("hex") !== sha256) {
		throw new HttpError(503, "Object failed integrity verification");
	}
	return bytes;
}

export function createObjectGatewayHandler(options: ObjectGatewayServiceOptions): RequestListener {
	return (request, response) => {
		void (async () => {
			try {
				if (request.method === "GET" && request.url === "/healthz") {
					json(response, 200, { status: "ok" });
					return;
				}
				const { profileId, sha256 } = objectIdentity(request);
				if (request.method === "PUT") {
					const token = bearer(request);
					const length = boundedInteger(request.headers["content-length"], "Content-Length", MAX_OBJECT_BYTES);
					await options.authority.authorizeUpload(token, profileId, sha256, length);
					const bytes = await readBody(request, length);
					if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
						throw new HttpError(400, "Object body does not match its SHA-256 address");
					}
					const result = await options.store.put(profileId, sha256, bytes);
					await options.authority.confirmUpload(profileId, sha256, length);
					json(response, result === "stored" ? 201 : 200, { status: result, sha256, bytes: length });
					return;
				}
				if (request.method === "GET") {
					const authority = await options.authority.authorizeDownload(bearer(request), profileId, sha256);
					const bytes = verified(
						authority.backend === "nas-object-gateway"
							? await options.store.get(profileId, sha256, authority.bytes)
							: await options.authority.readLegacyObject(profileId, sha256),
						sha256,
						authority.bytes,
					);
					response.writeHead(200, {
						"cache-control": "private, no-store",
						"content-length": String(bytes.byteLength),
						"content-type": "application/octet-stream",
						etag: `"sha256-${sha256}"`,
					});
					response.end(bytes);
					return;
				}
				if (request.method === "DELETE") {
					if (!secureEqual(bearer(request), options.controlToken)) throw new HttpError(401, "Unauthorized");
					const bytes = boundedInteger(
						request.headers["x-qorpera-object-bytes"] as string | undefined,
						"Object size",
						MAX_OBJECT_BYTES,
					);
					const leaseId = request.headers["x-qorpera-gc-lease-id"];
					const authorizationId = request.headers["x-qorpera-deletion-authorization-id"];
					if (
						(typeof leaseId === "string") === (typeof authorizationId === "string") ||
						(typeof leaseId === "string" && !UUID_PATTERN.test(leaseId)) ||
						(typeof authorizationId === "string" && !UUID_PATTERN.test(authorizationId))
					) {
						throw new HttpError(400, "Cleanup authority is invalid");
					}
					const authorization =
						typeof authorizationId === "string"
							? await options.authority.resumeDelete(authorizationId, profileId, sha256, bytes)
							: await options.authority.authorizeDelete(profileId, sha256, bytes, leaseId as string);
					if (authorization.state === "completed") {
						response.writeHead(204, { "cache-control": "no-store" });
						response.end();
						return;
					}
					await options.store.remove(profileId, sha256);
					await options.authority.finalizeDelete(authorization.authorizationId, profileId, sha256, bytes);
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
					return;
				}
				throw new HttpError(405, "Method not allowed");
			} catch (error) {
				if (response.headersSent) {
					response.destroy();
					return;
				}
				if (error instanceof HttpError) {
					json(response, error.status, { error: error.message });
					return;
				}
				json(response, 503, { error: "Object gateway operation failed" });
			}
		})();
	};
}
