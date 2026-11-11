import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudMemberMachineAct,
	CloudMemberMachineActRefusal,
	type CloudMemberMachineScreen,
	CloudMemberMachineScreenRefusal,
	parseCloudMemberMachineAction,
} from "./cloud-machine-command-http.ts";
import type { MachineScreenAction } from "./cloud-machine-screen.ts";

// A member's look at an agent's desktop computer (20260930712000): the coding executor's third listener, on loopback
// only, reached from the browser through the member bridge (supabase/functions/member-company-gateway) and the node's
// mux, which sends it /v1/member-machine-screens/ alone. It answers
//   GET /v1/member-machine-screens/<companyId>/<machineId>[/watching]
// with the member's own bearer token (and the etag of the picture the member has in If-None-Match): the picture
// (200, image/png, with its etag), the same picture (304), or why there is none (409 with a fixed code). `/watching`
// says the member still watches (they opened the window, touched it, or answered "Still watching?"), which keeps the
// desktop on for 30 minutes from then. The token is checked by the database alone (the executor begins the look as the
// member: qorpera_member_machine_screen_begin), never by this listener; it is never logged, stored or put in an answer.
// A member who holds the desktop (20260930713000) acts on it with
//   POST /v1/member-machine-screens/<companyId>/<machineId>/act   {"action": {...}}
// (application/json, at most 16 KiB): one of machine_screen's actions, never `open`. The answer is the action's exit
// (200, {"schema": "qorpera.member-machine-act/v1", "exitCode"}) or why it did not run (409 with a fixed code); a body
// that is not one is 400. What the member typed is in that body: it is passed to the machine and nowhere else, never
// logged, stored, answered or put in an error.

/** A company's and a machine's ids, lower-case as the database writes them, and `/watching` or `/act`. */
const UUID = UUID_PATTERN.source.slice(1, -1);
const ROUTE = new RegExp(`^/v1/member-machine-screens/(${UUID})/(${UUID})(/watching|/act)?$`);
/** A member's action: one action, a text of at most 500 characters in it. */
const ACT_BODY_BYTES = 16384;
const BEARER = /^Bearer ([A-Za-z0-9._~-]{1,8192})$/;
const IF_NONE_MATCH = /^"([0-9a-f]{64})"$/;
/** The member bridge gives a request 25 s; the look's own steps (the begin, the read, a forward, the look, the release)
 * are bounded inside this. */
const REQUEST_MS = 30000;

/** One look, as the listener read it from the member's request. */
export interface CloudMemberMachineScreenLook {
	readonly companyId: string;
	readonly machineId: string;
	/** The member's bearer token, passed on to the database and nowhere else. */
	readonly token: string;
	/** The member said they still watch. */
	readonly confirmed: boolean;
	/** The etag of the picture the member has, or null. */
	readonly etag: string | null;
}
/** One action, as the listener read it from the member's request. */
export interface CloudMemberMachineActRequest {
	readonly companyId: string;
	readonly machineId: string;
	/** The member's bearer token, passed on to the database and nowhere else. */
	readonly token: string;
	readonly action: MachineScreenAction;
}
/** The database did not take the member's token (401). */
export class CloudMemberMachineScreenSignIn extends Error {
	constructor() {
		super("MEMBER_SIGN_IN_REQUIRED");
	}
}
/** The member may not watch this machine, or it is not there for them (403). */
export class CloudMemberMachineScreenForbidden extends Error {
	constructor() {
		super("MACHINE_SCREEN_FORBIDDEN");
	}
}

