import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	COMPANY_PATH_PRESENCE_TTL_MS,
	type CompanyPathPresenceWire,
	type CompanyPresenceIdentity,
	type CompanyPresencePathRoutes,
	companyPresenceBytes,
	companyPresenceOverlap,
	companyPresencePaths,
	parseCompanyPathPresence,
	parseCompanyPresenceIdentity,
	parseCompanyPresenceRoutes,
	presenceUuid,
} from "@qorpera/cloud-client/company-path-presence";
import type { MemberCompanyPresenceReply } from "@qorpera/cloud-client/member-company-path-presence";
import { PresenceSignatures } from "@qorpera/cloud-client/presence-signatures";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";

function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new ObjectDependencyError(400);
	return value as Record<string, unknown>;
}
function current(statement: CompanyPathPresenceWire, companyId: string, environmentId: string): boolean {
	const now = Date.now();
	return (
		statement.companyId === companyId &&
		statement.environmentId === environmentId &&
		statement.expiresAt > now &&
		statement.issuedAt <= now + 2000 &&
		statement.issuedAt >= now - COMPANY_PATH_PRESENCE_TTL_MS
	);
}
/** Two independently authenticated readers. Native subject transactions retain
 * job-before-file lock order; no request receives a native binding or secret. */
export async function observeMemberCompanyPresence(options: {
	authority: MemberCompanyAuthority;
	token: string;
	companyId: string;
	environmentId: string;
	input: unknown;
	signal: AbortSignal;
}): Promise<MemberCompanyPresenceReply> {
	const { authority, token, companyId, environmentId, signal } = options;
	presenceUuid(companyId);
	presenceUuid(environmentId);
	const input = record(options.input, "candidates,paths,truncated");
	if (!Array.isArray(input.candidates) || input.candidates.length > 32 || typeof input.truncated !== "boolean")
		throw new ObjectDependencyError(400);
	let paths: string[], candidates: CompanyPathPresenceWire[];
	try {
		paths = companyPresencePaths(input.paths);
		candidates = input.candidates
			.map(parseCompanyPathPresence)
			.filter((statement) => current(statement, companyId, environmentId));
	} catch {
		throw new ObjectDependencyError(400);
	}
	const scope = async () => {
		signal.throwIfAborted();
		const row = record(
			await authority.member(
				"qorpera_company_presence_scope",
				token,
				{ p_environment_id: environmentId, p_binding: null, p_paths: paths },
				signal,
			),
			"companyId,environmentId,paths,schema",
		);
		if (
			row.schema !== "qorpera.company-presence-scope/v1" ||
			row.companyId !== companyId ||
			row.environmentId !== environmentId
		)
			throw new ObjectDependencyError(403);
		const routes = parseCompanyPresenceRoutes(row.paths, paths);
		if (routes.some((item) => !item.routes.some((route) => route.path === item.path)))
			throw new ObjectDependencyError(403);
		return routes;
	};
	const scoped = await scope();
	let partial = input.truncated;
	const groups = new Map<string, CompanyPathPresenceWire[]>();
	for (const statement of candidates) {
		const group = groups.get(statement.clientId) ?? [];
		group.push(statement);
		groups.set(statement.clientId, group);
	}
	const newest = new Map<
		string,
		{ statement: CompanyPathPresenceWire; identity: CompanyPresenceIdentity; allowed: CompanyPresencePathRoutes[] }
	>();
	const entries = [...groups.entries()];
	for (let index = 0; index < entries.length; index += 4)
		await Promise.all(
			entries.slice(index, index + 4).map(async ([clientId, statements]) => {
				try {
					signal.throwIfAborted();
					const value = await authority.publisher(
						"qorpera_native_presence_subject",
						{ p_environment_id: environmentId, p_client_id: clientId, p_paths: paths },
						signal,
					);
					if (value === null) return;
					const row = record(value, "identity,paths,schema");
					if (row.schema !== "qorpera.native-presence-subject/v1") throw new ObjectDependencyError(503);
					const identity = parseCompanyPresenceIdentity(row.identity),
						allowed = parseCompanyPresenceRoutes(row.paths, paths);
					if (
						identity.companyId !== companyId ||
						identity.environmentId !== environmentId ||
						identity.clientId !== clientId ||
						identity.expiresAt > Date.now() + COMPANY_PATH_PRESENCE_TTL_MS + 2000
					)
						throw new ObjectDependencyError(503);
					for (const statement of statements) {
						if (
							identity.expiresAt < statement.expiresAt ||
							!current(statement, companyId, environmentId) ||
							!(await PresenceSignatures.verify(
								identity.publicKey,
								companyPresenceBytes(statement),
								statement.signature,
							))
						)
							continue;
						if (!newest.has(clientId) || newest.get(clientId)!.statement.sequence < statement.sequence)
							newest.set(clientId, { statement, identity, allowed });
					}
				} catch {
					partial = true;
				}
			}),
		);
	// Refresh receiver permissions and HMAC namespaces after asynchronous checks.
	if (!isDeepStrictEqual(await scope(), scoped)) throw new ObjectDependencyError(403);
	signal.throwIfAborted();
	const observedAt = Date.now(),
		result: MemberCompanyPresenceReply = {
			companyId,
			environmentId,
			view: {
				schema: "qorpera.company-path-presence-view/v1",
				state: partial ? "partial" : "available",
				observedAt,
				paths: paths.map((path) => ({ path, participants: [] })),
			},
			confirmed: [],
		};
	for (const { statement, identity, allowed } of newest.values()) {
		if (!current(statement, companyId, environmentId)) continue;
		result.confirmed.push({ clientId: statement.clientId, sequence: statement.sequence });
		for (let index = 0; index < paths.length; index++)
			for (const claim of statement.routes) {
				const route = scoped[index].routes.find(
					(route) =>
						route.token === claim.token &&
						allowed[index].routes.some((item) => item.path === route.path && item.token === route.token),
				);
				const overlap = route && companyPresenceOverlap(claim, route.path, paths[index]);
				const participants = result.view.paths[index].participants;
				if (
					overlap &&
					!participants.some(
						(item) =>
							item.runId === identity.runId && item.activity === claim.activity && item.overlap === overlap,
					)
				)
					participants.push({
						staffAgentId: identity.staffAgentId,
						runId: identity.runId,
						activity: claim.activity,
						overlap,
						expiresAt: statement.expiresAt,
					});
			}
	}
	return result;
}

