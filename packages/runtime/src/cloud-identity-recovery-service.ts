import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type CloudIdentityRecoveryAuthority, recoveryCapability } from "./cloud-identity-recovery.ts";
import { parseRecoveryKeyBinding, recoveryRecord } from "./cloud-identity-recovery-crypto.ts";

export class HttpIdentityRecoveryService {
	readonly #authority: CloudIdentityRecoveryAuthority;
	readonly #operatorCapability: string;
	#server?: Server;
	#inFlight = 0;

	constructor(authority: CloudIdentityRecoveryAuthority, operatorCapability: string) {
		this.#authority = authority;
		this.#operatorCapability = recoveryCapability(operatorCapability);
	}

	async start(port = 0): Promise<string> {
		if (this.#server) throw new Error("Recovery service is already running");
		const server = createServer((request, response) => {
			void this.#handle(request, response).catch(() => {
				if (!response.headersSent)
					response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
				response.end('{"error":"Recovery operation refused or unavailable"}');
			});
		});
		server.requestTimeout = 30_000;
		server.headersTimeout = 5_000;
		server.keepAliveTimeout = 1_000;
		server.maxHeadersCount = 32;
		server.maxConnections = 16;
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Recovery service has no listener");
		return `http://127.0.0.1:${address.port}`;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
			!["/v1/backup/prepare", "/v1/backup", "/v1/release", "/v1/complete", "/operator/target"].includes(path ?? "")
		) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (path === "/operator/target") {
			const supplied = request.headers.authorization;
			const expected = Buffer.from(`Bearer ${this.#operatorCapability}`);
			if (
				typeof supplied !== "string" ||
				Buffer.byteLength(supplied) !== expected.byteLength ||
				!timingSafeEqual(Buffer.from(supplied), expected)
			) {
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
					let size = 0;
					try {
						for await (const chunk of request) {
							signal.throwIfAborted();
							const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
							size += bytes.byteLength;
							if (size > 16_384) throw new Error("Recovery request exceeds its bound");
							chunks.push(bytes);
						}
					} finally {
						signal.removeEventListener("abort", stopReading);
					}
					const value: unknown = JSON.parse(
						new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
					);
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
					});
					response.end(JSON.stringify(result));
				},
				30_000,
				abort.signal,
			);
		} finally {
			abort.abort(new Error("Recovery request closed"));
			response.removeListener("close", disconnected);
			this.#inFlight--;
		}
	}
}
