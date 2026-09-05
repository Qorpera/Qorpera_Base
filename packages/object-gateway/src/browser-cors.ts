import type { IncomingMessage, ServerResponse } from "node:http";

/** CORS admits the web UI to member routes; every actual request still needs live member authority. */
export function handleMemberBrowserRequest(request: IncomingMessage, response: ServerResponse): boolean {
	const origin = request.headers.origin;
	if (!origin) return false;
	const allowed =
		origin === "https://app.qorpera.com" ||
		origin === "https://qorpera-web.pages.dev" ||
		/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.qorpera-web\.pages\.dev$/.test(origin);
	const path = request.url ?? "";
	const memberRoute = /^\/v1\/member-company-(?:file|objects)\//.test(path);
	if (!memberRoute) return false;
	if (!allowed) {
		response.writeHead(403, { "cache-control": "no-store", vary: "Origin" });
		response.end();
		return true;
	}
	response.setHeader("vary", "Origin");
	response.setHeader("access-control-allow-origin", origin);
	response.setHeader("access-control-expose-headers", "x-qorpera-access-mode, content-length");
	if (request.method !== "OPTIONS") return false;
	const method = request.headers["access-control-request-method"];
	const headers = request.headers["access-control-request-headers"];
	if (
		typeof method !== "string" ||
		!["GET", "POST"].includes(method) ||
		(typeof headers === "string" &&
			headers
				.split(",")
				.some(
					(name) =>
						!["authorization", "content-type", "x-qorpera-company-path"].includes(name.trim().toLowerCase()),
				))
	) {
		response.writeHead(403);
		response.end();
		return true;
	}
	response.writeHead(204, {
		"access-control-allow-methods": "GET, POST",
		"access-control-allow-headers": "authorization, content-type, x-qorpera-company-path",
		"access-control-max-age": "600",
	});
	response.end();
	return true;
}