export async function serveMemberCompanyPresence(
	request: IncomingMessage,
	response: ServerResponse,
	authority: MemberCompanyAuthority,
): Promise<void> {
	const route = /^\/v1\/member-company-presence\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(request.url ?? "");
	if (!route) throw new ObjectDependencyError(404);
	try {
		presenceUuid(route[1]);
		presenceUuid(route[2]);
	} catch {
		throw new ObjectDependencyError(404);
	}
	if (request.method !== "POST") throw new ObjectDependencyError(405);
	const header = request.headers.authorization,
		length = request.headers["content-length"];
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	if (
		request.headers["content-type"] !== "application/json" ||
		!length ||
		!/^[1-9][0-9]{0,6}$/.test(length) ||
		Number(length) > 1024 * 1024
	)
		throw new ObjectDependencyError(400);
	const stop = new AbortController(),
		disconnected = () => {
			if (!response.writableFinished) stop.abort();
		};
	response.once("close", disconnected);
	try {
		const result = await withCloudDeadline(
			async (signal) => {
				const chunks: Buffer[] = [];
				let count = 0;
				const abortBody = () => {
					if (!request.complete) request.destroy();
				};
				signal.addEventListener("abort", abortBody, { once: true });
				try {
					signal.throwIfAborted();
					for await (const chunk of request) {
						signal.throwIfAborted();
						count += chunk.length;
						if (count > Number(length)) throw new ObjectDependencyError(413);
						chunks.push(Buffer.from(chunk));
					}
				} finally {
					signal.removeEventListener("abort", abortBody);
				}
				if (count !== Number(length)) throw new ObjectDependencyError(400);
				let input: unknown;
				try {
					input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
				} catch {
					throw new ObjectDependencyError(400);
				}
				return observeMemberCompanyPresence({
					authority,
					token: header.slice(7),
					companyId: route[1],
					environmentId: route[2],
					input,
					signal,
				});
			},
			2500,
			stop.signal,
		);
		stop.signal.throwIfAborted();
		response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
		response.end(JSON.stringify(result));
	} finally {
		stop.abort();
		response.removeListener("close", disconnected);
	}
}
