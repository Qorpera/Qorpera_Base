import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
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
 * another action runs on the desktop (an agent's that began before the take-over), or the image's helper refused it. */
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
	| "SCREEN_REQUEST_INVALID";
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
]);
export type MachineActAnswer =
	| { readonly kind: "done"; readonly exitCode: number | null }
	| { readonly kind: "refused"; readonly code: MachineActRefusal };

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
	/** One action on a desktop the member holds (20260930713000). What they typed goes in the body, to the machine alone. */
	act(machineId: string, action: MachineDesktopAction, signal: AbortSignal): Promise<MachineActAnswer>;
}

/** The executor answers within 30 s; this covers the bridge on the way there and back. */
const TIMEOUT_MS = 35_000;
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
}): WebMachineScreens {
	return {
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
		act: (machineId, action, signal) => {
			if (!UUID_PATTERN.test(options.companyId) || !UUID_PATTERN.test(machineId))
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
						body: JSON.stringify({ action }),
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
	};
}
