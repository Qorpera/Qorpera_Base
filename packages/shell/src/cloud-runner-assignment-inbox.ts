import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { CloudRunnerAssignmentAcceptance } from "./cloud-runner-control.ts";
import type { CloudRunnerAssignmentSource } from "./cloud-runner-worker.ts";

const ASSIGNMENT_SCHEMA = "qorpera.runner-assignment-delivery/v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 16 * 1024;

interface PendingNext {
	resolve: (assignment: CloudRunnerAssignmentAcceptance | undefined) => void;
	signal: AbortSignal;
	abort: () => void;
}

function assignmentFromBody(value: unknown): CloudRunnerAssignmentAcceptance {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Runner assignment delivery must be an object");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["schema", "assignment_id", "job_id", "capability"].includes(key)) ||
		input.schema !== ASSIGNMENT_SCHEMA ||
		typeof input.assignment_id !== "string" ||
		!UUID_PATTERN.test(input.assignment_id) ||
		typeof input.job_id !== "string" ||
		!UUID_PATTERN.test(input.job_id) ||
		typeof input.capability !== "string" ||
		!TOKEN_PATTERN.test(input.capability)
	) {
		throw new Error("Runner assignment delivery is invalid");
	}
	return {
		assignmentId: input.assignment_id,
		jobId: input.job_id,
		capability: input.capability,
	};
}

function sameAssignment(left: CloudRunnerAssignmentAcceptance, right: CloudRunnerAssignmentAcceptance): boolean {
	return (
		left.assignmentId === right.assignmentId && left.jobId === right.jobId && left.capability === right.capability
	);
}

/** Single-lane assignment delivery for an ephemeral runner. Process providers
 * use loopback. VM providers can bind the guest's private interface only when
 * they pin the one trusted host-bridge source in addition to the bearer token. */
export class HttpCloudRunnerAssignmentInbox implements CloudRunnerAssignmentSource {
	readonly #token: string;
	readonly #host: string;
	readonly #port: number;
	readonly #trustedSource?: string;
	#server?: Server;
	#queued?: CloudRunnerAssignmentAcceptance;
	#lastAccepted?: CloudRunnerAssignmentAcceptance;
	#pending?: PendingNext;

	constructor(host: string, port: number, token: string, trustedSource?: string) {
		const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
		if (
			(loopback && trustedSource !== undefined) ||
			(!loopback && (host !== "0.0.0.0" || !trustedSource || isIP(trustedSource) !== 4))
		) {
			throw new Error("Runner assignment inbox must be loopback-only or trust one VM-network source");
		}
		if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
			throw new Error("Runner assignment inbox port is invalid");
		}
		if (!TOKEN_PATTERN.test(token)) throw new Error("Runner assignment inbox token is invalid");
		this.#host = host;
		this.#port = port;
		this.#token = token;
		this.#trustedSource = trustedSource;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Runner assignment inbox is already started");
		const server = createServer((request, response) => {
			void this.#handle(request, response);
		});
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#port, this.#host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Runner assignment inbox address is unavailable");
		return address.port;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		this.#queued = undefined;
		if (this.#pending) {
			const pending = this.#pending;
			this.#pending = undefined;
			pending.signal.removeEventListener("abort", pending.abort);
			pending.resolve(undefined);
		}
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	next(signal: AbortSignal): Promise<CloudRunnerAssignmentAcceptance | undefined> {
		if (signal.aborted) return Promise.resolve(undefined);
		if (this.#queued) {
			const assignment = this.#queued;
			this.#queued = undefined;
			return Promise.resolve(assignment);
		}
		if (this.#pending) throw new Error("Runner assignment inbox already has a waiter");
		return new Promise((resolve) => {
			const abort = (): void => {
				if (this.#pending?.resolve !== resolve) return;
				this.#pending = undefined;
				resolve(undefined);
			};
			this.#pending = { resolve, signal, abort };
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("cache-control", "no-store");
		const source = request.socket.remoteAddress?.replace(/^::ffff:/, "");
		if (this.#trustedSource && source !== this.#trustedSource) {
			response.writeHead(403).end();
			return;
		}
		if (request.method === "GET" && request.url === "/healthz") {
			response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/assignment") {
			response.writeHead(404).end();
			return;
		}
		if (request.headers.authorization !== `Bearer ${this.#token}`) {
			response.writeHead(401).end();
			return;
		}
		try {
			let encoded = "";
			for await (const chunk of request) {
				encoded += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
				if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw new Error("request too large");
			}
			const assignment = assignmentFromBody(JSON.parse(encoded) as unknown);
			if (this.#lastAccepted && sameAssignment(this.#lastAccepted, assignment)) {
				response.writeHead(200, { "content-type": "application/json" }).end('{"accepted":true}\n');
				return;
			}
			if (this.#queued || this.#lastAccepted) {
				response.writeHead(409).end();
				return;
			}
			this.#lastAccepted = assignment;
			if (this.#pending) {
				const pending = this.#pending;
				this.#pending = undefined;
				pending.signal.removeEventListener("abort", pending.abort);
				pending.resolve(assignment);
			} else {
				this.#queued = assignment;
			}
			response.writeHead(202, { "content-type": "application/json" }).end('{"accepted":true}\n');
		} catch {
			response.writeHead(400).end();
		}
	}
}
