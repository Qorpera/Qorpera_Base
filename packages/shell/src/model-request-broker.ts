import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelRuntime } from "@qorpera/pi-coding-agent";
import { brokerCredentialProjection, isScopedInferenceTarget } from "./model-request-scope.ts";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

interface BrokerSession {
	handles: Map<string, string>;
}

export interface BrokeredCredentials {
	token: string;
	handles: string[];
	credentials: Record<string, unknown>;
	release: () => void;
}

export interface ModelRequestBroker {
	port: number;
	registerChild: (sourceCredentials: Record<string, unknown>, ambientProviders: string[]) => BrokeredCredentials;
	close: () => void;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		request.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_REQUEST_BYTES) {
				reject(new Error("model request exceeds 64 MiB"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolvePromise(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

function sendError(response: ServerResponse, status: number, message: string): void {
	if (response.headersSent) return;
	response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	response.end(message);
}

function codexAccountId(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const auth = (parsed as Record<string, unknown>)["https://api.openai.com/auth"];
		if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

async function forwardModelRequest(
	request: IncomingMessage,
	response: ServerResponse,
	runtime: ModelRuntime,
	sessions: Map<string, BrokerSession>,
	allowedDomains: ReadonlySet<string>,
): Promise<void> {
	if (request.method !== "POST") return sendError(response, 405, "model broker accepts POST inference only");
	const token = request.headers["x-qorpera-model-token"];
	const handle = request.headers["x-qorpera-model-handle"];
	const targetValue = request.headers["x-qorpera-model-target"];
	if (typeof token !== "string" || typeof handle !== "string" || typeof targetValue !== "string") {
		return sendError(response, 401, "missing model broker capability");
	}
	const provider = sessions.get(token)?.handles.get(handle);
	if (!provider) return sendError(response, 403, "invalid model broker capability");
	let target: URL;
	try {
		target = new URL(targetValue);
	} catch {
		return sendError(response, 400, "invalid model target");
	}
	const auth = await runtime.getAuth(provider);
	const baseUrls = auth
		? [auth.auth.baseUrl, ...runtime.getModels(provider).map((model) => model.baseUrl)].filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	if (!auth || !isScopedInferenceTarget(baseUrls, target, allowedDomains)) {
		return sendError(response, 403, "model target is outside the provider inference scope");
	}
	let handleFound = false;
	for (const [name, rawValue] of Object.entries(request.headers)) {
		if (name.startsWith("x-qorpera-model-") || HOP_BY_HOP_HEADERS.has(name)) continue;
		const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue];
		for (const value of values) {
			if (value.includes(handle)) handleFound = true;
		}
	}
	for (const [name, value] of target.searchParams) {
		if (!value.includes(handle)) continue;
		handleFound = true;
		if (!auth.auth.apiKey) return sendError(response, 403, "provider query authentication is unavailable");
		target.searchParams.set(name, value.replaceAll(handle, auth.auth.apiKey));
	}
	if (!handleFound) return sendError(response, 403, "model request is not bound to its opaque handle");
	const headers = new Headers();
	for (const [name, rawValue] of Object.entries(request.headers)) {
		if (name.startsWith("x-qorpera-model-") || HOP_BY_HOP_HEADERS.has(name)) continue;
		const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue];
		for (const value of values) {
			if (value.includes(handle) && !auth.auth.apiKey) continue;
			headers.append(name, auth.auth.apiKey ? value.replaceAll(handle, auth.auth.apiKey) : value);
		}
	}
	for (const [name, value] of Object.entries(auth.auth.headers ?? {})) {
		if (typeof value === "string") headers.set(name, value);
	}
	if (provider === "openai-codex" && auth.auth.apiKey) {
		const accountId = codexAccountId(auth.auth.apiKey);
		if (!accountId) return sendError(response, 403, "provider account identity is unavailable");
		headers.set("chatgpt-account-id", accountId);
	}
	const body = await readBody(request);
	const upstream = await fetch(target, { method: "POST", headers, body, redirect: "manual" });
	const responseHeaders: Record<string, string> = {};
	for (const [name, value] of upstream.headers) {
		if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie")
			responseHeaders[name] = value;
	}
	response.writeHead(upstream.status, responseHeaders);
	if (!upstream.body) {
		response.end();
		return;
	}
	for await (const chunk of upstream.body) response.write(chunk);
	response.end();
}

export async function startModelRequestBroker(options: {
	authPath: string;
	modelsPath: string;
	allowedProviders: ReadonlySet<string>;
	allowedDomains: ReadonlySet<string>;
}): Promise<ModelRequestBroker> {
	const runtime = await ModelRuntime.create({
		authPath: options.authPath,
		modelsPath: options.modelsPath,
		allowModelNetwork: false,
	});
	const sessions = new Map<string, BrokerSession>();
	const server: Server = createServer((request, response) => {
		void forwardModelRequest(request, response, runtime, sessions, options.allowedDomains).catch(() => {
			sendError(response, 502, "model broker request failed");
		});
	});
	server.on("connect", (_request, socket) => socket.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n"));
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		registerChild: (sourceCredentials, ambientProviders) => {
			const token = randomUUID();
			const projection = brokerCredentialProjection(sourceCredentials, ambientProviders, options.allowedProviders);
			sessions.set(token, { handles: projection.handles });
			return {
				token,
				handles: [...projection.handles.keys()],
				credentials: projection.credentials,
				release: () => sessions.delete(token),
			};
		},
		close: () => server.close(),
	};
}
