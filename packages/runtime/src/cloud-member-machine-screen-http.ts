import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudMemberMachineAct,
	CloudMemberMachineActRefusal,
	type CloudMemberMachineScreen,
	CloudMemberMachineScreenRefusal,
	type CloudMemberMachineStart,
	CloudMemberMachineStartRefusal,
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
//   POST /v1/member-machine-screens/<companyId>/<machineId>/act   {"action": {...}, "epoch": n, "seat": s}
// (application/json, at most 16 KiB): one of machine_screen's actions, never `open`, and the hand-back epoch and the
// seat of the hold the member's page captured it under (each a safe whole number, 0 or more; F24 and F26 of #1661: SQL
// runs it only under that hold). A member who shares the desktop with the agent (20260930734000) sends the action
// alone, `{"action": {...}}`: SQL runs it only while no one holds the desktop privately. From 20260930738000 their page
// also sends the desktop's lease generation the input was made under, `{"action": {...}, "generation": g}` (a safe
// whole number, 0 or more): SQL refuses it (DESKTOP_HELD_SINCE) once someone held the desktop privately since.
// The answer is the action's exit
// (200, {"schema": "qorpera.member-machine-act/v1", "exitCode"}) or why it did not run (409 with a fixed code); a body
// that is not one is 400. What the member typed is in that body: it is passed to the machine and nowhere else, never
// logged, stored, answered or put in an error.
// An owner, admin or contributor turns the desktop on (20260930714000) with
//   POST /v1/member-machine-screens/<companyId>/<machineId>/start   {}
// (application/json, at most 1 KiB; the body is an empty object now: a later stage may say what to open there, and any
// key today is a bad request, 400). The answer is 200 {"schema": "qorpera.member-machine-start/v1", "outcome":
// "started" | "running"} or why the desktop does not run (409 with a fixed code).

/** A company's and a machine's ids, lower-case as the database writes them, and `/watching`, `/act` or `/start`. */
const UUID = UUID_PATTERN.source.slice(1, -1);
const ROUTE = new RegExp(`^/v1/member-machine-screens/(${UUID})/(${UUID})(/watching|/act|/start)?$`);
/** A member's start: `{}` today. */
const START_BODY_BYTES = 1024;
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
/** One action, as the listener read it from the member's request: under the member's private hold (its epoch and seat),
 * or shared (20260930734000: no hold; SQL refuses it while anyone holds the desktop privately). */
export type CloudMemberMachineActRequest = {
	readonly companyId: string;
	readonly machineId: string;
	/** The member's bearer token, passed on to the database and nowhere else. */
	readonly token: string;
	readonly action: MachineScreenAction;
} & (
	| {
			/** The hand-back epoch of the hold the member's page captured the action under (F24). */
			readonly epoch: number;
			/** The seat of that hold (F26): which seating of the member under that epoch. */
			readonly seat: number;
			readonly shared?: undefined;
	  }
	| {
			readonly shared: true;
			readonly epoch?: undefined;
			readonly seat?: undefined;
			/** The lease generation the member's input was made under (20260930738000); absent from a page before it. */
			readonly generation?: number;
	  }
);
/** One start of the desktop, as the listener read it from the member's request. */
export interface CloudMemberMachineStartRequest {
	readonly companyId: string;
	readonly machineId: string;
	/** The member's bearer token, passed on to the database and nowhere else. */
	readonly token: string;
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
	/** A member's start of the desktop (20260930714000); without it the route is 404. */
	start?(request: CloudMemberMachineStartRequest, signal: AbortSignal): Promise<CloudMemberMachineStart>;
	host?: "127.0.0.1" | "::1";
	port?: number;
	/** A look that failed for another reason than the member's, by its fixed code: for the executor's log. */
	failed?(code: string): void;
}

/** The member's action: a JSON body of at most ACT_BODY_BYTES, `{"action": {...}, "epoch": n, "seat": s}` (under the
 * member's private hold), `{"action": {...}}` (shared, 20260930734000) or `{"action": {...}, "generation": g}` (shared,
 * made under that lease generation, 20260930738000) and nothing else, the action one of machine_screen's but `open`
 * and the epoch, the seat and the generation safe whole numbers, 0 or more (never guessed: an epoch without a seat, a
 * generation beside them, or anything else, is undefined, a bad request). Nothing of the body is kept or told. */
