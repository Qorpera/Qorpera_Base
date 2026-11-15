import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type MachineStreamEnd, type MachineStreamMessage, openMachineStream } from "./machine-stream.ts";
import { UUID_PATTERN } from "./parse.ts";

/** Why a look at an agent's desktop has no picture (migration 20260930712000; the executor's 409 codes): the machine is
 * not running, its disk had a company folder view and the member does not read the folder's root, a look came too soon
 * after the last, the screen is off, the machine restarted, its image cannot take pictures yet, the screen may show a
 * file the member may not read (`SCREEN_HIDDEN`), or the company folder has not released it yet (`SCREEN_HELD`). */
export type MachineScreenRefusal =
	| "MACHINE_NOT_RUNNING"
	| "MACHINE_NEEDS_COMPANY_VIEW"
	| "SCREEN_TOO_SOON"
	| "DESKTOP_NOT_RUNNING"
	| "MACHINE_BOOT_CHANGED"
	| "MACHINE_IMAGE_WITHOUT_SCREEN"
	| "SCREEN_HIDDEN"
	| "SCREEN_HELD"
	// Another member holds the desktop (20260930713000): its screen is theirs alone until they hand it back.
	| "DESKTOP_MEMBER_IN_CONTROL";
const REFUSALS: ReadonlySet<string> = new Set<MachineScreenRefusal>([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"SCREEN_TOO_SOON",
	"DESKTOP_NOT_RUNNING",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"SCREEN_HIDDEN",
	"SCREEN_HELD",
	"DESKTOP_MEMBER_IN_CONTROL",
]);
/** One action of a member who holds the desktop (20260930713000), in the screen's own pixels; never `open`. */
export type MachineDesktopAction =
	| { readonly type: "click"; readonly x: number; readonly y: number; readonly button?: "left" | "middle" | "right" }
	| { readonly type: "double"; readonly x: number; readonly y: number }
	| { readonly type: "drag"; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
	| { readonly type: "type"; readonly text: string }
	| { readonly type: "key"; readonly keys: readonly string[] }
	| {
			readonly type: "scroll";
			readonly direction: "up" | "down";
			readonly steps: number;
			readonly x: number;
			readonly y: number;
	  };
/** Why an action did not run (the executor's 409 codes): as a look's, the member's hold ended (handed back or run out),
 * another action runs on the desktop (an agent's, or another member's), or the image's helper refused it; for a shared
 * action (20260930734000), someone holds the desktop privately (DESKTOP_MEMBER_IN_CONTROL), the member's actions came
 * too fast, or someone held it privately since the input was made (DESKTOP_HELD_SINCE, 20260930738000). */
export type MachineActRefusal =
	| "MACHINE_NOT_RUNNING"
	| "MACHINE_NEEDS_COMPANY_VIEW"
	| "DESKTOP_MEMBER_IN_CONTROL"
	| "DESKTOP_CONTROL_ENDED"
	| "DESKTOP_BUSY"
	| "DESKTOP_NOT_RUNNING"
	| "MACHINE_BOOT_CHANGED"
	| "MACHINE_IMAGE_WITHOUT_SCREEN"
	| "SCREEN_ACTION_TAKEN"
	| "DESKTOP_MACHINE_TOO_SMALL"
	| "DESKTOP_DID_NOT_START"
	| "SCREEN_REQUEST_INVALID"
	| "DESKTOP_ACTIONS_TOO_FAST"
	| "DESKTOP_HELD_SINCE";
const ACT_REFUSALS: ReadonlySet<string> = new Set<MachineActRefusal>([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_CONTROL_ENDED",
	"DESKTOP_BUSY",
	"DESKTOP_NOT_RUNNING",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"SCREEN_ACTION_TAKEN",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_DID_NOT_START",
	"SCREEN_REQUEST_INVALID",
	"DESKTOP_ACTIONS_TOO_FAST",
	"DESKTOP_HELD_SINCE",
]);
export type MachineActAnswer =
	| { readonly kind: "done"; readonly exitCode: number | null }
	| { readonly kind: "refused"; readonly code: MachineActRefusal };

/** Why a start of the desktop did not end with it running (20260930714000, the executor's 409 codes): the machine is not
 * running, its disk may show what the member may not see, it is too small, a start of it began a moment ago, it
 * restarted, its image has no desktop, or the desktop did not start. */
export type MachineStartRefusal =
	| "MACHINE_NOT_RUNNING"
	| "MACHINE_NEEDS_COMPANY_VIEW"
	| "DESKTOP_MACHINE_TOO_SMALL"
	| "DESKTOP_START_TOO_SOON"
	| "MACHINE_BOOT_CHANGED"
	| "MACHINE_IMAGE_WITHOUT_SCREEN"
	| "DESKTOP_DID_NOT_START"
	// A start that opens something (20260930758000): no path of the company folder; not in it for this member, or not on
	// that computer (told alike); someone else types privately; a computer without the company folder; an open that failed.
	| "DESKTOP_OPEN_PATH_INVALID"
	| "DESKTOP_OPEN_NOT_FOUND"
	| "DESKTOP_MEMBER_IN_CONTROL"
	| "DESKTOP_OPEN_NO_FOLDER"
	| "DESKTOP_DID_NOT_OPEN"
	| "DESKTOP_BUSY";
const START_REFUSALS: ReadonlySet<string> = new Set<MachineStartRefusal>([
	"DESKTOP_OPEN_PATH_INVALID",
	"DESKTOP_OPEN_NOT_FOUND",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_OPEN_NO_FOLDER",
	"DESKTOP_DID_NOT_OPEN",
	"DESKTOP_BUSY",
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_START_TOO_SOON",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"DESKTOP_DID_NOT_START",
]);
/** Every refusal the start route answers, as the window acts on each (its tests go through them all). */
export const MACHINE_START_REFUSALS: ReadonlySet<string> = START_REFUSALS;
/** The desktop runs (started now, or running already; with something to open, it runs and that is open), or why not. */
export type MachineStartAnswer =
	| { readonly kind: "started" | "running" | "opened" }
	| { readonly kind: "refused"; readonly code: MachineStartRefusal };

/** Why a member's pointer does not move (20260930744000, the executor's 409 codes): as an action's (the machine not
 * running, a disk the member may not see, too small, someone typing privately, someone who did since the window knew,
 * the member's own private hold ended, the screen off, a restart, an image that cannot), and a pass that ran out or is
 * not held (POINTER_PASS_ENDED: begin another). */
export type MachinePointerRefusal =
	| "MACHINE_NOT_RUNNING"
	| "MACHINE_NEEDS_COMPANY_VIEW"
	| "DESKTOP_MACHINE_TOO_SMALL"
	| "DESKTOP_MEMBER_IN_CONTROL"
	| "DESKTOP_HELD_SINCE"
	| "DESKTOP_CONTROL_ENDED"
	| "DESKTOP_NOT_RUNNING"
	| "MACHINE_BOOT_CHANGED"
	| "MACHINE_IMAGE_WITHOUT_SCREEN"
	| "POINTER_PASS_ENDED";
const POINTER_REFUSALS: ReadonlySet<string> = new Set<MachinePointerRefusal>([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_HELD_SINCE",
	"DESKTOP_CONTROL_ENDED",
	"DESKTOP_NOT_RUNNING",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"POINTER_PASS_ENDED",
]);
/** A pointer pass's begin (shared at the lease generation the window knows, or on the member's own private hold), or one
 * move on a pass, in the screen's own pixels. */
export type MachinePointerRequest =
	| { readonly begin: { readonly generation: number } | { readonly epoch: number; readonly seat: number } }
	| { readonly pass: string; readonly x: number; readonly y: number }
	/** A live picture's ticket on that pass, for its hold (20260930745000): bought for this page's Origin. */
	| {
			readonly stream: {
				readonly pass: string;
				readonly hold: { readonly generation: number } | { readonly epoch: number; readonly seat: number };
			};
	  };
/** A pass (its id and what is left of it), a move's end (`moved` false: dropped, never queued), why not, or no pointer
 * route at all (`unavailable`: a bridge or an executor from before 20260930744000; the window then keeps today's way). */
export type MachinePointerAnswer =
	| { readonly kind: "pass"; readonly pass: string; readonly milliseconds: number }
	| { readonly kind: "moved"; readonly moved: boolean }
	| { readonly kind: "ticket"; readonly ticket: string; readonly seconds: number }
	| { readonly kind: "refused"; readonly code: MachinePointerRefusal }
	| { readonly kind: "unavailable" };

/** One look: a new picture and its etag, the picture the member already has, or why there is none. */
export type MachineScreenLook =
	| { readonly kind: "picture"; readonly png: Blob; readonly etag: string }
	| { readonly kind: "unchanged" }
	| { readonly kind: "refused"; readonly code: MachineScreenRefusal };

/** The look route gave no usable answer. `status` is its HTTP status, or null without one: 401 when the member's sign-in
 * was not taken, 403 when the machine is not there for them. */
export class MachineScreenError extends Error {
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = "MachineScreenError";
		this.status = status;
	}
}

