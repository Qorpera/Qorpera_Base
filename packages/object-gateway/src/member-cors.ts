import type { IncomingMessage, ServerResponse } from "node:http";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OBJECT = new RegExp(`^/v1/member-company(?:-snapshot)?-objects/${UUID}/${UUID}/[0-9a-f]{64}$`);
const UPLOAD = new RegExp(`^/v1/member-company-file/${UUID}/uploads$`);
const EXPORT = new RegExp(`^/v1/member-file-exports/${UUID}/${UUID}/[0-9a-f]{64}$`);
const FOLDER_OBJECT = new RegExp(`^/v1/member-folder-objects/${UUID}/[0-9a-f]{64}$`);
const FOLDER_COMMIT = new RegExp(`^/v1/member-folder-commits/${UUID}$`);
const PRESENCE = new RegExp(`^/v1/member-company-presence/${UUID}/${UUID}$`);
const FILE = new RegExp(
	`^/v1/member-company-file/${UUID}/(edits|proposals)(?:/(${UUID}))?(?:/(review|content|file))?$`,
);
const ATTACHMENT = new RegExp(`^/v1/member-session-attachments/(upload|input)/${UUID}/${UUID}/[0-9a-f]{64}$`);

function route(url: string): { method: string; headers: string[] } | undefined {
	if (PRESENCE.test(url)) return { method: "POST", headers: ["authorization", "content-type"] };
	if (EXPORT.test(url)) return { method: "GET", headers: ["authorization"] };
	if (FOLDER_OBJECT.test(url)) return { method: "GET", headers: ["authorization"] };
	if (FOLDER_COMMIT.test(url)) return { method: "POST", headers: ["authorization", "content-type"] };
	if (UPLOAD.test(url))
		return { method: "PUT", headers: ["authorization", "content-type", "x-qorpera-company-upload"] };
	if (OBJECT.test(url)) return { method: "GET", headers: ["authorization", "x-qorpera-company-path"] };
	const file = FILE.exec(url);
	if (file) {
		const [, kind, target, action] = file;
		if (!target && (kind !== "edits" || action)) return undefined;
		if (kind === "proposals" && !action) return undefined;
		return {
			method: !target || action === "review" ? "POST" : "GET",
			headers: ["authorization", "content-type"],
		};
	}
	const attachment = ATTACHMENT.exec(url);
	if (attachment)
		return { method: attachment[1] === "upload" ? "PUT" : "GET", headers: ["authorization", "content-type"] };
	return undefined;
}

/** CORS grants browser transport access only. Every actual request still
 * passes the existing member bearer-token and current resource authority. */
export function createMemberCors(
	origins: readonly string[] = [],
): (request: IncomingMessage, response: ServerResponse) => boolean {
	if (!Array.isArray(origins) || origins.length > 32) throw new Error("Invalid member client origins");
	const allowed = new Set<string>();
	for (const origin of origins) {
		if (typeof origin !== "string" || origin.length > 2048) throw new Error("Invalid member client origin");
		const url = new URL(origin);
		if (
			url.origin !== origin ||
			url.username ||
			url.password ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
			allowed.has(origin)
		)
			throw new Error("Invalid member client origin");
		allowed.add(origin);
	}
	return (request, response) => {
		const preflight = request.method === "OPTIONS";
		response.setHeader(
			"vary",
			preflight ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" : "Origin",
		);
		const origin = request.headers.origin;
		if (origin === undefined && !preflight) return false;
		const policy = route(request.url ?? "");
		const requested = request.headers["access-control-request-headers"];
		const headers =
			typeof requested === "string"
				? requested
						.toLowerCase()
						.split(",")
						.map((name) => name.trim())
				: [];
		if (
			typeof origin !== "string" ||
			!allowed.has(origin) ||
			!policy ||
			(preflight ? request.headers["access-control-request-method"] : request.method) !== policy.method ||
			(preflight &&
				(Array.isArray(requested) ||
					(requested !== undefined &&
						(requested.length > 1024 || headers.some((name) => !policy.headers.includes(name))))))
		) {
			response.writeHead(403, { "cache-control": "no-store", "content-type": "application/json" });
			response.end(JSON.stringify({ error: "Browser origin or member route is not allowed" }));
			return true;
		}
		response.setHeader("access-control-allow-origin", origin);
		if (!preflight) {
			response.setHeader("access-control-expose-headers", "x-qorpera-access-mode, etag, x-qorpera-plan-sha256");
			return false;
		}
		response.writeHead(204, {
			"cache-control": "no-store",
			"access-control-allow-methods": policy.method,
			"access-control-allow-headers": policy.headers.join(", "),
			"access-control-max-age": "0",
		});
		response.end();
		return true;
	};
}