async function readAction(
	request: IncomingMessage,
	signal: AbortSignal,
): Promise<
	| { action: MachineScreenAction; epoch: number; seat: number }
	| { action: MachineScreenAction; shared: true; generation?: number }
	| undefined
> {
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
		if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
		const keys = Object.keys(body).sort().join();
		const whole = (value: unknown): value is number =>
			typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		// Shared (20260930734000): the action alone.
		if (keys === "action") {
			const parsed = parseCloudMemberMachineAction((body as { action: unknown }).action);
			return parsed === undefined ? undefined : { action: parsed, shared: true };
		}
		// Shared, with the lease generation the input was made under (20260930738000).
		if (keys === "action,generation") {
			const { action, generation } = body as { action: unknown; generation: unknown };
			if (!whole(generation)) return undefined;
			const parsed = parseCloudMemberMachineAction(action);
			return parsed === undefined ? undefined : { action: parsed, shared: true, generation };
		}
		if (keys !== "action,epoch,seat") return undefined;
		const { action, epoch, seat } = body as { action: unknown; epoch: unknown; seat: unknown };
		if (!whole(epoch) || !whole(seat)) return undefined;
		const parsed = parseCloudMemberMachineAction(action);
		return parsed === undefined ? undefined : { action: parsed, epoch, seat };
	} catch {
		return undefined;
	}
}

/** The member's start: a JSON body of at most START_BODY_BYTES that is exactly `{}` (never guessed: anything else is a bad
 * request). */
async function readStart(request: IncomingMessage, signal: AbortSignal): Promise<boolean> {
	if (request.headers["content-type"] !== "application/json") return false;
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		signal.throwIfAborted();
		bytes += (chunk as Buffer).length;
		if (bytes > START_BODY_BYTES) return false;
		chunks.push(chunk as Buffer);
	}
	try {
		const body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
		return !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;
	} catch {
		return false;
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
			(options.start !== undefined && typeof options.start !== "function") ||
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
			const starting = route?.[3] === "/start";
			if (!route || (acting && !this.#options.act) || (starting && !this.#options.start)) {
				replyJson(reply, 404, { error: "member_route_unavailable" });
				return;
			}
			if (request.method !== (acting || starting ? "POST" : "GET")) {
				replyJson(reply, 405, { error: "method_not_allowed" });
				return;
			}
			const bearer = BEARER.exec(request.headers.authorization ?? "");
			if (!bearer) {
				replyJson(reply, 401, { error: "member_sign_in_required" });
				return;
			}
			if (acting && this.#options.act) {
				const asked = await readAction(request, controller.signal);
				if (asked === undefined) {
					replyJson(reply, 400, { error: "member_action_invalid" });
					return;
				}
				const where = { companyId: route[1] as string, machineId: route[2] as string, token: bearer[1] as string };
				const done = await this.#options.act(
					"shared" in asked
						? {
								...where,
								action: asked.action,
								shared: true,
								...(asked.generation === undefined ? {} : { generation: asked.generation }),
							}
						: { ...where, action: asked.action, epoch: asked.epoch, seat: asked.seat },
					controller.signal,
				);
				controller.signal.throwIfAborted();
				replyJson(reply, 200, { schema: "qorpera.member-machine-act/v1", exitCode: done.exitCode });
				return;
			}
			if (starting && this.#options.start) {
				if (!(await readStart(request, controller.signal))) {
					replyJson(reply, 400, { error: "member_start_invalid" });
					return;
				}
				const done = await this.#options.start(
					{ companyId: route[1] as string, machineId: route[2] as string, token: bearer[1] as string },
					controller.signal,
				);
				controller.signal.throwIfAborted();
				replyJson(reply, 200, { schema: "qorpera.member-machine-start/v1", outcome: done.outcome });
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
			if (
				error instanceof CloudMemberMachineScreenRefusal ||
				error instanceof CloudMemberMachineActRefusal ||
				error instanceof CloudMemberMachineStartRefusal
			) {
				// A desktop that did not start is the member's answer and a failure of the machine's: logged by its code.
				if (error instanceof CloudMemberMachineStartRefusal && error.code === "DESKTOP_DID_NOT_START")
					this.#options.failed?.(error.code);
				replyJson(reply, 409, { code: error.code });
			} else if (error instanceof CloudMemberMachineScreenSignIn)
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
