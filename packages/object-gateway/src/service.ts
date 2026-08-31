import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { boundedObjectOperation, ObjectDependencyError, type ObjectDependencyHealth } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { serveMemberCompanyFile } from "./member-company-file.ts";
import { type MemberCompanyObjectAuthority, serveMemberCompanyObject } from "./member-company-objects.ts";
import {
	MEMBER_OBSERVATIONS_PATH,
	type MemberCompanyObservations,
	type MemberRequestObservationSpan,
	parseMemberObservationQuery,
} from "./member-observability.ts";
import { serveMemberSessionAttachment } from "./member-session-attachments.ts";
import { type NativeCompanyObjectOptions, serveNativeCompanyObject } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectReadLeases } from "./read-lease.ts";
import type { ObjectGatewayReplication } from "./replication.ts";
import type { AuthorizedObject, ObjectGatewayAuthority } from "./supabase-authority.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_PATH_PATTERN = /^\/v1\/profile-objects\/([^/]+)\/([^/]+)$/;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

export interface ObjectGatewayServiceOptions {
	store: FileSystemObjectStore;
	authority: ObjectGatewayAuthority;
	controlToken: string;
	verifierToken: string;
	readLeases?: ObjectReadLeases;
	revocationToken?: string;
	replication?: ObjectGatewayReplication;
	nativeObjects?: NativeCompanyObjectOptions;
	memberObjects?: MemberCompanyObjectAuthority;
	memberFiles?: MemberCompanyAuthority;
	memberObservations?: MemberCompanyObservations;
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(
	response: ServerResponse,
	status: number,
	value: unknown,
	observation?: MemberRequestObservationSpan,
): void {
	const encoded = JSON.stringify(value);
	observation?.update({ responseBodyBytes: Buffer.byteLength(encoded) });
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
	response.end(encoded);
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
	if (options.memberFiles && !options.replication) {
		throw new Error("Member Company File publication requires durable replication");
	}
	if (secureEqual(options.controlToken, options.verifierToken)) {
		throw new Error("Object gateway control and verifier tokens must be distinct");
	}
	if (
		options.nativeObjects &&
		(!options.replication ||
			!/^[A-Za-z0-9_-]{43}$/.test(options.nativeObjects.token) ||
			[options.controlToken, options.verifierToken, options.revocationToken].some(
				(token) => token !== undefined && secureEqual(token, options.nativeObjects!.token),
			))
	) {
		throw new Error("Native object staging requires replication and a distinct private credential");
	}
	if (
		options.readLeases &&
		(!options.revocationToken ||
			[options.controlToken, options.verifierToken].some((token) => secureEqual(token, options.revocationToken!)))
	) {
		throw new Error("Read delegation requires a distinct revocation credential");
	}
	return (request, response) => {
		let observation: MemberRequestObservationSpan | undefined;
		try {
			if (request.url?.startsWith("/v1/member-company-objects/"))
				observation = options.memberObservations?.start("object_read");
			else if (request.url?.startsWith("/v1/member-company-file/"))
				observation = options.memberObservations?.start("file_request");
		} catch {
			/* Optional diagnostics cannot prevent a human request. */
		}
		if (observation) {
			response.once("finish", () => observation?.finish(response.statusCode));
			response.once("close", () => {
				if (!response.writableFinished)
					observation?.finish(response.headersSent ? response.statusCode : null, true);
			});
		}
		void (async () => {
			try {
				if (request.url?.startsWith(MEMBER_OBSERVATIONS_PATH)) {
					if (!secureEqual(bearer(request), options.controlToken)) throw new HttpError(401, "Unauthorized");
					if (request.method !== "GET") throw new HttpError(404, "Not found");
					const query = parseMemberObservationQuery(request.url);
					if (!options.memberObservations) {
						json(response, 503, { status: "unknown", reason: "observations_unconfigured" });
						return;
					}
					json(response, 200, options.memberObservations.snapshot(query));
					return;
				}
				if (request.method === "GET" && request.url === "/livez") {
					json(response, 200, { status: "alive" });
					return;
				}
				if (request.method === "GET" && (request.url === "/healthz" || request.url === "/readyz")) {
					const dependencies = {
						nas: options.store.dependencyHealth(),
						...(options.authority.health?.() ?? {
							api: { status: "unknown" },
							storage: { status: "unknown" },
							auth: { status: "unknown" },
						}),
					};
					const replication = options.replication
						? await boundedObjectOperation(() => options.replication!.status()).catch(() => ({
								pending: null,
								blocked: null,
								degraded: true,
								journal: "unavailable",
							}))
						: { pending: 0, blocked: 0, degraded: true, journal: "unconfigured" };
					const recentHealthy = (dependency: ObjectDependencyHealth): boolean => {
						const age = Date.now() - Date.parse(dependency.checkedAt ?? "");
						return dependency.status === "healthy" && age >= 0 && age < 60_000;
					};
					const healthy = Object.values(dependencies).every(recentHealthy) && !replication.degraded;
					const ready =
						replication.pending !== null &&
						((recentHealthy(dependencies.api) &&
							(recentHealthy(dependencies.nas) || recentHealthy(dependencies.storage))) ||
							(Boolean(options.readLeases) && recentHealthy(dependencies.nas)));
					// A dependency incident must not drain the fallback's own ingress.
					// Readiness means a bounded serving lane, never full cloud health.
					json(response, (request.url === "/readyz" ? ready : healthy) ? 200 : 503, {
						status: healthy ? "healthy" : "degraded",
						ready,
						dependencies,
						replication,
						readContinuity: options.readLeases ? "bounded-exact-object-leases" : "disabled",
						controlContinuity: "requires-live-authority",
					});
					return;
				}
				if (request.method === "POST" && request.url === "/v1/read-leases/revoke") {
					if (
						!options.readLeases ||
						!options.revocationToken ||
						!secureEqual(bearer(request), options.revocationToken)
					)
						throw new HttpError(401, "Unauthorized");
					const length = boundedInteger(request.headers["content-length"], "Content-Length", 1024);
					const bytes = await boundedObjectOperation(() => readBody(request, length));
					const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf-8"));
					if (!value || typeof value !== "object" || Array.isArray(value))
						throw new HttpError(400, "Invalid revocation");
					const scope = value as Record<string, unknown>;
					if (
						Object.keys(scope).some((name) => !["profileId", "subjectId", "sessionId"].includes(name)) ||
						typeof scope.profileId !== "string" ||
						(scope.subjectId !== undefined && typeof scope.subjectId !== "string") ||
						(scope.sessionId !== undefined && typeof scope.sessionId !== "string")
					)
						throw new HttpError(400, "Invalid revocation");
					await options.readLeases.revoke(
						scope.profileId,
						scope.subjectId as string | undefined,
						scope.sessionId as string | undefined,
					);
					json(response, 200, { status: "revoked" });
					return;
				}
				if (request.url?.startsWith("/v1/member-company-file/")) {
					if (!options.memberFiles || !options.replication) throw new HttpError(404, "Not found");
					await serveMemberCompanyFile(request, response, {
						authority: options.memberFiles,
						store: options.store,
						replication: options.replication,
						readLegacyObject: (companyId, sha256) => options.authority.readLegacyObject(companyId, sha256),
						observation,
					});
					return;
				}
				if (request.url?.startsWith("/v1/member-session-attachments/")) {
					if (!options.memberFiles || !options.replication) throw new HttpError(404, "Not found");
					await serveMemberSessionAttachment(request, response, {
						authority: options.memberFiles,
						store: options.store,
						replication: options.replication,
						readLegacyObject: (companyId, sha256) => options.authority.readLegacyObject(companyId, sha256),
					});
					return;
				}
				if (request.url?.startsWith("/v1/member-company-objects/")) {
					if (!options.memberObjects) throw new HttpError(404, "Not found");
					await serveMemberCompanyObject(request, response, options.memberObjects, options.store, observation);
					return;
				}
				if (request.url?.startsWith("/v1/native-company-objects/")) {
					if (!options.nativeObjects || !options.replication) throw new HttpError(404, "Not found");
					await serveNativeCompanyObject(
						request,
						response,
						options.nativeObjects,
						options.store,
						options.replication,
					);
					return;
				}
				const { profileId, sha256 } = objectIdentity(request);
				if (request.method === "PUT") {
					const token = bearer(request);
					const length = boundedInteger(request.headers["content-length"], "Content-Length", MAX_OBJECT_BYTES);
					await options.authority.authorizeUpload(token, profileId, sha256, length);
					const bytes = await boundedObjectOperation(() => readBody(request, length));
					if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
						throw new HttpError(400, "Object body does not match its SHA-256 address");
					}
					const result = options.replication
						? await options.replication.upload(token, profileId, sha256, bytes)
						: await options.store.put(profileId, sha256, bytes);
					if (!options.replication) await options.authority.confirmUpload(profileId, sha256, length);
					json(response, result === "stored" ? 201 : 200, {
						status: result,
						sha256,
						bytes: length,
						replication: options.replication ? "pending" : "unmanaged",
					});
					return;
				}
				if (request.method === "GET") {
					const token = bearer(request);
					const verifier = secureEqual(token, options.verifierToken);
					let delegated = false;
					let authority: AuthorizedObject;
					try {
						authority = verifier
							? await options.authority.authorizeServiceDownload(profileId, sha256)
							: await options.authority.authorizeDownload(token, profileId, sha256);
						if (!verifier && options.readLeases)
							await options.readLeases.remember(token, profileId, sha256, authority);
					} catch (error) {
						if (!verifier && options.readLeases && error instanceof ObjectDependencyError) {
							if (!error.unavailable) {
								await options.readLeases.rejectToken(token);
								throw error;
							}
							authority = await options.readLeases.authorize(token, profileId, sha256);
							delegated = true;
						} else throw error;
					}
					let bytes: Uint8Array;
					try {
						bytes = await options.store.get(profileId, sha256, authority.bytes);
					} catch (error) {
						if (
							delegated ||
							!(error instanceof Error) ||
							(error.message !== "Object not found" &&
								!(error instanceof ObjectDependencyError && error.unavailable))
						)
							throw error;
						bytes = await options.authority.readLegacyObject(profileId, sha256);
					}
					verified(bytes, sha256, authority.bytes);
					// Do not release bytes after a slow NAS read outlived its permission.
					if (delegated) await options.readLeases!.authorize(token, profileId, sha256);
					else {
						try {
							const current = verifier
								? await options.authority.authorizeServiceDownload(profileId, sha256)
								: await options.authority.authorizeDownload(token, profileId, sha256);
							if (current.bytes !== authority.bytes) throw new HttpError(503, "Object authority changed");
							// This also rechecks independent revocations that arrived during I/O.
							if (!verifier && options.readLeases)
								await options.readLeases.remember(token, profileId, sha256, current);
						} catch (error) {
							if (
								!verifier &&
								options.readLeases &&
								error instanceof ObjectDependencyError &&
								!error.unavailable
							)
								await options.readLeases.rejectToken(token);
							// A request admitted live cannot silently switch to offline authority
							// after retrieving bytes. The caller may start a separate bounded read.
							throw error;
						}
					}
					response.writeHead(200, {
						"cache-control": "private, no-store",
						"content-length": String(bytes.byteLength),
						"content-type": "application/octet-stream",
						etag: `"sha256-${sha256}"`,
						"x-qorpera-access-mode": delegated ? "bounded-read-lease" : "live-authority",
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
					if (options.replication)
						await options.replication.remove(profileId, sha256, bytes, authorization.authorizationId);
					else {
						await options.store.remove(profileId, sha256);
						await options.authority.finalizeDelete(authorization.authorizationId, profileId, sha256, bytes);
					}
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
					return;
				}
				throw new HttpError(405, "Method not allowed");
			} catch (error) {
				observation?.fail(
					error instanceof HttpError || error instanceof ObjectDependencyError ? error.status : undefined,
				);
				if (response.headersSent) {
					response.destroy();
					return;
				}
				if (error instanceof HttpError) {
					json(response, error.status, { error: error.message }, observation);
					return;
				}
				if (error instanceof ObjectDependencyError) {
					json(response, error.unavailable ? 503 : error.status, { error: error.message }, observation);
					return;
				}
				json(response, 503, { error: "Object gateway operation failed" }, observation);
			}
		})();
	};
}