export interface WebMachineScreens {
	/** One look at a machine's screen. `etag` is the picture the member has; `watching` says they still watch, which
	 * keeps the desktop on for 30 minutes. */
	look(
		machineId: string,
		options: { etag: string | null; watching: boolean },
		signal: AbortSignal,
	): Promise<MachineScreenLook>;
	/** One action on a desktop the member holds (20260930713000), with the hand-back epoch and the seat of the hold the
	 * input was captured under (F24 and F26 of #1661: SQL runs it only under that hold), or, with no hold, on the desktop
	 * the member shares with the agent (20260930734000: SQL runs it only while no one holds it privately): with the lease
	 * generation the input was made under (`{generation}`, 20260930738000: refused once someone held it privately since),
	 * or none (null, a database before it). What they typed goes in the body, to the machine alone. */
	act(
		machineId: string,
		action: MachineDesktopAction,
		hold: { epoch: number; seat: number } | { generation: number } | null,
		signal: AbortSignal,
	): Promise<MachineActAnswer>;
	/** The member's pointer (20260930744000): a pass's begin, or one move on it. Nothing typed is ever in it. */
	pointer(machineId: string, request: MachinePointerRequest, signal: AbortSignal): Promise<MachinePointerAnswer>;
	/** Turns the machine's desktop on (20260930714000): owners, admins and contributors, whatever its agent does. The body
	 * is `{}`; with `open`, a path of the company folder (20260930758000), `{"open": path}`: the desktop is turned on and
	 * that path opened on it. */
	start(machineId: string, signal: AbortSignal, open?: string): Promise<MachineStartAnswer>;
	/** The desktop's live picture (20260930745000), on the member's pointer pass of a hold or a sharing: a ticket bought on
	 * the pointer route, then one stream on it, every message to `onMessage`, until it ends (why) or `signal` aborts.
	 * Absent when the build names no stream address: the window keeps its looks. */
	stream?(
		machineId: string,
		on: {
			readonly pass: string;
			readonly hold: { readonly generation: number } | { readonly epoch: number; readonly seat: number };
		},
		onMessage: (message: MachineStreamMessage) => void,
		signal: AbortSignal,
	): Promise<MachineStreamEnd>;
}

