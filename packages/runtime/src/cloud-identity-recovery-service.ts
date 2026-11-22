import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type CloudIdentityRecoveryAuthority, recoveryCapability } from "./cloud-identity-recovery.ts";
import { parseRecoveryKeyBinding, recoveryRecord } from "./cloud-identity-recovery-crypto.ts";

export class HttpIdentityRecoveryService {
	readonly #authority: CloudIdentityRecoveryAuthority;
	readonly #operatorCapability: string;
	#server?: Server;
	#closing = false;
	#closePromise?: Promise<void>;
	#inFlight = 0;
	readonly #activeAborts = new Set<AbortController>();
	readonly #drainWaiters = new Set<() => void>();

	constructor(authority: CloudIdentityRecoveryAuthority, operatorCapability: string) {
		this.#authority = authority;
		this.#operatorCapability = recoveryCapability(operatorCapability);
	}

	async start(port = 0): Promise<string> {
		if (this.#server) throw new Error("Recovery service is already running");
		this.#closing = false;
		this.#closePromise = undefined;
		const server = createServer((request, response) => {
			void this.#handle(request, response).catch((error: unknown) => {
				// Operator diagnostics only: the error class and its bounded generic message; never a body, capability or key.
				const detail = error instanceof Error ? `${error.name}: ${error.message}` : "Error";
				console.error(`PHQL_RECOVERY_REQUEST_REFUSED ${request.url ?? ""} ${detail.slice(0, 200)}`);
				if (!response.headersSent) {
					response.writeHead(503, {
						"content-type": "application/json",
						"cache-control": "no-store",
						...(this.#closing ? { connection: "close" } : {}),
					});
					response.end('{"error":"Recovery operation refused or unavailable"}');
				} else if (!response.writableEnded) {
					response.destroy();
				}
			});
		});
		server.requestTimeout = 30_000;
		server.headersTimeout = 5_000;
		server.keepAliveTimeout = 1_000;
		server.maxHeadersCount = 32;
		server.maxConnections = 16;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		this.#server = server;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Recovery service has no listener");
		return `http://127.0.0.1:${address.port}`;
	}

