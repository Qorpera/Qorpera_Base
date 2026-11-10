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
	| "SCREEN_HELD";
const REFUSALS: ReadonlySet<string> = new Set<MachineScreenRefusal>([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"SCREEN_TOO_SOON",
	"DESKTOP_NOT_RUNNING",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"SCREEN_HIDDEN",
	"SCREEN_HELD",
]);

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
	};
}
