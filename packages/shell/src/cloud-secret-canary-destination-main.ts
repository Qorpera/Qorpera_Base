import { timingSafeEqual } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Step2SecretCanaryBehavior } from "./cloud-secret-canary-adapter.ts";
import { Step2SecretCanaryLedger, step2SecretCanaryReflection } from "./cloud-secret-canary-destination.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BEHAVIORS = new Set<Step2SecretCanaryBehavior>([
	"safe",
	"reflect_raw",
	"reflect_url",
	"reflect_base64",
	"reflect_base64url",
	"drop_once",
	"stall",
]);
const STATE_PATH = "/var/lib/qorpera-secret-canary/effects.json";
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;

async function credential(directory: string, name: string): Promise<Buffer> {
	if (!isAbsolute(directory) || !/^[a-z][a-z0-9-]+$/.test(name)) {
		throw new Error("Step 2 secret canary credential path is invalid");
	}
	const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
	try {
		const metadata = await handle.stat();
		if (
			metadata.size < 1 ||
			!systemdCredentialMetadataIsSafe(
				{
					isFile: metadata.isFile(),
					size: metadata.size,
					uid: metadata.uid,
					gid: metadata.gid,
					mode: metadata.mode,
				},
				process.geteuid?.(),
				MAX_CREDENTIAL_BYTES,
				"linux",
			)
		) {
			throw new Error("Step 2 secret canary credential is unsafe");
		}
		const read = await handle.read(bytes, 0, bytes.byteLength, 0);
		if (read.bytesRead !== metadata.size || read.bytesRead > MAX_CREDENTIAL_BYTES) {
			throw new Error("Step 2 secret canary credential changed during read");
		}
		return Buffer.from(bytes.subarray(0, read.bytesRead));
	} finally {
		bytes.fill(0);
		await handle.close();
	}
}

function tokenMatches(expected: Uint8Array, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
	try {
		return supplied.byteLength === expected.byteLength && timingSafeEqual(expected, supplied);
	} finally {
		supplied.fill(0);
	}
}

async function requestBody(request: NodeJS.ReadableStream): Promise<unknown> {
	const chunks: Buffer[] = [];
	let length = 0;
	let body: Buffer | undefined;
	try {
		for await (const value of request) {
			const chunk = Buffer.from(value as Uint8Array);
			length += chunk.byteLength;
			if (length > MAX_REQUEST_BYTES) throw new Error("Step 2 secret canary request is too large");
			chunks.push(chunk);
		}
		body = Buffer.concat(chunks);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
	} finally {
		body?.fill(0);
		for (const chunk of chunks) chunk.fill(0);
	}
}

function canaryRequest(value: unknown): { readonly label: string; readonly behavior: Step2SecretCanaryBehavior } {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Step 2 secret canary request is invalid");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).sort().join() !== ["behavior", "label", "schema"].sort().join() ||
		input.schema !== "qorpera.step2-secret-canary-request/v1" ||
		typeof input.label !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.label) ||
		typeof input.behavior !== "string" ||
		!BEHAVIORS.has(input.behavior as Step2SecretCanaryBehavior)
	) {
		throw new Error("Step 2 secret canary request is invalid");
	}
	return { label: input.label, behavior: input.behavior as Step2SecretCanaryBehavior };
}

function json(reply: ServerResponse, status: number, value: object): void {
	const body = JSON.stringify(value);
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	reply.end(body);
}

export async function runStep2SecretCanaryDestinationMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (process.platform !== "linux") throw new Error("The Step 2 secret canary requires Linux");
	const directory = environment.CREDENTIALS_DIRECTORY;
	if (!directory || !isAbsolute(directory)) throw new Error("The Step 2 secret canary requires systemd credentials");
	const [token, privateKey, certificate] = await Promise.all([
		credential(directory, "qorpera-step2-canary-provider-token"),
		credential(directory, "qorpera-step2-canary-tls-key"),
		credential(directory, "qorpera-step2-canary-tls-cert"),
	]);
	try {
		if (!TOKEN.test(token.toString("utf8"))) throw new Error("Step 2 secret canary token is invalid");
		const ledger = await Step2SecretCanaryLedger.open(STATE_PATH);
		const server = createServer({ key: privateKey, cert: certificate }, (request, reply) => {
			void (async () => {
				if (request.method === "GET" && request.url === "/healthz") {
					json(reply, 200, { schema: "qorpera.step2-secret-canary-health/v1", status: "ready" });
					return;
				}
				if (
					request.method !== "POST" ||
					request.url !== "/v1/effects" ||
					request.headers["content-type"]?.split(";", 1)[0] !== "application/json" ||
					!tokenMatches(token, request.headers.authorization) ||
					typeof request.headers["idempotency-key"] !== "string" ||
					!OPERATION_KEY.test(request.headers["idempotency-key"])
				) {
					json(reply, 404, { schema: "qorpera.step2-secret-canary-error/v1", error: "not_found" });
					return;
				}
				const input = canaryRequest(await requestBody(request));
				if (input.behavior === "stall") {
					await new Promise<void>((resolveWait) => {
						const timeout = setTimeout(resolveWait, 60_000);
						request.once("close", () => {
							clearTimeout(timeout);
							resolveWait();
						});
					});
					if (!reply.destroyed)
						json(reply, 504, { schema: "qorpera.step2-secret-canary-error/v1", error: "stalled" });
					return;
				}
				const admitted = await ledger.admit(request.headers["idempotency-key"], input.label, input.behavior);
				if (input.behavior === "drop_once" && !admitted.reused) {
					reply.destroy();
					return;
				}
				const reflection = step2SecretCanaryReflection(token, input.behavior);
				json(reply, 200, {
					schema: "qorpera.step2-secret-canary-result/v1",
					status: "completed",
					effectId: admitted.effectId,
					reused: admitted.reused,
					...(reflection === undefined ? {} : { reflection }),
				});
			})().catch(() => {
				if (!reply.headersSent && !reply.destroyed) {
					json(reply, 403, { schema: "qorpera.step2-secret-canary-error/v1", error: "unavailable" });
				} else {
					reply.destroy();
				}
			});
		});
		server.requestTimeout = 70_000;
		server.headersTimeout = 10_000;
		server.keepAliveTimeout = 5000;
		server.maxRequestsPerSocket = 10;
		privateKey.fill(0);
		certificate.fill(0);
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(9443, "127.0.0.1", resolveListen);
		});
		const stop = new AbortController();
		const shutdown = (): void => stop.abort();
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			await new Promise<void>((resolveWait) => {
				if (stop.signal.aborted) resolveWait();
				else stop.signal.addEventListener("abort", () => resolveWait(), { once: true });
			});
		} finally {
			process.removeListener("SIGINT", shutdown);
			process.removeListener("SIGTERM", shutdown);
			await new Promise<void>((resolveClose, rejectClose) =>
				server.close((error) => (error ? rejectClose(error) : resolveClose())),
			);
		}
	} finally {
		token.fill(0);
		privateKey.fill(0);
		certificate.fill(0);
	}
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log("Qorpera Step 2 secret-custody HTTPS canary destination.");
	} else {
		runStep2SecretCanaryDestinationMain().catch(() => {
			console.error("The Step 2 secret-custody canary destination could not start or continue.");
			process.exitCode = 1;
		});
	}
}
