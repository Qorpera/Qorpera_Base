import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UUID_PATTERN } from "@qorpera/contracts";
import {
	type CloudMemberMachineAct,
	CloudMemberMachineActRefusal,
	type CloudMemberMachinePointerMove,
	CloudMemberMachinePointerRefusal,
	type CloudMemberMachineScreen,
	CloudMemberMachineScreenRefusal,
	type CloudMemberMachineStart,
	CloudMemberMachineStartRefusal,
	isCloudMemberMachinePointerPosition,
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
// (application/json, at most 1 KiB; any other key is a bad request, 400). The answer is 200 {"schema":
// "qorpera.member-machine-start/v1", "outcome": "started" | "running"} or why the desktop does not run (409 with a fixed
// code). With {"open": "<path>"} instead (20260930758000) it also opens that path of the company folder (relative to its
// root, as the web names it; at most 500 bytes, the folder's own rule decided by SQL) on the desktop once it runs:
// "opened", or why not (409: not in the company folder for this member, someone else types privately, no company folder
// on that computer, or the computer could not open it). The path is passed on and never logged or answered.
// A member who may act moves the desktop's pointer with their own (20260930744000):
//   POST /v1/member-machine-screens/<companyId>/<machineId>/pointer
// (application/json, at most 256 bytes). `{"begin": {"generation": g}}` (shared, at the lease generation the window
// knows) or `{"begin": {"epoch": e, "seat": s}}` (the member's own private hold) asks SQL for a pointer pass as the
// member: 200 {"schema": "qorpera.member-machine-pointer/v1", "pass", "milliseconds"} (what is left of it), or why not
// (409). `{"pass": p, "x": n, "y": n}` moves the pointer on that pass, in the screen's own pixels: 200 {"schema",
// "moved": true | false} (false: dropped, the desktop busy with an action or moves too fast; never queued), or why not
// (409; POINTER_PASS_ENDED: begin another). Nothing typed is ever in it, and no move is logged, stored or answered
// with more than that. `{"stream": {"pass": p, "hold": {"generation": g} | {"epoch": e, "seat": s}}}` (20260930745000)
// buys a ticket for the desktop's live picture on that pass, for the Origin the request came with (the member bridge
// passes the browser's on; none, or one that is not https, is a bad request): 200 {"schema", "ticket", "seconds"}
// (single use, opened at the executor's live-picture listener, cloud-member-machine-stream-http.ts), or why not (409).

/** A company's and a machine's ids, lower-case as the database writes them, and `/watching`, `/act` or `/start`. */
const UUID = UUID_PATTERN.source.slice(1, -1);
const ROUTE = new RegExp(`^/v1/member-machine-screens/(${UUID})/(${UUID})(/watching|/act|/start|/pointer)?$`);
/** A pointer pass's begin, a move, or a live picture's ticket: a few numbers and an id. */
const POINTER_BODY_BYTES = 256;
/** A browser's Origin a live picture's ticket is bound to: an https origin (http only on the loopback, for tests). */
const STREAM_ORIGIN = /^(https:\/\/[a-z0-9.-]{1,200}(:[0-9]{1,5})?|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?)$/;
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
/** A pointer pass's begin or one move (20260930744000), as the listener read it from the member's request. */
export type CloudMemberMachinePointerRequest = {
	readonly companyId: string;
	readonly machineId: string;
	/** The member's bearer token, passed on to the database (a begin) or compared with the pass's (a move), nowhere else. */
	readonly token: string;
} & (
	| { readonly begin: { readonly generation: number } | { readonly epoch: number; readonly seat: number } }
	| { readonly pass: string; readonly x: number; readonly y: number }
	| {
			/** A ticket for the desktop's live picture on that pass, under that hold (20260930745000), for the browser
			 * whose Origin asked (the member bridge checked it and passed it on). */
			readonly stream: {
				readonly pass: string;
				readonly hold: { readonly generation: number } | { readonly epoch: number; readonly seat: number };
			};
			readonly origin: string;
	  }
);
/** A pointer pass (its id and what is left of it), a move's end, or a live picture's ticket (single use, for its
 * seconds). */
export type CloudMemberMachinePointerAnswer =
	| { readonly pass: string; readonly milliseconds: number }
	| CloudMemberMachinePointerMove
	| { readonly ticket: string; readonly seconds: number };
/** One start of the desktop, as the listener read it from the member's request. */
export interface CloudMemberMachineStartRequest {
	readonly companyId: string;
	readonly machineId: string;
	/** The member's bearer token, passed on to the database and nowhere else. */
	readonly token: string;
	/** What to open once the desktop runs (20260930758000): a path of the company folder, relative to its root. */
	readonly open?: string;
}
/** The plain part of the company folder's path rule, as the listener checks a start's `open` before anything is asked
 * (SQL decides the whole rule): 1 to 500 bytes, no empty piece, `.` or `..`, so no leading or trailing `/`, no control
 * character, lone surrogate or backslash. */
export function cloudMemberMachineOpenPathValid(path: unknown): path is string {
	if (typeof path !== "string") return false;
	const bytes = Buffer.byteLength(path, "utf8");
	return (
		bytes >= 1 &&
		bytes <= 500 &&
		!/[\p{Cc}\p{Cs}\\]/u.test(path) &&
		path.split("/").every((piece) => piece !== "" && piece !== "." && piece !== "..")
	);
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
	/** A member's pointer pass or move (20260930744000); without it the route is 404. */
	pointer?(request: CloudMemberMachinePointerRequest, signal: AbortSignal): Promise<CloudMemberMachinePointerAnswer>;
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

/** A pointer pass's begin, `{"begin": {"generation": g}}` or `{"begin": {"epoch": e, "seat": s}}`, or a move, `{"pass":
 * p, "x": n, "y": n}`: a JSON body of at most POINTER_BODY_BYTES, the numbers safe whole numbers (a position within the
 * largest screen) and the pass an id; anything else is undefined, a bad request. */
async function readPointer(
	request: IncomingMessage,
	signal: AbortSignal,
): Promise<
	| { begin: { generation: number } | { epoch: number; seat: number } }
	| { pass: string; x: number; y: number }
	| { stream: { pass: string; hold: { generation: number } | { epoch: number; seat: number } } }
	| undefined
> {
	if (request.headers["content-type"] !== "application/json") return undefined;
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		signal.throwIfAborted();
		bytes += (chunk as Buffer).length;
		if (bytes > POINTER_BODY_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	try {
		const body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
		const whole = (value: unknown): value is number =>
			typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		const keys = Object.keys(body).sort().join();
		if (keys === "pass,x,y") {
			const { pass, x, y } = body as { pass: unknown; x: unknown; y: unknown };
			if (typeof pass !== "string" || !UUID_PATTERN.test(pass) || !isCloudMemberMachinePointerPosition(x, y))
				return undefined;
			return { pass: pass.toLowerCase(), x: x as number, y: y as number };
		}
		const holdOf = (hold: unknown) => {
			if (!hold || typeof hold !== "object" || Array.isArray(hold)) return undefined;
			const form = Object.keys(hold).sort().join();
			const { generation, epoch, seat } = hold as { generation?: unknown; epoch?: unknown; seat?: unknown };
			if (form === "generation" && whole(generation)) return { generation };
			if (form === "epoch,seat" && whole(epoch) && whole(seat)) return { epoch, seat };
			return undefined;
		};
		if (keys === "stream") {
			// A live picture's ticket (20260930745000): `{"stream": {"pass": p, "hold": {...}}}`.
			const stream = (body as { stream: unknown }).stream;
			if (!stream || typeof stream !== "object" || Array.isArray(stream)) return undefined;
			if (Object.keys(stream).sort().join() !== "hold,pass") return undefined;
			const { pass, hold } = stream as { pass: unknown; hold: unknown };
			const held = holdOf(hold);
			if (typeof pass !== "string" || !UUID_PATTERN.test(pass) || !held) return undefined;
			return { stream: { pass: pass.toLowerCase(), hold: held } };
		}
		if (keys !== "begin") return undefined;
		const begin = holdOf((body as { begin: unknown }).begin);
		return begin ? { begin } : undefined;
	} catch {
		return undefined;
	}
}

/** The member's start: a JSON body of at most START_BODY_BYTES that is exactly `{}`, or `{"open": path}` with a path the
 * plain rule takes (20260930758000): `{}` for the one, the path for the other, null for anything else (never guessed: a
 * bad request). */
async function readStart(request: IncomingMessage, signal: AbortSignal): Promise<{ open?: string } | null> {
	if (request.headers["content-type"] !== "application/json") return null;
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		signal.throwIfAborted();
		bytes += (chunk as Buffer).length;
		if (bytes > START_BODY_BYTES) return null;
		chunks.push(chunk as Buffer);
	}
	try {
		const body = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		const keys = Object.keys(body);
		if (keys.length === 0) return {};
		const open = (body as { open?: unknown }).open;
		return keys.length === 1 && keys[0] === "open" && cloudMemberMachineOpenPathValid(open) ? { open } : null;
	} catch {
		return null;
	}
}

function replyJson(
	reply: ServerResponse,
	status: number,
	value: Record<string, string | number | boolean | null>,
): void {
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
			(options.pointer !== undefined && typeof options.pointer !== "function") ||
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
		let quiet = false;
		try {
			const route = ROUTE.exec(request.url ?? "");
			const acting = route?.[3] === "/act";
			const starting = route?.[3] === "/start";
			const pointing = route?.[3] === "/pointer";
			if (
				!route ||
				(acting && !this.#options.act) ||
				(starting && !this.#options.start) ||
				(pointing && !this.#options.pointer)
			) {
				replyJson(reply, 404, { error: "member_route_unavailable" });
				return;
			}
			if (request.method !== (acting || starting || pointing ? "POST" : "GET")) {
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
			if (pointing && this.#options.pointer) {
				// Moves are many and alike: none is logged, a failure of one neither (the window keeps moving or falls back).
				quiet = true;
				const asked = await readPointer(request, controller.signal);
				// A live picture's ticket is for the browser that asked: its Origin, as the member bridge passed it on.
				const origin = request.headers.origin;
				if (
					asked === undefined ||
					("stream" in asked && (typeof origin !== "string" || !STREAM_ORIGIN.test(origin)))
				) {
					replyJson(reply, 400, { error: "member_pointer_invalid" });
					return;
				}
				const base = { companyId: route[1] as string, machineId: route[2] as string, token: bearer[1] as string };
				const done = await this.#options.pointer(
					"stream" in asked ? { ...base, stream: asked.stream, origin: origin as string } : { ...base, ...asked },
					controller.signal,
				);
				controller.signal.throwIfAborted();
				replyJson(
					reply,
					200,
					"ticket" in done
						? { schema: "qorpera.member-machine-pointer/v1", ticket: done.ticket, seconds: done.seconds }
						: "pass" in done
							? { schema: "qorpera.member-machine-pointer/v1", pass: done.pass, milliseconds: done.milliseconds }
							: { schema: "qorpera.member-machine-pointer/v1", moved: done.moved },
				);
				return;
			}
			if (starting && this.#options.start) {
				const asked = await readStart(request, controller.signal);
				if (!asked) {
					replyJson(reply, 400, { error: "member_start_invalid" });
					return;
				}
				const done = await this.#options.start(
					{
						companyId: route[1] as string,
						machineId: route[2] as string,
						token: bearer[1] as string,
						...(asked.open === undefined ? {} : { open: asked.open }),
					},
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
				error instanceof CloudMemberMachineStartRefusal ||
				error instanceof CloudMemberMachinePointerRefusal
			) {
				// A desktop that did not start is the member's answer and a failure of the machine's: logged by its code.
				if (
					error instanceof CloudMemberMachineStartRefusal &&
					(error.code === "DESKTOP_DID_NOT_START" ||
						error.code === "DESKTOP_DID_NOT_OPEN" ||
						error.code === "DESKTOP_OPEN_NO_FOLDER")
				)
					this.#options.failed?.(error.code);
				replyJson(reply, 409, { code: error.code });
			} else if (error instanceof CloudMemberMachineScreenSignIn)
				replyJson(reply, 401, { error: "member_sign_in_required" });
			else if (error instanceof CloudMemberMachineScreenForbidden)
				replyJson(reply, 403, { error: "machine_screen_unavailable" });
			else {
				// A fixed code only: an error's message never carries the member's token here, but it is not logged either.
				if (!quiet)
					this.#options.failed?.(
						error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
							? error.message
							: "UNCLASSIFIED",
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
