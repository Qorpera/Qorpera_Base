import { timingSafeEqual } from "node:crypto";
import type { CloudRunnerProviderServiceBackend } from "./provider-service.ts";
import { executeCloudRunnerProviderRequest } from "./provider-service.ts";

const MAX_REQUEST_BYTES = 256 * 1024;

function tokenMatches(expected: string, authorization: string | null): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const received = Buffer.from(authorization.slice("Bearer ".length), "utf-8");
	const wanted = Buffer.from(expected, "utf-8");
	return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function json(value: unknown, status: number): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export class WebCloudRunnerProviderService {
	readonly #backend: CloudRunnerProviderServiceBackend;
	readonly #token: string;

	constructor(backend: CloudRunnerProviderServiceBackend, token: string) {
		if (!token.trim() || token.length > 4096 || /[\0\r\n]/.test(token)) {
			throw new Error("Provider token is invalid");
		}
		this.#backend = backend;
		this.#token = token;
	}

	async handle(request: Request): Promise<Response> {
		if (request.method === "GET") return json({ ok: true }, 200);
		if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
		if (!tokenMatches(this.#token, request.headers.get("authorization"))) {
			return json({ error: "Unauthorized" }, 401);
		}
		try {
			const declared = Number(request.headers.get("content-length") ?? "0");
			if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
				return json({ error: "Request is too large" }, 413);
			}
			const encoded = await request.text();
			if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) return json({ error: "Request is too large" }, 413);
			return json(
				{
					value: await executeCloudRunnerProviderRequest(
						this.#backend,
						JSON.parse(encoded) as unknown,
						request.signal,
					),
				},
				200,
			);
		} catch (error) {
			/* The 422 body stays generic (the caller is a remote control plane),
			 * but the operator needs the actual refusal in the journal. */
			console.error(
				`provider request rejected: ${error instanceof Error ? error.message : String(error)}`,
			);
			return json({ error: error instanceof SyntaxError ? "Invalid JSON" : "Request rejected" }, 422);
		}
	}
}