export interface CloudMemberMachineScreenServiceOptions {
	look(request: CloudMemberMachineScreenLook, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
	/** A member's action on a desktop they hold (20260930713000); without it the route is 404. */
	act?(request: CloudMemberMachineActRequest, signal: AbortSignal): Promise<CloudMemberMachineAct>;
	host?: "127.0.0.1" | "::1";
	port?: number;
	/** A look that failed for another reason than the member's, by its fixed code: for the executor's log. */
	failed?(code: string): void;
}

/** The member's action: a JSON body of at most ACT_BODY_BYTES, `{"action": {...}}` and nothing else, the action one of
 * machine_screen's but `open`; undefined for anything else. Nothing of the body is kept or told. */
async function readAction(request: IncomingMessage, signal: AbortSignal): Promise<MachineScreenAction | undefined> {
	if (request.headers["content-type"] !== "application/json") return undefined;
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		signal.throwIfAborted();
		bytes += (chunk as Buffer).length;
		if (bytes > ACT_BODY_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	try {
		const body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join() !== "action")
			return undefined;
		return parseCloudMemberMachineAction((body as { action: unknown }).action);
	} catch {
		return undefined;
	}
}

function replyJson(reply: ServerResponse, status: number, value: Record<string, string | number | null>): void {
	const body = JSON.stringify(value);
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	reply.end(body);
}

/** Loopback only, behind the node's mux. Each request is bounded at 30 s and ends with its client. */
export class HttpCloudMemberMachineScreenService {
	readonly #options: CloudMemberMachineScreenServiceOptions;
	readonly #controllers = new Set<AbortController>();
	#server?: Server;
	constructor(options: CloudMemberMachineScreenServiceOptions) {
		if (
			typeof options.look !== "function" ||
			(options.act !== undefined && typeof options.act !== "function") ||
			(options.host !== undefined && !["127.0.0.1", "::1"].includes(options.host)) ||
			!Number.isSafeInteger(options.port ?? 0) ||
			(options.port ?? 0) < 0 ||
			(options.port ?? 0) > 65535
		)
			throw new Error("MEMBER_MACHINE_SCREEN_CONFIG_INVALID");
		this.#options = Object.freeze({ ...options });
	}
	async start(signal?: AbortSignal): Promise<number> {
		if (this.#server) throw new Error("MEMBER_MACHINE_SCREEN_STARTED");
		signal?.throwIfAborted();
		const server = createServer((request, reply) => {
			void this.#handle(request, reply);
		});
		this.#server = server;
		server.requestTimeout = 15000;
		server.headersTimeout = 10000;
		server.keepAliveTimeout = 5000;
		server.maxRequestsPerSocket = 100;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => reject(error);
				server.once("error", onError);
				server.listen(this.#options.port ?? 0, this.#options.host ?? "127.0.0.1", () => {
					server.off("error", onError);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("MEMBER_MACHINE_SCREEN_UNAVAILABLE");
			const abort = (): void => {
				void this.close();
			};
			signal?.addEventListener("abort", abort, { once: true });
			server.once("close", () => signal?.removeEventListener("abort", abort));
			if (signal?.aborted) {
				await this.close();
				throw new Error("MEMBER_MACHINE_SCREEN_UNAVAILABLE");
			}
			return address.port;
		} catch {
			this.#server = undefined;
			server.close();
			throw new Error("MEMBER_MACHINE_SCREEN_UNAVAILABLE");
		}
	}
	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const controller of this.#controllers) controller.abort();
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	}
	async #handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const timeout = setTimeout(() => controller.abort(), REQUEST_MS);
		const disconnect = (): void => {
			if (!reply.writableFinished) controller.abort();
		};
		reply.once("close", disconnect);
		try {
			const route = ROUTE.exec(request.url ?? "");
			const acting = route?.[3] === "/act";
			if (!route || (acting && !this.#options.act)) {
				replyJson(reply, 404, { error: "member_route_unavailable" });
				return;
			}
			if (request.method !== (acting ? "POST" : "GET")) {
				replyJson(reply, 405, { error: "method_not_allowed" });
				return;
			}
			const bearer = BEARER.exec(request.headers.authorization ?? "");
			if (!bearer) {
				replyJson(reply, 401, { error: "member_sign_in_required" });
				return;
			}
			if (acting && this.#options.act) {
				const action = await readAction(request, controller.signal);
				if (action === undefined) {
					replyJson(reply, 400, { error: "member_action_invalid" });
					return;
				}
				const done = await this.#options.act(
					{ companyId: route[1] as string, machineId: route[2] as string, token: bearer[1] as string, action },
					controller.signal,
				);
				controller.signal.throwIfAborted();
				replyJson(reply, 200, { schema: "qorpera.member-machine-act/v1", exitCode: done.exitCode });
				return;
			}
			const asked = request.headers["if-none-match"];
			const etag = typeof asked === "string" ? (IF_NONE_MATCH.exec(asked)?.[1] ?? null) : null;
			const screen = await this.#options.look(
				{
					companyId: route[1] as string,
					machineId: route[2] as string,
					token: bearer[1] as string,
					confirmed: route[3] !== undefined,
					etag,
				},
				controller.signal,
			);
			controller.signal.throwIfAborted();
			const headers = {
				etag: `"${screen.etag}"`,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			};
			if (screen.png === null) {
				// The member has this picture: its etag alone.
				reply.writeHead(304, headers);
				reply.end();
				return;
			}
			reply.writeHead(200, { ...headers, "content-type": "image/png", "content-length": screen.png.length });
			reply.end(screen.png);
		} catch (error) {
			if (reply.headersSent || reply.destroyed) {
				reply.destroy();
				return;
			}
			if (error instanceof CloudMemberMachineScreenRefusal || error instanceof CloudMemberMachineActRefusal)
				replyJson(reply, 409, { code: error.code });
			else if (error instanceof CloudMemberMachineScreenSignIn)
				replyJson(reply, 401, { error: "member_sign_in_required" });
			else if (error instanceof CloudMemberMachineScreenForbidden)
				replyJson(reply, 403, { error: "machine_screen_unavailable" });
			else {
				// A fixed code only: an error's message never carries the member's token here, but it is not logged either.
				this.#options.failed?.(
					error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : "UNCLASSIFIED",
				);
				replyJson(reply, 503, { error: "machine_screen_unavailable" });
			}
		} finally {
			clearTimeout(timeout);
			reply.off("close", disconnect);
			this.#controllers.delete(controller);
		}
	}
}