	async close(graceMs = 25_000): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		const server = this.#server;
		if (!server) return;
		this.#closing = true;
		this.#server = undefined;
		const shuttingDown = (async () => {
			// WHY: Stop accepting new connections and close idle keep-alives before draining in-flight recovery calls so graceful shutdown finishes without severing active writes.
			const closed = new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			server.closeIdleConnections();
			if (this.#inFlight > 0) {
				const boundedGraceMs = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 25_000;
				if (boundedGraceMs > 0) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await new Promise<void>((resolve) => {
							const done = () => {
								this.#drainWaiters.delete(done);
								resolve();
							};
							this.#drainWaiters.add(done);
							if (this.#inFlight === 0) {
								done();
								return;
							}
							timer = setTimeout(done, boundedGraceMs);
							timer.unref?.();
						});
					} finally {
						if (timer) clearTimeout(timer);
					}
				}
				if (this.#inFlight > 0) {
					const shutdownError = new Error("Recovery service shutting down");
					for (const controller of this.#activeAborts) controller.abort(shutdownError);
					server.closeAllConnections();
				}
			}
			server.closeIdleConnections();
			await closed;
		})();
		this.#closePromise = shuttingDown;
		try {
			await shuttingDown;
		} finally {
			if (this.#closePromise === shuttingDown) this.#closePromise = undefined;
		}
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.#closing) {
			response.writeHead(503, { connection: "close" });
			response.end();
			return;
		}
		if (
			request.method !== "POST" ||
			request.headers.origin ||
			request.headers["content-type"] !== "application/json"
		) {
			response.writeHead(400);
			response.end();
			return;
		}
		const path = request.url;
		if (
			![
				"/v1/backup/prepare",
				"/v1/backup",
				"/v1/release",
				"/v1/complete",
				"/v1/provider-target",
				"/operator/target",
			].includes(path ?? "")
		) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (path === "/operator/target") {
			const supplied = request.headers.authorization;
			const expected = Buffer.from(`Bearer ${this.#operatorCapability}`);
			const suppliedBytes = typeof supplied === "string" ? Buffer.from(supplied) : undefined;
			let authorized = false;
			try {
				authorized =
					suppliedBytes !== undefined &&
					suppliedBytes.byteLength === expected.byteLength &&
					timingSafeEqual(suppliedBytes, expected);
			} finally {
				expected.fill(0);
				suppliedBytes?.fill(0);
			}
			if (!authorized) {
				response.writeHead(403);
				response.end();
				return;
			}
		}
		if (this.#inFlight >= 2) {
			response.writeHead(503);
			response.end();
			return;
		}
		this.#inFlight++;
		const abort = new AbortController();
		this.#activeAborts.add(abort);
		const disconnected = (): void => {
			if (!response.writableEnded) abort.abort(new Error("Recovery peer disconnected"));
		};
		response.once("close", disconnected);
		try {
			await withCloudDeadline(
				async (signal) => {
					const stopReading = (): void => {
						if (!request.complete) request.destroy();
					};
					signal.addEventListener("abort", stopReading, { once: true });
					const chunks: Buffer[] = [];
					let body: Buffer | undefined;
					let size = 0;
					let value: unknown;
					try {
						for await (const chunk of request) {
							signal.throwIfAborted();
							const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
							size += bytes.byteLength;
							if (size > 16_384) {
								bytes.fill(0);
								throw new Error("Recovery request exceeds its bound");
							}
							chunks.push(bytes);
						}
						body = Buffer.concat(chunks);
						value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(body));
					} finally {
						signal.removeEventListener("abort", stopReading);
						for (const chunk of chunks) chunk.fill(0);
						body?.fill(0);
					}
					let result: unknown;
					if (path === "/v1/backup/prepare") {
						const input = recoveryRecord(value, ["loginId", "loginCapability", "keySha256"]);
						result = await this.#authority.prepareBackup(
							String(input.loginId),
							String(input.loginCapability),
							String(input.keySha256),
							signal,
						);
					} else if (path === "/v1/backup") {
						const input = recoveryRecord(value, ["loginId", "loginCapability", "binding", "wrappedKey"]);
						result = await this.#authority.backup(
							{
								loginId: String(input.loginId),
								loginCapability: String(input.loginCapability),
								binding: parseRecoveryKeyBinding(input.binding),
								wrappedKey: String(input.wrappedKey),
							},
							signal,
						);
					} else if (path === "/v1/release") {
						const input = recoveryRecord(value, ["recoveryId", "targetCapability"]);
						const release = await this.#authority.release(
							String(input.recoveryId),
							String(input.targetCapability),
							signal,
						);
						result =
							release instanceof Uint8Array
								? { release: Buffer.from(release).toString("base64url") }
								: { receipt: release };
					} else if (path === "/v1/complete") {
						const input = recoveryRecord(value, ["recoveryId", "targetCapability", "releaseSha256", "proof"]);
						result = await this.#authority.complete(
							String(input.recoveryId),
							String(input.targetCapability),
							String(input.releaseSha256),
							String(input.proof),
							signal,
						);
					} else if (path === "/v1/provider-target") {
						// 2026-09-17 amendment: a runtime node's login gateway registers a
						// target for a guest on its own node; the registrar capability is
						// enrolled by the operator and compared by digest in SQL.
						const input = recoveryRecord(value, [
							"registrarNodeId",
							"registrarCapability",
							"targetId",
							"computeIdentityId",
							"nodeId",
							"imageSha256",
							"guestManifestSha256",
							"recipientPublicKey",
							"targetCapability",
						]);
						result = await this.#authority.registerTargetByRegistrar(
							{
								registrarNodeId: String(input.registrarNodeId),
								registrarCapability: String(input.registrarCapability),
								targetId: String(input.targetId),
								computeIdentityId: String(input.computeIdentityId),
								nodeId: String(input.nodeId),
								imageSha256: String(input.imageSha256),
								guestManifestSha256: String(input.guestManifestSha256),
								recipientPublicKey: String(input.recipientPublicKey),
								targetCapability: String(input.targetCapability),
							},
							signal,
						);
					} else {
						const input = recoveryRecord(value, [
							"targetId",
							"computeIdentityId",
							"nodeId",
							"imageSha256",
							"guestManifestSha256",
							"recipientPublicKey",
							"targetCapability",
						]);
						result = await this.#authority.registerTarget(
							{
								targetId: String(input.targetId),
								computeIdentityId: String(input.computeIdentityId),
								nodeId: String(input.nodeId),
								imageSha256: String(input.imageSha256),
								guestManifestSha256: String(input.guestManifestSha256),
								recipientPublicKey: String(input.recipientPublicKey),
								targetCapability: String(input.targetCapability),
							},
							signal,
						);
					}
					signal.throwIfAborted();
					response.writeHead(200, {
						"content-type": "application/json",
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
						...(this.#closing ? { connection: "close" } : {}),
					});
					response.end(JSON.stringify(result));
				},
				30_000,
				abort.signal,
			);
		} finally {
			abort.abort(new Error("Recovery request closed"));
			this.#activeAborts.delete(abort);
			response.removeListener("close", disconnected);
			this.#inFlight--;
			if (this.#inFlight === 0) {
				for (const notify of [...this.#drainWaiters]) notify();
			}
		}
	}
}