/** The executor answers within 30 s; this covers the bridge on the way there and back. */
const TIMEOUT_MS = 35_000;
/** A pointer move is worth little once a newer one exists: the window gives up on one after this (a pass's begin too). */
const POINTER_TIMEOUT_MS = 5_000;
/** A pointer position within the largest screen (3840 x 2160). */
const POINTER_MAX_X = 3839;
const POINTER_MAX_Y = 2159;
/** A picture of a screen is at most 8 MiB, as the machine's node checks it. */
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const ETAG = /^"([0-9a-f]{64})"$/;

/** A member's looks at an agent's desktop (`/v1/member-machine-screens/`, the coding executor behind the member
 * bridge), under the member's own token. `route` maps the gateway's URL to the bridge the build names
 * (memberRouteTarget); the answer is checked here, never trusted for more than a picture. */
export function createWebMachineScreens(options: {
	readonly companyId: string;
	readonly objectGatewayUrl: string;
	readonly route: (url: string) => string;
	readonly accessToken: (signal: AbortSignal) => Promise<string>;
	readonly fetch: typeof fetch;
	/** The machine-stream address the build names (`wss://…`, 20260930745000); without it, no live picture. */
	readonly streamUrl?: string;
	readonly WebSocket?: typeof WebSocket;
}): WebMachineScreens {
	const screens: WebMachineScreens = {
		look: (machineId, { etag, watching }, signal) => {
			if (!UUID_PATTERN.test(options.companyId) || !UUID_PATTERN.test(machineId))
				return Promise.reject(new MachineScreenError("Invalid machine screen"));
			return withCloudDeadline(
				async (requestSignal) => {
					const origin = new URL(options.objectGatewayUrl).origin;
					const token = await options.accessToken(requestSignal);
					const url = options.route(
						`${origin}/v1/member-machine-screens/${options.companyId.toLowerCase()}/${machineId.toLowerCase()}${watching ? "/watching" : ""}`,
					);
					// The member's own If-None-Match: the browser hands the 304 back as it is.
					const response = await options.fetch(url, {
						method: "GET",
						headers: { authorization: `Bearer ${token}`, ...(etag ? { "if-none-match": `"${etag}"` } : {}) },
						signal: requestSignal,
						redirect: "error",
						cache: "no-store",
						credentials: "omit",
					});
					if (response.status === 304) {
						void response.body?.cancel().catch(() => undefined);
						if (!etag || response.headers.get("etag") !== `"${etag}"`)
							throw new MachineScreenError("Invalid machine screen answer");
						return { kind: "unchanged" };
					}
					if (response.status === 409) {
						let code: unknown;
						try {
							code = (
								JSON.parse(
									new TextDecoder("utf-8", { fatal: true }).decode(
										await readBoundedCloudResponse(response, 4096, requestSignal),
									),
								) as { code?: unknown } | null
							)?.code;
						} catch {
							code = undefined;
						}
						if (typeof code !== "string" || !REFUSALS.has(code))
							throw new MachineScreenError("Invalid machine screen answer", 409);
						return { kind: "refused", code: code as MachineScreenRefusal };
					}
					if (response.status !== 200) {
						void response.body?.cancel().catch(() => undefined);
						throw new MachineScreenError(`Machine screen is unavailable (${response.status})`, response.status);
					}
					const tag = ETAG.exec(response.headers.get("etag") ?? "")?.[1];
					if (!tag || response.headers.get("content-type") !== "image/png") {
						void response.body?.cancel().catch(() => undefined);
						throw new MachineScreenError("Invalid machine screen answer");
					}
					// The reader joins the bytes into one new ArrayBuffer.
					const bytes = (await readBoundedCloudResponse(
						response,
						MAX_PICTURE_BYTES,
						requestSignal,
					)) as Uint8Array<ArrayBuffer>;
					return { kind: "picture", png: new Blob([bytes], { type: "image/png" }), etag: tag };
				},
				TIMEOUT_MS,
				signal,
			);
		},
		act: (machineId, action, hold, signal) => {
			if (
				!UUID_PATTERN.test(options.companyId) ||
				!UUID_PATTERN.test(machineId) ||
				(hold !== null &&
					("generation" in hold
						? !Number.isSafeInteger(hold.generation) || hold.generation < 0
						: !Number.isSafeInteger(hold.epoch) ||
							hold.epoch < 0 ||
							!Number.isSafeInteger(hold.seat) ||
							hold.seat < 0))
			)
				return Promise.reject(new MachineScreenError("Invalid machine action"));
			return withCloudDeadline(
				async (requestSignal) => {
					const origin = new URL(options.objectGatewayUrl).origin;
					const token = await options.accessToken(requestSignal);
					const url = options.route(
						`${origin}/v1/member-machine-screens/${options.companyId.toLowerCase()}/${machineId.toLowerCase()}/act`,
					);
					const response = await options.fetch(url, {
						method: "POST",
						headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
						// Shared (no hold): the action, with the lease generation it was made under when the list named one.
						body: JSON.stringify(
							hold === null
								? { action }
								: "generation" in hold
									? { action, generation: hold.generation }
									: { action, epoch: hold.epoch, seat: hold.seat },
						),
						signal: requestSignal,
						redirect: "error",
						cache: "no-store",
						credentials: "omit",
					});
					if (response.status !== 200 && response.status !== 409) {
						void response.body?.cancel().catch(() => undefined);
						throw new MachineScreenError(`Machine action is unavailable (${response.status})`, response.status);
					}
					let answer: { code?: unknown; schema?: unknown; exitCode?: unknown } | null;
					try {
						answer = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 4096, requestSignal),
							),
						) as typeof answer;
					} catch {
						answer = null;
					}
					if (response.status === 409) {
						if (typeof answer?.code !== "string" || !ACT_REFUSALS.has(answer.code))
							throw new MachineScreenError("Invalid machine action answer", 409);
						return { kind: "refused", code: answer.code as MachineActRefusal };
					}
					const exit = answer?.exitCode;
					if (
						answer?.schema !== "qorpera.member-machine-act/v1" ||
						(exit !== null && (typeof exit !== "number" || !Number.isInteger(exit) || exit < 0 || exit > 255))
					)
						throw new MachineScreenError("Invalid machine action answer");
					return { kind: "done", exitCode: exit as number | null };
				},
				TIMEOUT_MS,
				signal,
			);
		},
		pointer: (machineId, request, signal) => {
			const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
			const holdValid = (hold: { generation: number } | { epoch: number; seat: number }) =>
				"generation" in hold ? whole(hold.generation) : whole(hold.epoch) && whole(hold.seat);
			const valid =
				"begin" in request
					? holdValid(request.begin)
					: "stream" in request
						? UUID_PATTERN.test(request.stream.pass) && holdValid(request.stream.hold)
						: UUID_PATTERN.test(request.pass) &&
							whole(request.x) &&
							whole(request.y) &&
							request.x <= POINTER_MAX_X &&
							request.y <= POINTER_MAX_Y;
			if (!UUID_PATTERN.test(options.companyId) || !UUID_PATTERN.test(machineId) || !valid)
				return Promise.reject(new MachineScreenError("Invalid machine pointer"));
			return withCloudDeadline(
				async (requestSignal) => {
					const origin = new URL(options.objectGatewayUrl).origin;
					const token = await options.accessToken(requestSignal);
					const url = options.route(
						`${origin}/v1/member-machine-screens/${options.companyId.toLowerCase()}/${machineId.toLowerCase()}/pointer`,
					);
					const response = await options.fetch(url, {
						method: "POST",
						headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
						body: JSON.stringify(
							"begin" in request
								? { begin: request.begin }
								: "stream" in request
									? { stream: { pass: request.stream.pass, hold: request.stream.hold } }
									: { pass: request.pass, x: request.x, y: request.y },
						),
						signal: requestSignal,
						redirect: "error",
						cache: "no-store",
						credentials: "omit",
					});
					// A bridge or an executor before 20260930744000 has no such route (404), or not for this method (405), or
					// takes no such body (400): no pointer, quietly.
					if ([400, 404, 405].includes(response.status)) {
						void response.body?.cancel().catch(() => undefined);
						return { kind: "unavailable" };
					}
					if (response.status !== 200 && response.status !== 409) {
						void response.body?.cancel().catch(() => undefined);
						throw new MachineScreenError(`Machine pointer is unavailable (${response.status})`, response.status);
					}
					let answer: Record<string, unknown> | null;
					try {
						answer = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 4096, requestSignal),
							),
						) as Record<string, unknown>;
					} catch {
						answer = null;
					}
					if (response.status === 409) {
						if (typeof answer?.code !== "string" || !POINTER_REFUSALS.has(answer.code))
							throw new MachineScreenError("Invalid machine pointer answer", 409);
						return { kind: "refused", code: answer.code as MachinePointerRefusal };
					}
					if (answer?.schema !== "qorpera.member-machine-pointer/v1")
						throw new MachineScreenError("Invalid machine pointer answer");
					const keys = Object.keys(answer).sort().join();
					if (
						"begin" in request &&
						keys === "milliseconds,pass,schema" &&
						typeof answer.pass === "string" &&
						UUID_PATTERN.test(answer.pass) &&
						Number.isSafeInteger(answer.milliseconds) &&
						(answer.milliseconds as number) >= 0 &&
						(answer.milliseconds as number) <= 10_000
					)
						return { kind: "pass", pass: answer.pass, milliseconds: answer.milliseconds as number };
					if ("stream" in request) {
						if (
							keys === "schema,seconds,ticket" &&
							typeof answer.ticket === "string" &&
							/^[A-Za-z0-9_-]{43}$/.test(answer.ticket) &&
							Number.isSafeInteger(answer.seconds) &&
							(answer.seconds as number) >= 1 &&
							(answer.seconds as number) <= 30
						)
							return { kind: "ticket", ticket: answer.ticket, seconds: answer.seconds as number };
						throw new MachineScreenError("Invalid machine pointer answer");
					}
					if (!("begin" in request) && keys === "moved,schema" && typeof answer.moved === "boolean")
						return { kind: "moved", moved: answer.moved };
					throw new MachineScreenError("Invalid machine pointer answer");
				},
				POINTER_TIMEOUT_MS,
				signal,
			);
		},
		start: (machineId, signal, open) => {
			if (!UUID_PATTERN.test(options.companyId) || !UUID_PATTERN.test(machineId))
				return Promise.reject(new MachineScreenError("Invalid machine start"));
			return withCloudDeadline(
				async (requestSignal) => {
					const origin = new URL(options.objectGatewayUrl).origin;
					const token = await options.accessToken(requestSignal);
					const url = options.route(
						`${origin}/v1/member-machine-screens/${options.companyId.toLowerCase()}/${machineId.toLowerCase()}/start`,
					);
					const response = await options.fetch(url, {
						method: "POST",
						headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
						body: open === undefined ? "{}" : JSON.stringify({ open }),
						signal: requestSignal,
						redirect: "error",
						cache: "no-store",
						credentials: "omit",
					});
					if (response.status !== 200 && response.status !== 409) {
						void response.body?.cancel().catch(() => undefined);
						throw new MachineScreenError(`Machine start is unavailable (${response.status})`, response.status);
					}
					let answer: { code?: unknown; schema?: unknown; outcome?: unknown } | null;
					try {
						answer = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 4096, requestSignal),
							),
						) as typeof answer;
					} catch {
						answer = null;
					}
					if (response.status === 409) {
						if (typeof answer?.code !== "string" || !START_REFUSALS.has(answer.code))
							throw new MachineScreenError("Invalid machine start answer", 409);
						return { kind: "refused", code: answer.code as MachineStartRefusal };
					}
					if (
						answer?.schema !== "qorpera.member-machine-start/v1" ||
						(answer.outcome !== "started" && answer.outcome !== "running" && answer.outcome !== "opened") ||
						(answer.outcome === "opened") !== (open !== undefined)
					)
						throw new MachineScreenError("Invalid machine start answer");
					return { kind: answer.outcome };
				},
				TIMEOUT_MS,
				signal,
			);
		},
	};
	const streamUrl = options.streamUrl;
	if (streamUrl)
		screens.stream = async (machineId, on, onMessage, signal) => {
			// The ticket: on the member's pass, for this page's Origin (the bridge passes it on; the executor binds it).
			const bought = await screens.pointer(machineId, { stream: { pass: on.pass, hold: on.hold } }, signal);
			if (bought.kind === "unavailable") return { kind: "unavailable", delivered: false };
			if (bought.kind === "refused") return { kind: "refused", code: bought.code, delivered: false };
			if (bought.kind !== "ticket") return { kind: "failed", delivered: false };
			return openMachineStream({
				url: streamUrl,
				ticket: bought.ticket,
				onMessage,
				signal,
				...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
			});
		};
	return screens;
}
