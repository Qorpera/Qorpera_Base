import { createHash } from "node:crypto";
import {
	CloudRequestTimeoutError,
	readBoundedCloudResponse,
	withCloudDeadline,
} from "@qorpera/cloud-client/cloud-request";
import {
	type CloudCodingCommandRead,
	type CloudMachineCommandReceipt,
	isCloudMachineFolderLost,
	isRecord,
	parseCloudCodingCommandRead,
	parseCloudMachineCommandReceipt,
	UUID_PATTERN as UUID,
} from "@qorpera/contracts";
import { CloudCommandPages } from "./cloud-command-pages.ts";
import { isValidBase64UrlToken, parseTrustedOrigin } from "./cloud-http-server-kit.ts";
import { MACHINE_ACCOUNT_FILL_REFUSALS } from "./cloud-machine-account-fill.ts";
import { MACHINE_CODING_VALUE_REFUSALS } from "./cloud-machine-coding-value.ts";
import {
	MACHINE_SCREEN_MAX_PNG_BYTES,
	MACHINE_SCREEN_MAX_SETTLE_MS,
	MACHINE_SCREEN_REFUSALS,
	type MachineScreenAction,
	type MachineScreenHeader,
	parseMachineScreenAction,
	parseMachineScreenHeader,
} from "./cloud-machine-screen.ts";
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

// Machine commands travel the coding executor's command gateway (the same
// HTTPS ingress, peer routing and transport credential) on their own route,
// /v1/machine-commands/{start|read|cancel}. The scope names a company
// machine, never a node, host or address; SQL decides where it runs.
// /v1/machine-commands/wake asks the machines' executors for a pass now: it
// carries no authority (each step of that pass asks SQL) and gives nothing away
// but "look again".
// /v1/machine-commands/coding-value (save_coding_value, 20260930705000) runs
// the image's fixed clipboard helper on the machine for one executing receipt,
// as SQL authorizes it (qorpera_authorize_machine_coding_value): its answer is
// the box the helper sealed the key in, which only the vault opens, or why not.
// /v1/machine-commands/screen (machine_screen, 20260930708000) runs the image's
// fixed screen helper on the machine: a look (no receipt), or one action for
// one executing receipt, as SQL authorizes it (qorpera_authorize_machine_screen).
// Its answer is the helper's header and the screen's PNG, or why it is held.

/** The machine tools' operation version: receipts and the executor's check both use it. */
export const CLOUD_MACHINE_TOOL_VERSION = "qorpera.machine-tools/v1";
const HASH = /^[0-9a-f]{64}$/;
const REQUEST_LIMIT = 128 * 1024;
const RESULT_LIMIT = 128 * 1024;
const ERROR = "Machine command gateway unavailable";

export interface CloudMachineCommandScope {
	readonly machineId: string;
}
export type CloudMachineCommandStart = {
	commandId: string;
	inputSha256: string;
	command: string;
	timeoutMs: number | null;
	notify: boolean;
};
export type CloudMachineCommandHttpRequest = Readonly<
	{
		schema: "qorpera.machine-command-http/v1";
		binding: CloudNativeToolBinding;
		scope: CloudMachineCommandScope;
	} & (
		| { action: "start"; input: CloudMachineCommandStart }
		| { action: "read"; input: CloudCodingCommandRead }
		| { action: "cancel"; input: { commandId: string } }
	)
>;
/** save_coding_value's request (20260930705000): its receipt and its operation envelope, whose digest the receipt
 * holds. SQL reads everything else, the helper's target too, from them. */
export type CloudMachineCodingValueInput = { commandId: string; envelope: string };
export type CloudMachineCodingValueHttpRequest = Readonly<{
	schema: "qorpera.machine-command-http/v1";
	binding: CloudNativeToolBinding;
	scope: CloudMachineCommandScope;
	action: "coding_value";
	input: CloudMachineCodingValueInput;
}>;
export const CLOUD_MACHINE_CODING_VALUE_SCHEMA = "qorpera.machine-coding-value/v1";
/** The helper's box, sealed to the value's capture key: never the value. */
export interface CloudMachineCodingValueAnswer {
	readonly schema: typeof CLOUD_MACHINE_CODING_VALUE_SCHEMA;
	readonly commandId: string;
	readonly box: Readonly<Record<string, string>>;
}
/** Why a machine sealed nothing, sent back as 409 with its code: the helper's own refusals, a machine that is not
 * running, and one whose image has no helper (it keeps its image across a wake; a new machine has the helper). */
export const CLOUD_MACHINE_CODING_VALUE_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	// A member holds the machine's desktop (20260930713000): nothing is read off its clipboard until they hand it back.
	"DESKTOP_MEMBER_IN_CONTROL",
	"MACHINE_IMAGE_WITHOUT_CODING_VALUES",
	...MACHINE_CODING_VALUE_REFUSALS,
] as const;
export type CloudMachineCodingValueRefusalCode = (typeof CLOUD_MACHINE_CODING_VALUE_REFUSALS)[number];
export class CloudMachineCodingValueRefusal extends Error {
	readonly code: CloudMachineCodingValueRefusalCode;
	constructor(code: CloudMachineCodingValueRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMachineCodingValueRefusal(code: unknown): code is CloudMachineCodingValueRefusalCode {
	return (CLOUD_MACHINE_CODING_VALUE_REFUSALS as readonly unknown[]).includes(code);
}
/** machine_screen's request (20260930708000): a look carries neither receipt nor envelope; an action carries its
 * receipt and its operation envelope, whose digest the receipt holds (SQL reads the action from them, and the executor
 * checks the settle time and the look against the envelope's). */
export type CloudMachineScreenInput = {
	commandId: string | null;
	envelope: string | null;
	settleMs: number;
	look: boolean;
};
export type CloudMachineScreenHttpRequest = Readonly<{
	schema: "qorpera.machine-command-http/v1";
	binding: CloudNativeToolBinding;
	scope: CloudMachineCommandScope;
	action: "screen";
	input: CloudMachineScreenInput;
}>;
export const CLOUD_MACHINE_SCREEN_SCHEMA = "qorpera.machine-screen-answer/v1";
/** The helper's header and the screen's PNG (base64; null: none, or held back), or why the company folder held the
 * picture and the windows' titles back (`heldBack`; what the action did is still told), and who touched the screen
 * since an agent was last told (`memberTouched`, 20260930734000: a member's name and the seconds; never what). */
export interface CloudMachineScreenAnswer {
	readonly schema: typeof CLOUD_MACHINE_SCREEN_SCHEMA;
	readonly commandId: string | null;
	readonly header: MachineScreenHeader;
	readonly png: string | null;
	readonly heldBack?: string;
	readonly memberTouched?: CloudMachineScreenMemberTouched;
}
/** A member acted on the desktop the agent shares with members (20260930734000): who, and how many seconds ago. */
export interface CloudMachineScreenMemberTouched {
	readonly name: string;
	readonly secondsAgo: number;
}
/** Why a machine showed nothing, sent back as 409 with its code: a machine that is not running, a disk that has had a
 * company folder view the caller may not see (review r1 F1), one whose image has no screen helper yet, one that
 * restarted, an action its receipt took on this boot before (never again), another run's action on that desktop right
 * now (review r1 F4), and the helper's own refusals. */
export const CLOUD_MACHINE_SCREEN_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"MACHINE_BOOT_CHANGED",
	"SCREEN_ACTION_TAKEN",
	"DESKTOP_BUSY",
	// A member holds the desktop (20260930713000): no look and no action until they hand it back, and no picture of a
	// look that overlapped one of their actions.
	"DESKTOP_MEMBER_IN_CONTROL",
	...MACHINE_SCREEN_REFUSALS,
] as const;
export type CloudMachineScreenRefusalCode = (typeof CLOUD_MACHINE_SCREEN_REFUSALS)[number];
export class CloudMachineScreenRefusal extends Error {
	readonly code: CloudMachineScreenRefusalCode;
	constructor(code: CloudMachineScreenRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMachineScreenRefusal(code: unknown): code is CloudMachineScreenRefusalCode {
	return (CLOUD_MACHINE_SCREEN_REFUSALS as readonly unknown[]).includes(code);
}
/** An answer carries a PNG of 8 MiB at most, base64, and a small header: well inside this. */
export const CLOUD_MACHINE_SCREEN_RESPONSE_LIMIT = 12 * 1024 * 1024;
/** How long a caller gives a screen: the executor's helper, its folder release, and the way back. */
const SCREEN_DEADLINE_MS = 30000;
/** A pointer move between executors: a newer one replaces it, so it is never worth waiting long for. */
const POINTER_DEADLINE_MS = 3000;

// /v1/machine-commands/member-screen (20260930712000): a member's look at a desktop, sent once by the executor that took
// the member's request (cloud-member-machine-screen-http.ts) to the executor of the machine's node, on the peer listener
// only. It carries the single-use id SQL gave the look (qorpera_member_machine_screen_begin) and the etag of the picture
// the member has; the receiving executor reads SQL again, serves the use, and only ever looks locally. The answer is the
// picture and its etag, the etag alone when the member has that picture, or why there is none.
export const CLOUD_MEMBER_MACHINE_SCREEN_HTTP_SCHEMA = "qorpera.member-machine-screen-http/v1";
export const CLOUD_MEMBER_MACHINE_SCREEN_SCHEMA = "qorpera.member-machine-screen-answer/v1";
const ETAG = /^[0-9a-f]{64}$/;
export interface CloudMemberMachineScreenPeerRequest {
	readonly schema: typeof CLOUD_MEMBER_MACHINE_SCREEN_HTTP_SCHEMA;
	readonly useId: string;
	/** The hex sha-256 of the picture the member has, or null. */
	readonly etag: string | null;
}
/** A member's look: the picture's etag (the hex sha-256 of its bytes) and the picture, or null when it is the one the
 * member has. A held picture is never an answer: it is a refusal (SCREEN_HIDDEN, SCREEN_HELD) with no etag. */
export interface CloudMemberMachineScreen {
	readonly etag: string;
	readonly png: Buffer | null;
}
/** Why a member sees no picture, sent back as 409 with its code: the machine is not running, its disk has had a company
 * folder view and the member does not read the folder's root, a look came within 400 ms of the last one, the screen is
 * off, the machine restarted, its image has no scrot, the machine holds a read the member may not read (SCREEN_HIDDEN),
 * or the company folder has not released what the machine read yet (SCREEN_HELD: look again). */
export const CLOUD_MEMBER_MACHINE_SCREEN_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"SCREEN_TOO_SOON",
	"DESKTOP_NOT_RUNNING",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"SCREEN_HIDDEN",
	"SCREEN_HELD",
	// Another member holds the desktop (20260930713000): its screen is theirs alone until they hand it back.
	"DESKTOP_MEMBER_IN_CONTROL",
] as const;
export type CloudMemberMachineScreenRefusalCode = (typeof CLOUD_MEMBER_MACHINE_SCREEN_REFUSALS)[number];
export class CloudMemberMachineScreenRefusal extends Error {
	readonly code: CloudMemberMachineScreenRefusalCode;
	constructor(code: CloudMemberMachineScreenRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMemberMachineScreenRefusal(code: unknown): code is CloudMemberMachineScreenRefusalCode {
	return (CLOUD_MEMBER_MACHINE_SCREEN_REFUSALS as readonly unknown[]).includes(code);
}
export function parseCloudMemberMachineScreenPeerRequest(value: unknown): CloudMemberMachineScreenPeerRequest {
	const input = closedObject(value, ["schema", "useId", "etag"]);
	if (
		input.schema !== CLOUD_MEMBER_MACHINE_SCREEN_HTTP_SCHEMA ||
		typeof input.useId !== "string" ||
		!UUID.test(input.useId) ||
		(input.etag !== null && (typeof input.etag !== "string" || !ETAG.test(input.etag)))
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: CLOUD_MEMBER_MACHINE_SCREEN_HTTP_SCHEMA,
		useId: input.useId,
		etag: input.etag as string | null,
	});
}
/** The peer's JSON answer to exactly this request: the picture in base64, or null when its etag is the request's. */
export function cloudMemberMachineScreenAnswer(
	request: CloudMemberMachineScreenPeerRequest,
	screen: CloudMemberMachineScreen,
): { schema: string; useId: string; etag: string; png: string | null } {
	return {
		schema: CLOUD_MEMBER_MACHINE_SCREEN_SCHEMA,
		useId: request.useId,
		etag: screen.etag,
		png: screen.png ? screen.png.toString("base64") : null,
	};
}
/** A peer's answer to exactly this request: a PNG of at most 8 MiB whose sha-256 is its etag, or no picture and the
 * request's own etag. */
export function parseCloudMemberMachineScreenAnswer(
	request: CloudMemberMachineScreenPeerRequest,
	value: unknown,
): CloudMemberMachineScreen {
	const answer = closedObject(value, ["schema", "useId", "etag", "png"]);
	if (
		answer.schema !== CLOUD_MEMBER_MACHINE_SCREEN_SCHEMA ||
		answer.useId !== request.useId ||
		typeof answer.etag !== "string" ||
		!ETAG.test(answer.etag)
	)
		throw new Error(ERROR);
	if (answer.png === null) {
		if (answer.etag !== request.etag) throw new Error(ERROR);
		return Object.freeze({ etag: answer.etag, png: null });
	}
	if (typeof answer.png !== "string" || answer.png.length > Math.ceil(MACHINE_SCREEN_MAX_PNG_BYTES / 3) * 4)
		throw new Error(ERROR);
	const png = Buffer.from(answer.png, "base64");
	if (
		png.length === 0 ||
		png.toString("base64") !== answer.png ||
		createHash("sha256").update(png).digest("hex") !== answer.etag
	)
		throw new Error(ERROR);
	return Object.freeze({ etag: answer.etag, png });
}

// /v1/machine-commands/member-act (20260930713000): a member's action on a desktop they hold, sent once by the executor
// that took the member's request (cloud-member-machine-screen-http.ts) to the executor of the machine's node, on the peer
// listener only. It carries the single-use id SQL gave the action (qorpera_member_machine_desktop_act_begin) and the
// action as the member sent it, a typed text with it: that text travels only from the member to the machine's stdin,
// never to SQL (which holds the action with the text's length: cloudMemberMachineActRecord), a log or an error. The
// receiving executor reads SQL again, serves the action (its record must be this action's), and only ever runs it
// locally. The answer is the action's exit, or why it did not run.
export const CLOUD_MEMBER_MACHINE_ACT_HTTP_SCHEMA = "qorpera.member-machine-act-http/v1";
export const CLOUD_MEMBER_MACHINE_ACT_SCHEMA = "qorpera.member-machine-act-answer/v1";
export interface CloudMemberMachineActPeerRequest {
	readonly schema: typeof CLOUD_MEMBER_MACHINE_ACT_HTTP_SCHEMA;
	readonly actionId: string;
	readonly action: MachineScreenAction;
}
/** The action ran: `desktop`'s exit, null when it was cut off at its deadline. Nothing of the screen. */
export interface CloudMemberMachineAct {
	readonly exitCode: number | null;
}
/** Why a member's action did not run, sent back as 409 with its code: the machine is not running, its disk has had a
 * company folder view the member may not see, another member holds the desktop, the member's own hold of it ended
 * (handed back, or its time ran out), another action runs on it now, the machine restarted, its image has no screen
 * helper, the action ran before, and the helper's own refusals (the screen is off, among them). */
export const CLOUD_MEMBER_MACHINE_ACT_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_CONTROL_ENDED",
	"DESKTOP_BUSY",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"SCREEN_ACTION_TAKEN",
	// One member's shared actions on one machine came faster than 25 in 5 seconds (20260930734000).
	"DESKTOP_ACTIONS_TOO_FAST",
	// Someone held the desktop privately since the member's shared input was made (20260930738000).
	"DESKTOP_HELD_SINCE",
	...MACHINE_SCREEN_REFUSALS,
] as const;
export type CloudMemberMachineActRefusalCode = (typeof CLOUD_MEMBER_MACHINE_ACT_REFUSALS)[number];
export class CloudMemberMachineActRefusal extends Error {
	readonly code: CloudMemberMachineActRefusalCode;
	constructor(code: CloudMemberMachineActRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMemberMachineActRefusal(code: unknown): code is CloudMemberMachineActRefusalCode {
	return (CLOUD_MEMBER_MACHINE_ACT_REFUSALS as readonly unknown[]).includes(code);
}
/** A member's action: one of machine_screen's (parseMachineScreenAction), never `open`. Throws a fixed word: a message
 * of the action's own could carry what the member typed. */
export function parseCloudMemberMachineAction(value: unknown): MachineScreenAction {
	let action: MachineScreenAction;
	try {
		action = parseMachineScreenAction(value);
	} catch {
		throw new Error("MEMBER_ACTION_INVALID");
	}
	if (action.type === "open") throw new Error("MEMBER_ACTION_INVALID");
	return action;
}
/** The action as SQL records it (qorpera_valid_member_desktop_action): a typed text by its length in characters alone. */
export function cloudMemberMachineActRecord(action: MachineScreenAction): Record<string, unknown> {
	if (action.type !== "type") return { ...action };
	return { type: "type", length: [...action.text].length };
}
export function parseCloudMemberMachineActPeerRequest(value: unknown): CloudMemberMachineActPeerRequest {
	const input = closedObject(value, ["schema", "actionId", "action"]);
	if (
		input.schema !== CLOUD_MEMBER_MACHINE_ACT_HTTP_SCHEMA ||
		typeof input.actionId !== "string" ||
		!UUID.test(input.actionId)
	)
		throw new Error(ERROR);
	let action: MachineScreenAction;
	try {
		action = parseCloudMemberMachineAction(input.action);
	} catch {
		throw new Error(ERROR);
	}
	return Object.freeze({ schema: CLOUD_MEMBER_MACHINE_ACT_HTTP_SCHEMA, actionId: input.actionId, action });
}
/** The peer's JSON answer to exactly this request. */
export function cloudMemberMachineActAnswer(
	request: CloudMemberMachineActPeerRequest,
	act: CloudMemberMachineAct,
): { schema: string; actionId: string; exitCode: number | null } {
	return { schema: CLOUD_MEMBER_MACHINE_ACT_SCHEMA, actionId: request.actionId, exitCode: act.exitCode };
}
export function parseCloudMemberMachineActAnswer(
	request: CloudMemberMachineActPeerRequest,
	value: unknown,
): CloudMemberMachineAct {
	const answer = closedObject(value, ["schema", "actionId", "exitCode"]);
	if (
		answer.schema !== CLOUD_MEMBER_MACHINE_ACT_SCHEMA ||
		answer.actionId !== request.actionId ||
		(answer.exitCode !== null &&
			(!Number.isSafeInteger(answer.exitCode) ||
				(answer.exitCode as number) < 0 ||
				(answer.exitCode as number) > 255))
	)
		throw new Error(ERROR);
	return Object.freeze({ exitCode: answer.exitCode as number | null });
}

// /v1/machine-commands/member-start (20260930714000): a member turns a desktop computer's screen on, sent once by the
// executor that took the member's request (cloud-member-machine-screen-http.ts) to the executor of the machine's node, on
// the peer listener only. It carries the single-use id SQL gave the start (qorpera_member_machine_desktop_start_begin);
// the receiving executor reads SQL again, serves the start, and only ever runs it locally: the image's own
// `desktop start`. The answer is whether the desktop started or ran already, or why it did not. A start that opens
// something (20260930758000) is the same request: what it opens comes from SQL's read on the machine's node, never over
// this route, and the answer is then "opened", or why not.
export const CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA = "qorpera.member-machine-start-http/v1";
export const CLOUD_MEMBER_MACHINE_START_SCHEMA = "qorpera.member-machine-start-answer/v1";
export interface CloudMemberMachineStartPeerRequest {
	readonly schema: typeof CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA;
	readonly startId: string;
}
/** The desktop runs now: started by this start, or running already (the image's `desktop start` found it running); for a
 * start that opens something (20260930758000), it runs and that is open. */
export interface CloudMemberMachineStart {
	readonly outcome: "started" | "running" | "opened";
}
/** Why a member's start did not end with a running desktop, sent back as 409 with its code: the machine is not running,
 * its disk has had a company folder view the member (or the agent it was started by) may not see, it is too small for a
 * desktop, a start of it began less than 5 seconds ago, the machine restarted, its image has no desktop, or the desktop
 * did not start (the helper failed, or its time ran out). */
export const CLOUD_MEMBER_MACHINE_START_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_START_TOO_SOON",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_IMAGE_WITHOUT_SCREEN",
	"DESKTOP_DID_NOT_START",
	// A start that opens something (20260930758000): a path that is no path of the company folder, one the member may not
	// read or that the computer does not have (told alike), someone else typing privately, a computer without the company
	// folder, and an open that failed.
	"DESKTOP_OPEN_PATH_INVALID",
	"DESKTOP_OPEN_NOT_FOUND",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_OPEN_NO_FOLDER",
	"DESKTOP_DID_NOT_OPEN",
	// The desktop's one actor (an agent's action, a member's) did not let the open through in time (review r1 F1 of #1781).
	"DESKTOP_BUSY",
] as const;
export type CloudMemberMachineStartRefusalCode = (typeof CLOUD_MEMBER_MACHINE_START_REFUSALS)[number];
export class CloudMemberMachineStartRefusal extends Error {
	readonly code: CloudMemberMachineStartRefusalCode;
	constructor(code: CloudMemberMachineStartRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMemberMachineStartRefusal(code: unknown): code is CloudMemberMachineStartRefusalCode {
	return (CLOUD_MEMBER_MACHINE_START_REFUSALS as readonly unknown[]).includes(code);
}
export function parseCloudMemberMachineStartPeerRequest(value: unknown): CloudMemberMachineStartPeerRequest {
	const input = closedObject(value, ["schema", "startId"]);
	if (
		input.schema !== CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA ||
		typeof input.startId !== "string" ||
		!UUID.test(input.startId)
	)
		throw new Error(ERROR);
	return Object.freeze({ schema: CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA, startId: input.startId });
}
/** The peer's JSON answer to exactly this request. */
export function cloudMemberMachineStartAnswer(
	request: CloudMemberMachineStartPeerRequest,
	start: CloudMemberMachineStart,
): { schema: string; startId: string; outcome: string } {
	return { schema: CLOUD_MEMBER_MACHINE_START_SCHEMA, startId: request.startId, outcome: start.outcome };
}
export function parseCloudMemberMachineStartAnswer(
	request: CloudMemberMachineStartPeerRequest,
	value: unknown,
): CloudMemberMachineStart {
	const answer = closedObject(value, ["schema", "startId", "outcome"]);
	if (
		answer.schema !== CLOUD_MEMBER_MACHINE_START_SCHEMA ||
		answer.startId !== request.startId ||
		(answer.outcome !== "started" && answer.outcome !== "running" && answer.outcome !== "opened")
	)
		throw new Error(ERROR);
	return Object.freeze({ outcome: answer.outcome });
}

// /v1/machine-commands/member-pointer (20260930744000): a member's pointer move, sent by the executor that took it
// (cloud-member-machine-screen-http.ts) to the executor of the machine's node, on the peer listener only. It carries the
// pointer pass SQL gave the member (qorpera_member_machine_desktop_pointer_begin) and where the pointer goes, in the
// screen's own pixels: the receiving executor reads SQL once per pass (kept in its memory until the pass runs out) and
// moves the pointer locally. No SQL, row, receipt or log line per move. The answer says whether the pointer moved or the
// move was dropped (the desktop busy with an action, or moves too fast): a dropped move is never queued.
export const CLOUD_MEMBER_MACHINE_POINTER_HTTP_SCHEMA = "qorpera.member-machine-pointer-http/v1";
export const CLOUD_MEMBER_MACHINE_POINTER_SCHEMA = "qorpera.member-machine-pointer-answer/v1";
/** A pointer position on a screen of at most 3840 x 2160 (`desktop size`). */
export const CLOUD_MEMBER_MACHINE_POINTER_MAX_X = 3839;
export const CLOUD_MEMBER_MACHINE_POINTER_MAX_Y = 2159;
export interface CloudMemberMachinePointerPeerRequest {
	readonly schema: typeof CLOUD_MEMBER_MACHINE_POINTER_HTTP_SCHEMA;
	readonly passId: string;
	readonly x: number;
	readonly y: number;
}
/** A move's end: the pointer was given the position (`moved`), or the move was dropped. */
export interface CloudMemberMachinePointerMove {
	readonly moved: boolean;
}
/** Why a member's pointer does not move, sent back as 409 with its code: the pass's own refusals as SQL gives them (the
 * machine not running, a disk the member may not see, too small, someone typing privately, someone who typed privately
 * since the window last knew it, the member's own private hold ended), the screen off, the machine restarted, an image
 * without what moves the pointer, and a pass this executor does not hold or that ran out (POINTER_PASS_ENDED: begin
 * another). */
export const CLOUD_MEMBER_MACHINE_POINTER_REFUSALS = [
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
] as const;
export type CloudMemberMachinePointerRefusalCode = (typeof CLOUD_MEMBER_MACHINE_POINTER_REFUSALS)[number];
export class CloudMemberMachinePointerRefusal extends Error {
	readonly code: CloudMemberMachinePointerRefusalCode;
	constructor(code: CloudMemberMachinePointerRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMemberMachinePointerRefusal(code: unknown): code is CloudMemberMachinePointerRefusalCode {
	return (CLOUD_MEMBER_MACHINE_POINTER_REFUSALS as readonly unknown[]).includes(code);
}
/** A pointer position: whole pixels from the screen's top left, within the largest screen. */
export function isCloudMemberMachinePointerPosition(x: unknown, y: unknown): boolean {
	return (
		typeof x === "number" &&
		typeof y === "number" &&
		Number.isInteger(x) &&
		Number.isInteger(y) &&
		x >= 0 &&
		y >= 0 &&
		x <= CLOUD_MEMBER_MACHINE_POINTER_MAX_X &&
		y <= CLOUD_MEMBER_MACHINE_POINTER_MAX_Y
	);
}
export function parseCloudMemberMachinePointerPeerRequest(value: unknown): CloudMemberMachinePointerPeerRequest {
	const input = closedObject(value, ["schema", "passId", "x", "y"]);
	if (
		input.schema !== CLOUD_MEMBER_MACHINE_POINTER_HTTP_SCHEMA ||
		typeof input.passId !== "string" ||
		!UUID.test(input.passId) ||
		!isCloudMemberMachinePointerPosition(input.x, input.y)
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: CLOUD_MEMBER_MACHINE_POINTER_HTTP_SCHEMA,
		passId: input.passId,
		x: input.x as number,
		y: input.y as number,
	});
}
/** The peer's JSON answer to exactly this request. */
export function cloudMemberMachinePointerAnswer(
	request: CloudMemberMachinePointerPeerRequest,
	move: CloudMemberMachinePointerMove,
): { schema: string; passId: string; moved: boolean } {
	return { schema: CLOUD_MEMBER_MACHINE_POINTER_SCHEMA, passId: request.passId, moved: move.moved };
}
export function parseCloudMemberMachinePointerAnswer(
	request: CloudMemberMachinePointerPeerRequest,
	value: unknown,
): CloudMemberMachinePointerMove {
	const answer = closedObject(value, ["schema", "passId", "moved"]);
	if (
		answer.schema !== CLOUD_MEMBER_MACHINE_POINTER_SCHEMA ||
		answer.passId !== request.passId ||
		typeof answer.moved !== "boolean"
	)
		throw new Error(ERROR);
	return Object.freeze({ moved: answer.moved });
}

// /v1/machine-commands/member-stream (20260930745000): a member's live picture, asked by the executor that admitted the
// member's stream (its listener behind node 1's own tunnel) of the executor of the machine's node, on the peer listener
// only. It names the member's newest pointer pass (the receiving executor reads it in SQL itself, as a move's) and, for a
// private hold, its epoch. The answer streams for as long as the asking executor keeps its request open: frames of a
// kind byte and a length (u32), each `1` a message for the member's browser, the last `2` why it ended. Nothing comes
// the other way: the stream only shows.
export const CLOUD_MEMBER_MACHINE_STREAM_HTTP_SCHEMA = "qorpera.member-machine-stream-http/v1";
export interface CloudMemberMachineStreamPeerRequest {
	readonly schema: typeof CLOUD_MEMBER_MACHINE_STREAM_HTTP_SCHEMA;
	readonly passId: string;
	readonly epoch: number | null;
}
export function parseCloudMemberMachineStreamPeerRequest(value: unknown): CloudMemberMachineStreamPeerRequest {
	const input = closedObject(value, ["schema", "passId", "epoch"]);
	if (
		input.schema !== CLOUD_MEMBER_MACHINE_STREAM_HTTP_SCHEMA ||
		typeof input.passId !== "string" ||
		!UUID.test(input.passId) ||
		!(input.epoch === null || (Number.isSafeInteger(input.epoch) && (input.epoch as number) >= 0))
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: CLOUD_MEMBER_MACHINE_STREAM_HTTP_SCHEMA,
		passId: input.passId,
		epoch: input.epoch as number | null,
	});
}
/** The head of one frame of the peer's streamed answer: a message for the browser (1), or why the stream ended (2),
 * and its length. A picture's payload is written after it as it is, never copied into one buffer with it (the v245
 * release review: up to 8 MiB a message, on the machine node's own event loop). */
export function cloudMemberMachineStreamFrameHead(kind: 1 | 2, length: number): Buffer {
	const head = Buffer.alloc(5);
	head[0] = kind;
	head.writeUInt32BE(length, 1);
	return head;
}
/** One whole frame (a short one: why the stream ended). */
export function cloudMemberMachineStreamFrame(kind: 1 | 2, payload: Buffer): Buffer {
	return Buffer.concat([cloudMemberMachineStreamFrameHead(kind, payload.byteLength), payload]);
}
/** The largest message of a stream (a batch of changed areas): what the host itself can build (8 MiB) and nothing
 * more, so the peer reader holds at most one such frame plus one chunk (review r2 F1 of #1746). */
const STREAM_MESSAGE_BYTES = 8 * 1024 * 1024 + 1024;

/** A peer stream's bytes as they come, read off as `kind u8, length u32, payload` frames. Each byte is copied once into
 * the frame it belongs to, whatever the pieces' sizes. */
class PeerFramePieces {
	readonly #pieces: Buffer[] = [];
	#length = 0;
	push(piece: Buffer): void {
		if (piece.byteLength === 0) return;
		this.#pieces.push(piece);
		this.#length += piece.byteLength;
	}
	/** The next frame's kind and length, once its five header bytes are here. */
	head(): { kind: number; length: number } | null {
		if (this.#length < 5) return null;
		if ((this.#pieces[0] as Buffer).byteLength < 5) {
			// A header split across pieces: just the leading pieces it needs are joined into one, once.
			let count = 0;
			let size = 0;
			while (size < 5) size += (this.#pieces[count++] as Buffer).byteLength;
			this.#pieces.splice(0, count, Buffer.concat(this.#pieces.slice(0, count), size));
		}
		const head = this.#pieces[0] as Buffer;
		return { kind: head[0] as number, length: head.readUInt32BE(1) };
	}
	/** The next frame's payload of `length` bytes, once all of it is here (its header taken with it); else null. */
	take(length: number): Buffer | null {
		if (this.#length < 5 + length) return null;
		const all = this.#pieces.length === 1 ? (this.#pieces[0] as Buffer) : Buffer.concat(this.#pieces, this.#length);
		const payload = all.subarray(5, 5 + length);
		const rest = all.subarray(5 + length);
		this.#pieces.length = 0;
		this.#length = 0;
		this.push(rest);
		return payload;
	}
}

export type CloudMachineAccountFillInput = { commandId: string; envelope: string; idempotencyKey: string };
export type CloudMachineAccountFillHttpRequest = Readonly<{
	schema: "qorpera.machine-command-http/v1";
	binding: CloudNativeToolBinding;
	scope: CloudMachineCommandScope;
	action: "account_fill";
	input: CloudMachineAccountFillInput;
}>;
export const CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA = "qorpera.machine-account-fill/v1";
/** The value was typed whole into the focused box of the account's site; never the value. */
export interface CloudMachineAccountFillAnswer {
	readonly schema: typeof CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA;
	readonly commandId: string;
	readonly filled: true;
}
/** Why a machine typed nothing, sent back as 409 with its code: SQL's answers the agent can act on, a machine whose image
 * has no fill helper yet, the vault's refusal (with the database's own words), and the helper's own codes. */
export const CLOUD_MACHINE_ACCOUNT_FILL_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"ACCOUNTS_SWITCHED_OFF",
	"ACCOUNT_NOT_OPEN",
	"DESKTOP_MEMBER_IN_CONTROL",
	"MACHINE_IMAGE_WITHOUT_ACCOUNT_FILLS",
	"VAULT_REFUSED",
	...MACHINE_ACCOUNT_FILL_REFUSALS,
] as const;
export type CloudMachineAccountFillRefusalCode = (typeof CLOUD_MACHINE_ACCOUNT_FILL_REFUSALS)[number];
export class CloudMachineAccountFillRefusal extends Error {
	readonly code: CloudMachineAccountFillRefusalCode;
	/** The vault's own words, for VAULT_REFUSED only: the database's refusal (no value is ever in one). */
	readonly vault?: string;
	constructor(code: CloudMachineAccountFillRefusalCode, vault?: string) {
		super(code);
		this.code = code;
		if (code === "VAULT_REFUSED" && vault !== undefined) this.vault = vault;
	}
}
export function isCloudMachineAccountFillRefusal(code: unknown): code is CloudMachineAccountFillRefusalCode {
	return (CLOUD_MACHINE_ACCOUNT_FILL_REFUSALS as readonly unknown[]).includes(code);
}
/** The vault's words as they may travel: one line of at most 512 characters. */
export function cloudMachineVaultWords(value: unknown): string | undefined {
	return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value)
		? value
		: undefined;
}

export const CLOUD_MACHINE_APP_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"COMPANY_MACHINE_FOLDER_HELD",
	"MACHINE_APP_TARGET_UNHEALTHY",
	"MACHINE_APP_SPEC_INVALID",
	"MACHINE_GUEST_LEASE_UNAVAILABLE",
] as const;
export type CloudMachineAppRefusalCode = (typeof CLOUD_MACHINE_APP_REFUSALS)[number];
export class CloudMachineAppRefusal extends Error {
	readonly code: CloudMachineAppRefusalCode;
	constructor(code: CloudMachineAppRefusalCode) {
		super(code);
		this.code = code;
	}
}
export function isCloudMachineAppRefusal(value: unknown): value is CloudMachineAppRefusalCode {
	return typeof value === "string" && (CLOUD_MACHINE_APP_REFUSALS as readonly string[]).includes(value);
}

export interface CloudMachineAppStartInput {
	readonly receiptId: string;
	readonly envelope: string;
	readonly slug: string;
	readonly command: string;
	readonly port: number;
	readonly healthPath?: string;
	readonly cwd?: string;
}

export interface CloudMachineAppStartAnswer {
	readonly schema: "qorpera.machine-app-started/v1";
	readonly machineId: string;
	readonly slug: string;
	readonly unit: string;
	readonly port: number;
}

export interface CloudMachineAppStopInput {
	readonly receiptId: string;
	readonly envelope: string;
	readonly slug: string;
}

export interface CloudMachineAppStopAnswer {
	readonly schema: "qorpera.machine-app-stopped/v1";
	readonly slug: string;
	readonly unit: string;
}

export interface CloudMachineAppHealthInput {
	readonly slug: string;
}

export interface CloudMachineAppHealthAnswer {
	readonly schema: "qorpera.machine-app-health/v1";
	readonly slug: string;
	readonly unit: string;
	readonly activeState: string;
	readonly subState: string;
	readonly restarts: number;
	readonly port: number | null;
	readonly healthy: boolean;
	readonly lastStatus: number | null;
	readonly lastLatencyMs: number | null;
	readonly crashSummary: Record<string, unknown> | null;
}

export interface CloudMachineAppReloadInput {
	readonly receiptId: string;
	readonly envelope: string;
	readonly slug: string;
	readonly port?: number;
	readonly healthPath?: string;
}

export interface CloudMachineAppReloadAnswer {
	readonly schema: "qorpera.machine-app-reload/v1";
	readonly slug: string;
	readonly previousPort: number | null;
	readonly activePort: number;
	readonly healthy: boolean;
	readonly restarted: boolean;
}

export interface CloudMachineAppLogsInput {
	readonly slug: string;
	readonly grep?: string;
	readonly tail?: number;
	readonly stream?: "stdout" | "stderr" | "all";
	readonly since?: string;
}

export interface CloudMachineAppLogEntry {
	readonly ts: string;
	readonly seq: number;
	readonly stream: "stdout" | "stderr";
	readonly line: string;
}

export interface CloudMachineAppLogsAnswer {
	readonly schema: "qorpera.machine-app-logs/v1";
	readonly slug: string;
	readonly lines: readonly CloudMachineAppLogEntry[];
	readonly totalMatched: number;
	readonly truncated: boolean;
	readonly crashSummary: Record<string, unknown> | null;
}

export type CloudMachineAppOpInput =
	| Readonly<{ op: "start" } & CloudMachineAppStartInput>
	| Readonly<{ op: "stop" } & CloudMachineAppStopInput>
	| Readonly<{ op: "logs" } & CloudMachineAppLogsInput>
	| Readonly<{ op: "health" } & CloudMachineAppHealthInput>
	| Readonly<{ op: "reload" } & CloudMachineAppReloadInput>;

export type CloudMachineAppAnswer =
	| CloudMachineAppStartAnswer
	| CloudMachineAppStopAnswer
	| CloudMachineAppLogsAnswer
	| CloudMachineAppHealthAnswer
	| CloudMachineAppReloadAnswer;

export type CloudMachineAppHttpRequest = Readonly<{
	schema: "qorpera.machine-command-http/v1";
	binding: CloudNativeToolBinding;
	scope: CloudMachineCommandScope;
	action: "app";
	input: CloudMachineAppOpInput;
}>;

export interface CloudMachineCommandGateway {
	start(
		scope: CloudMachineCommandScope,
		input: CloudMachineCommandStart,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt>;
	read(
		scope: CloudMachineCommandScope,
		input: CloudCodingCommandRead,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt>;
	cancel(scope: CloudMachineCommandScope, commandId: string, signal: AbortSignal): Promise<CloudMachineCommandReceipt>;
	/** Asks for a pass now. With `wait`, it answers once a step took the machine somewhere (true), or after
	 * CLOUD_MACHINE_WAKE_WAIT_MS at most (false); the caller then looks at what SQL says. */
	wake?(scope: CloudMachineCommandScope, wait: boolean, signal: AbortSignal): Promise<boolean>;
	/** save_coding_value (20260930705000): the clipboard helper's box for one executing receipt, or its refusal
	 * (CloudMachineCodingValueRefusal). Sent once: the helper clears the clipboard, so a second send finds nothing. */
	codingValue?(
		scope: CloudMachineCommandScope,
		input: CloudMachineCodingValueInput,
		signal: AbortSignal,
	): Promise<CloudMachineCodingValueAnswer>;
	accountFill?(
		scope: CloudMachineCommandScope,
		input: CloudMachineAccountFillInput,
		signal: AbortSignal,
	): Promise<CloudMachineAccountFillAnswer>;
	/** machine_screen (20260930708000): one look, or one action for one executing receipt, and the screen after it, or
	 * its refusal (CloudMachineScreenRefusal). Sent once: an action is never sent again (an unanswered one is the
	 * agent's to look at). */
	screen?(
		scope: CloudMachineCommandScope,
		input: CloudMachineScreenInput,
		signal: AbortSignal,
	): Promise<CloudMachineScreenAnswer>;
	appStart?(
		scope: CloudMachineCommandScope,
		input: CloudMachineAppStartInput,
		signal: AbortSignal,
	): Promise<CloudMachineAppStartAnswer>;
	appStop?(
		scope: CloudMachineCommandScope,
		input: CloudMachineAppStopInput,
		signal: AbortSignal,
	): Promise<CloudMachineAppStopAnswer>;
	appLogs?(
		scope: CloudMachineCommandScope,
		input: CloudMachineAppLogsInput,
		signal: AbortSignal,
	): Promise<CloudMachineAppLogsAnswer>;
	appHealth?(
		scope: CloudMachineCommandScope,
		input: CloudMachineAppHealthInput,
		signal: AbortSignal,
	): Promise<CloudMachineAppHealthAnswer>;
	appReload?(
		scope: CloudMachineCommandScope,
		input: CloudMachineAppReloadInput,
		signal: AbortSignal,
	): Promise<CloudMachineAppReloadAnswer>;
}

/** How long a wake with `wait` stays open at the executor, well inside the gateway's and the client's bounds. */
export const CLOUD_MACHINE_WAKE_WAIT_MS = 20000;
/** How long a caller gives a wake: the executor's wait, then the way back. */
const WAKE_DEADLINE_MS = CLOUD_MACHINE_WAKE_WAIT_MS + 5000;
export const CLOUD_MACHINE_WAKE_SCHEMA = "qorpera.machine-wake/v1";
export type CloudMachineWakeHttpRequest = Readonly<{
	schema: "qorpera.machine-command-http/v1";
	binding: CloudNativeToolBinding;
	scope: CloudMachineCommandScope;
	action: "wake";
	input: { wait: boolean };
}>;

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!isRecord(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(ERROR);
	return value;
}
/** The first line of a command, for people and notifications (300 characters at most). */
export function cloudMachineCommandHead(command: string): string {
	const head = command.trim().replace(/\s+/g, " ");
	return head.length > 300 ? `${head.slice(0, 297)}...` : head;
}
export function parseCloudMachineCommandHttpRequest(value: unknown, action: string): CloudMachineCommandHttpRequest {
	const input = closedObject(value, ["schema", "binding", "scope", "action", "input"]);
	if (
		input.schema !== "qorpera.machine-command-http/v1" ||
		input.action !== action ||
		!["start", "read", "cancel"].includes(action)
	)
		throw new Error(ERROR);
	const scope = closedObject(input.scope, ["machineId"]);
	if (typeof scope.machineId !== "string" || !UUID.test(scope.machineId)) throw new Error(ERROR);
	const body =
		action === "read"
			? { ...parseCloudCodingCommandRead(input.input) }
			: closedObject(
					input.input,
					action === "start" ? ["commandId", "inputSha256", "command", "timeoutMs", "notify"] : ["commandId"],
				);
	if (typeof body.commandId !== "string" || !UUID.test(body.commandId)) throw new Error(ERROR);
	if (
		action === "start" &&
		(typeof body.inputSha256 !== "string" ||
			!HASH.test(body.inputSha256) ||
			typeof body.command !== "string" ||
			!body.command.trim() ||
			body.command.includes("\0") ||
			Buffer.from(body.command).toString("utf8") !== body.command ||
			Buffer.byteLength(body.command) > 16384 ||
			Buffer.byteLength(JSON.stringify(body.command)) > 60000 ||
			typeof body.notify !== "boolean" ||
			(body.timeoutMs !== null && (!Number.isSafeInteger(body.timeoutMs) || Number(body.timeoutMs) < 1000)))
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.machine-command-http/v1",
		binding: parseCloudNativeToolBinding(input.binding),
		scope: Object.freeze({ machineId: scope.machineId }),
		action,
		input: Object.freeze({ ...body }),
	}) as CloudMachineCommandHttpRequest;
}
export function parseCloudMachineWakeHttpRequest(value: unknown): CloudMachineWakeHttpRequest {
	const input = closedObject(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = closedObject(input.scope, ["machineId"]);
	const body = closedObject(input.input, ["wait"]);
	if (
		input.schema !== "qorpera.machine-command-http/v1" ||
		input.action !== "wake" ||
		typeof scope.machineId !== "string" ||
		!UUID.test(scope.machineId) ||
		typeof body.wait !== "boolean"
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.machine-command-http/v1",
		binding: parseCloudNativeToolBinding(input.binding),
		scope: Object.freeze({ machineId: scope.machineId }),
		action: "wake",
		input: Object.freeze({ wait: body.wait }),
	});
}
export function parseCloudMachineCodingValueHttpRequest(value: unknown): CloudMachineCodingValueHttpRequest {
	const input = closedObject(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = closedObject(input.scope, ["machineId"]);
	const body = closedObject(input.input, ["commandId", "envelope"]);
	if (
		input.schema !== "qorpera.machine-command-http/v1" ||
		input.action !== "coding_value" ||
		typeof scope.machineId !== "string" ||
		!UUID.test(scope.machineId) ||
		typeof body.commandId !== "string" ||
		!UUID.test(body.commandId) ||
		typeof body.envelope !== "string" ||
		!body.envelope ||
		Buffer.byteLength(body.envelope) > 65536
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.machine-command-http/v1",
		binding: parseCloudNativeToolBinding(input.binding),
		scope: Object.freeze({ machineId: scope.machineId }),
		action: "coding_value",
		input: Object.freeze({ commandId: body.commandId, envelope: body.envelope }),
	});
}
const APP_SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const APP_RESPONSE_LIMIT = 131072;

function validAppHealthPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		(value === "" || (value.startsWith("/") && value.length <= 256 && !/[\x00-\x1f\x7f\s]/.test(value)))
	);
}

export function parseCloudMachineAppHttpRequest(value: unknown): CloudMachineAppHttpRequest {
	const req = closedObject(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = closedObject(req.scope, ["machineId"]);
	if (
		req.schema !== "qorpera.machine-command-http/v1" ||
		req.action !== "app" ||
		typeof scope.machineId !== "string" ||
		!UUID.test(scope.machineId) ||
		!req.input ||
		typeof req.input !== "object" ||
		Array.isArray(req.input)
	)
		throw new Error(ERROR);
	const raw = req.input as Record<string, unknown>;
	const op = raw.op;
	const slug = raw.slug;
	if (typeof slug !== "string" || !APP_SLUG.test(slug)) throw new Error(ERROR);
	const validReceipt = (rawReceiptId: unknown, rawEnvelope: unknown): { receiptId: string; envelope: string } => {
		if (
			typeof rawReceiptId !== "string" ||
			!UUID.test(rawReceiptId) ||
			typeof rawEnvelope !== "string" ||
			!rawEnvelope ||
			Buffer.byteLength(rawEnvelope) > 65536
		)
			throw new Error(ERROR);
		return { receiptId: rawReceiptId, envelope: rawEnvelope };
	};
	let input: CloudMachineAppOpInput;
	if (op === "start") {
		const allowed = new Set(["op", "receiptId", "envelope", "slug", "command", "port", "healthPath", "cwd"]);
		if (Object.keys(raw).some((k) => !allowed.has(k))) throw new Error(ERROR);
		const receipt = validReceipt(raw.receiptId, raw.envelope);
		if (
			typeof raw.command !== "string" ||
			!raw.command.trim() ||
			raw.command.includes("\0") ||
			Buffer.byteLength(raw.command) > 16384 ||
			Buffer.byteLength(JSON.stringify(raw.command)) > 32768 ||
			!Number.isInteger(raw.port) ||
			Number(raw.port) < 1 ||
			Number(raw.port) > 65535 ||
			(raw.healthPath !== undefined && !validAppHealthPath(raw.healthPath)) ||
			(raw.cwd !== undefined &&
				(typeof raw.cwd !== "string" ||
					!raw.cwd.startsWith("/") ||
					raw.cwd.length > 512 ||
					/[\0\r\n]/.test(raw.cwd)))
		)
			throw new Error(ERROR);
		input = Object.freeze({
			op: "start",
			...receipt,
			slug,
			command: raw.command,
			port: Number(raw.port),
			...(raw.healthPath !== undefined ? { healthPath: raw.healthPath } : {}),
			...(raw.cwd !== undefined ? { cwd: raw.cwd } : {}),
		});
	} else if (op === "stop") {
		closedObject(raw, ["op", "receiptId", "envelope", "slug"]);
		input = Object.freeze({ op: "stop", ...validReceipt(raw.receiptId, raw.envelope), slug });
	} else if (op === "health") {
		closedObject(raw, ["op", "slug"]);
		input = Object.freeze({ op: "health", slug });
	} else if (op === "reload") {
		const allowed = new Set(["op", "receiptId", "envelope", "slug", "port", "healthPath"]);
		if (Object.keys(raw).some((k) => !allowed.has(k))) throw new Error(ERROR);
		const receipt = validReceipt(raw.receiptId, raw.envelope);
		if (
			(raw.port !== undefined &&
				(!Number.isInteger(raw.port) || Number(raw.port) < 1 || Number(raw.port) > 65535)) ||
			(raw.healthPath !== undefined && !validAppHealthPath(raw.healthPath))
		)
			throw new Error(ERROR);
		input = Object.freeze({
			op: "reload",
			...receipt,
			slug,
			...(raw.port !== undefined ? { port: Number(raw.port) } : {}),
			...(raw.healthPath !== undefined ? { healthPath: raw.healthPath } : {}),
		});
	} else if (op === "logs") {
		const allowed = new Set(["op", "slug", "grep", "tail", "stream", "since"]);
		if (Object.keys(raw).some((k) => !allowed.has(k))) throw new Error(ERROR);
		if (
			(raw.grep !== undefined && (typeof raw.grep !== "string" || raw.grep.length > 256)) ||
			(raw.tail !== undefined && (!Number.isInteger(raw.tail) || Number(raw.tail) < 1 || Number(raw.tail) > 500)) ||
			(raw.stream !== undefined && raw.stream !== "stdout" && raw.stream !== "stderr" && raw.stream !== "all") ||
			(raw.since !== undefined &&
				(typeof raw.since !== "string" || raw.since.length > 64 || Number.isNaN(Date.parse(raw.since))))
		)
			throw new Error(ERROR);
		input = Object.freeze({
			op: "logs",
			slug,
			...(raw.grep !== undefined ? { grep: raw.grep } : {}),
			...(raw.tail !== undefined ? { tail: Number(raw.tail) } : {}),
			...(raw.stream !== undefined ? { stream: raw.stream } : {}),
			...(raw.since !== undefined ? { since: raw.since } : {}),
		});
	} else {
		throw new Error(ERROR);
	}
	return Object.freeze({
		schema: "qorpera.machine-command-http/v1",
		binding: parseCloudNativeToolBinding(req.binding),
		scope: Object.freeze({ machineId: scope.machineId }),
		action: "app",
		input,
	});
}

export function parseCloudMachineAppAnswer(request: CloudMachineAppHttpRequest, value: unknown): CloudMachineAppAnswer {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(ERROR);
	const raw = value as Record<string, unknown>;
	if (raw.slug !== request.input.slug) throw new Error(ERROR);
	if (request.input.op === "start") {
		if (
			raw.schema !== "qorpera.machine-app-started/v1" ||
			typeof raw.machineId !== "string" ||
			typeof raw.unit !== "string" ||
			!Number.isInteger(raw.port)
		)
			throw new Error(ERROR);
		return Object.freeze({
			schema: "qorpera.machine-app-started/v1",
			machineId: raw.machineId,
			slug: request.input.slug,
			unit: raw.unit,
			port: Number(raw.port),
		});
	}
	if (request.input.op === "stop") {
		if (raw.schema !== "qorpera.machine-app-stopped/v1" || typeof raw.unit !== "string") throw new Error(ERROR);
		return Object.freeze({
			schema: "qorpera.machine-app-stopped/v1",
			slug: request.input.slug,
			unit: raw.unit,
		});
	}
	if (request.input.op === "health") {
		if (
			raw.schema !== "qorpera.machine-app-health/v1" ||
			typeof raw.unit !== "string" ||
			typeof raw.activeState !== "string" ||
			typeof raw.subState !== "string" ||
			!Number.isSafeInteger(raw.restarts) ||
			(raw.port !== null && !Number.isInteger(raw.port)) ||
			typeof raw.healthy !== "boolean" ||
			(raw.lastStatus !== null && !Number.isInteger(raw.lastStatus)) ||
			(raw.lastLatencyMs !== null && typeof raw.lastLatencyMs !== "number") ||
			(raw.crashSummary !== null && (typeof raw.crashSummary !== "object" || Array.isArray(raw.crashSummary)))
		)
			throw new Error(ERROR);
		return Object.freeze({
			schema: "qorpera.machine-app-health/v1",
			slug: request.input.slug,
			unit: raw.unit,
			activeState: raw.activeState,
			subState: raw.subState,
			restarts: Number(raw.restarts),
			port: raw.port === null ? null : Number(raw.port),
			healthy: raw.healthy,
			lastStatus: raw.lastStatus === null ? null : Number(raw.lastStatus),
			lastLatencyMs: raw.lastLatencyMs === null ? null : Number(raw.lastLatencyMs),
			crashSummary: (raw.crashSummary as Record<string, unknown> | null) ?? null,
		});
	}
	if (request.input.op === "reload") {
		if (
			raw.schema !== "qorpera.machine-app-reload/v1" ||
			(raw.previousPort !== null && !Number.isInteger(raw.previousPort)) ||
			!Number.isInteger(raw.activePort) ||
			typeof raw.healthy !== "boolean" ||
			typeof raw.restarted !== "boolean"
		)
			throw new Error(ERROR);
		return Object.freeze({
			schema: "qorpera.machine-app-reload/v1",
			slug: request.input.slug,
			previousPort: raw.previousPort === null ? null : Number(raw.previousPort),
			activePort: Number(raw.activePort),
			healthy: raw.healthy,
			restarted: raw.restarted,
		});
	}
	if (
		raw.schema !== "qorpera.machine-app-logs/v1" ||
		!Array.isArray(raw.lines) ||
		!Number.isSafeInteger(raw.totalMatched) ||
		typeof raw.truncated !== "boolean" ||
		(raw.crashSummary !== null && (typeof raw.crashSummary !== "object" || Array.isArray(raw.crashSummary)))
	)
		throw new Error(ERROR);
	const lines: CloudMachineAppLogEntry[] = [];
	for (const item of raw.lines) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(ERROR);
		const entry = item as Record<string, unknown>;
		if (
			typeof entry.ts !== "string" ||
			!Number.isSafeInteger(entry.seq) ||
			(entry.stream !== "stdout" && entry.stream !== "stderr") ||
			typeof entry.line !== "string"
		)
			throw new Error(ERROR);
		lines.push(
			Object.freeze({
				ts: entry.ts,
				seq: Number(entry.seq),
				stream: entry.stream,
				line: entry.line,
			}),
		);
	}
	return Object.freeze({
		schema: "qorpera.machine-app-logs/v1",
		slug: request.input.slug,
		lines: Object.freeze(lines),
		totalMatched: Number(raw.totalMatched),
		truncated: raw.truncated,
		crashSummary: (raw.crashSummary as Record<string, unknown> | null) ?? null,
	});
}

export function parseCloudMachineAccountFillHttpRequest(value: unknown): CloudMachineAccountFillHttpRequest {
	const input = closedObject(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = closedObject(input.scope, ["machineId"]);
	const body = closedObject(input.input, ["commandId", "envelope", "idempotencyKey"]);
	if (
		input.schema !== "qorpera.machine-command-http/v1" ||
		input.action !== "account_fill" ||
		typeof scope.machineId !== "string" ||
		!UUID.test(scope.machineId) ||
		typeof body.commandId !== "string" ||
		!UUID.test(body.commandId) ||
		typeof body.envelope !== "string" ||
		!body.envelope ||
		Buffer.byteLength(body.envelope) > 65536 ||
		typeof body.idempotencyKey !== "string" ||
		!HASH.test(body.idempotencyKey)
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.machine-command-http/v1",
		binding: parseCloudNativeToolBinding(input.binding),
		scope: Object.freeze({ machineId: scope.machineId }),
		action: "account_fill",
		input: Object.freeze({ commandId: body.commandId, envelope: body.envelope, idempotencyKey: body.idempotencyKey }),
	});
}
/** The executor's answer to exactly this request: typed, and nothing else. */
export function parseCloudMachineAccountFillAnswer(
	request: CloudMachineAccountFillHttpRequest,
	value: unknown,
): CloudMachineAccountFillAnswer {
	const answer = closedObject(value, ["schema", "commandId", "filled"]);
	if (
		answer.schema !== CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA ||
		answer.commandId !== request.input.commandId ||
		answer.filled !== true
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: CLOUD_MACHINE_ACCOUNT_FILL_SCHEMA,
		commandId: request.input.commandId,
		filled: true,
	});
}
/** The executor's answer to exactly this request: its receipt and a box of the helper's shape. */
export function parseCloudMachineCodingValueAnswer(
	request: CloudMachineCodingValueHttpRequest,
	value: unknown,
): CloudMachineCodingValueAnswer {
	const answer = closedObject(value, ["schema", "commandId", "box"]);
	const box = closedObject(answer.box, ["schema", "ephemeralPublicKey", "iv", "tag", "ciphertext"]);
	if (
		answer.schema !== CLOUD_MACHINE_CODING_VALUE_SCHEMA ||
		answer.commandId !== request.input.commandId ||
		Object.values(box).some((part) => typeof part !== "string" || !part || part.length > 8192)
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: CLOUD_MACHINE_CODING_VALUE_SCHEMA,
		commandId: request.input.commandId,
		box: Object.freeze({ ...(box as Record<string, string>) }),
	});
}
export function parseCloudMachineScreenHttpRequest(value: unknown): CloudMachineScreenHttpRequest {
	const input = closedObject(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = closedObject(input.scope, ["machineId"]);
	const body = closedObject(input.input, ["commandId", "envelope", "settleMs", "look"]);
	if (
		input.schema !== "qorpera.machine-command-http/v1" ||
		input.action !== "screen" ||
		typeof scope.machineId !== "string" ||
		!UUID.test(scope.machineId) ||
		(body.commandId === null) !== (body.envelope === null) ||
		(body.commandId !== null && (typeof body.commandId !== "string" || !UUID.test(body.commandId))) ||
		(body.envelope !== null &&
			(typeof body.envelope !== "string" || !body.envelope || Buffer.byteLength(body.envelope) > 65536)) ||
		!Number.isSafeInteger(body.settleMs) ||
		(body.settleMs as number) < 0 ||
		(body.settleMs as number) > MACHINE_SCREEN_MAX_SETTLE_MS ||
		typeof body.look !== "boolean"
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: "qorpera.machine-command-http/v1",
		binding: parseCloudNativeToolBinding(input.binding),
		scope: Object.freeze({ machineId: scope.machineId }),
		action: "screen",
		input: Object.freeze({
			commandId: body.commandId as string | null,
			envelope: body.envelope as string | null,
			settleMs: body.settleMs as number,
			look: body.look,
		}),
	});
}
/** The executor's answer to exactly this request: its receipt (null for a look), a header of the helper's shape, and a
 * PNG of as many bytes as the header says, or none with the reason it is held back. */
export function parseCloudMachineScreenAnswer(
	request: CloudMachineScreenHttpRequest,
	value: unknown,
): CloudMachineScreenAnswer {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(ERROR);
	const held = "heldBack" in value;
	const touched = "memberTouched" in value;
	const answer = closedObject(value, [
		"schema",
		"commandId",
		"header",
		"png",
		...(held ? ["heldBack"] : []),
		...(touched ? ["memberTouched"] : []),
	]);
	let memberTouched: CloudMachineScreenMemberTouched | undefined;
	if (touched) {
		const told = answer.memberTouched;
		if (
			!told ||
			typeof told !== "object" ||
			Array.isArray(told) ||
			Object.keys(told).sort().join() !== "name,secondsAgo"
		)
			throw new Error(ERROR);
		const { name, secondsAgo } = told as Record<string, unknown>;
		if (
			typeof name !== "string" ||
			!name.trim() ||
			// SQL's member names: up to 256 characters (code points, never UTF-16 units; review r1 F2 of #1701).
			[...name].length > 256 ||
			typeof secondsAgo !== "number" ||
			!Number.isSafeInteger(secondsAgo) ||
			secondsAgo < 0
		)
			throw new Error(ERROR);
		memberTouched = Object.freeze({ name, secondsAgo });
	}
	let header: MachineScreenHeader;
	try {
		header = parseMachineScreenHeader(answer.header);
	} catch {
		throw new Error(ERROR);
	}
	const png =
		typeof answer.png === "string" && answer.png.length <= Math.ceil(MACHINE_SCREEN_MAX_PNG_BYTES / 3) * 4
			? Buffer.from(answer.png, "base64")
			: null;
	if (
		answer.schema !== CLOUD_MACHINE_SCREEN_SCHEMA ||
		answer.commandId !== request.input.commandId ||
		(answer.png !== null && (png === null || png.toString("base64") !== answer.png || png.length !== header.png)) ||
		(answer.png === null && header.png !== 0) ||
		(held &&
			(answer.png !== null ||
				typeof answer.heldBack !== "string" ||
				!answer.heldBack ||
				answer.heldBack.length > 300 ||
				header.windows.length > 0 ||
				header.activeWindow !== null))
	)
		throw new Error(ERROR);
	return Object.freeze({
		schema: CLOUD_MACHINE_SCREEN_SCHEMA,
		commandId: request.input.commandId,
		header,
		png: answer.png as string | null,
		...(held ? { heldBack: answer.heldBack as string } : {}),
		...(memberTouched ? { memberTouched } : {}),
	});
}
function validToken(value: string): boolean {
	return isValidBase64UrlToken(value);
}
function origin(value: string, allowLoopback: boolean): string {
	return parseTrustedOrigin(value, allowLoopback, ERROR);
}
/** The receipt answers exactly the request: its machine, its command and, for
 * a start, the command's input digest; a read page stays within its limit. */
export function checkCloudMachineCommandReceipt(
	request: CloudMachineCommandHttpRequest,
	value: unknown,
): CloudMachineCommandReceipt {
	const receipt = parseCloudMachineCommandReceipt(value);
	if (
		receipt.machineId !== request.scope.machineId ||
		receipt.commandId !== request.input.commandId ||
		(request.action === "start" && receipt.inputSha256 !== request.input.inputSha256) ||
		(request.action === "read" &&
			((!request.input.tail && receipt.log.offset !== (request.input.offset ?? 0)) ||
				Buffer.byteLength(receipt.output) > (request.input.limit ?? 4096)))
	)
		throw new Error(ERROR);
	return receipt;
}

/** A request the executor did not answer: it timed out, its connection failed, or a proxy in front of the executor
 * answered instead (5xx). Whether it reached the executor is not known. An answer from the executor itself, a refusal or
 * its 403 for any other failure, is not this. */
export class CloudMachineCommandUnanswered extends Error {
	constructor() {
		super(ERROR);
	}
}

/** Credential and binding are host-only; no model argument chooses a host or route. One request is sent once: only
 * machine_run sends a start again, under its rules (cloud-machine-tools.ts). */
export function createHttpCloudMachineCommandGateway(options: {
	url: string;
	token: string;
	binding: CloudNativeToolBinding;
	/** G2-6b: the run's holder credential, read per request (NativeHostDispatch.holderHeader). Null only for an
	 * executor forwarding to its peer, which holds no run's lease. */
	holder: (() => string) | null;
	/** What the executors said they take for a page (keyholes S1): one per process, shared by its gateways (an
	 * executor's to its peers too). A gateway without it learns only from its own answers. */
	pages?: CloudCommandPages;
	allowLoopback?: boolean;
	fetch?: typeof fetch;
}): CloudMachineCommandGateway {
	const base = origin(options.url, options.allowLoopback ?? false);
	if (!validToken(options.token)) throw new Error(ERROR);
	const binding = parseCloudNativeToolBinding(options.binding);
	const transport = options.fetch ?? fetch;
	const pages = options.pages ?? new CloudCommandPages();
	const send = async (
		action: "start" | "read" | "cancel",
		scope: CloudMachineCommandScope,
		input: unknown,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> => {
		try {
			// A read asks the executor for no more than it said it takes; a smaller page answers it as well.
			const read = action === "read" ? parseCloudCodingCommandRead(input) : undefined;
			const asked = read ? { ...read, limit: Math.min(read.limit ?? 4096, pages.of(base)) } : input;
			const admitted = parseCloudMachineCommandHttpRequest(
				{ schema: "qorpera.machine-command-http/v1", binding, scope, action, input: asked },
				action,
			);
			const body = JSON.stringify(admitted);
			if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
			return await withCloudDeadline(
				async (requestSignal) => {
					const response = await transport(`${base}/v1/machine-commands/${action}`, {
						method: "POST",
						redirect: "error",
						signal: requestSignal,
						headers: {
							authorization: `Bearer ${options.token}`,
							"content-type": "application/json",
							...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
						},
						body,
					}).catch(() => {
						throw new CloudMachineCommandUnanswered();
					});
					pages.heard(base, response.headers);
					if (response.status >= 500) {
						void response.body?.cancel().catch(() => undefined);
						throw new CloudMachineCommandUnanswered();
					}
					if (response.status !== 200) {
						// A refusal names a fixed code the agent can act on (not running, a start given up), and why
						// the machine lost the command when the company folder made it (6e-2a): an unknown cause is dropped.
						let refused: { code?: unknown; folderLost?: unknown } = {};
						if (response.status === 409)
							refused = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as typeof refused;
						else void response.body?.cancel().catch(() => undefined);
						const { code, folderLost } = refused ?? {};
						if ((CLOUD_MACHINE_COMMAND_REFUSALS as readonly unknown[]).includes(code))
							throw new CloudMachineCommandRefusal(
								code as CloudMachineCommandRefusalCode,
								isCloudMachineFolderLost(folderLost) ? folderLost : undefined,
							);
						throw new Error(typeof code === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(code) ? code : ERROR);
					}
					const bytes = await readBoundedCloudResponse(response, RESULT_LIMIT, requestSignal);
					return checkCloudMachineCommandReceipt(
						admitted,
						JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
					);
				},
				30000,
				signal,
			);
		} catch (error) {
			if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
				throw new CloudMachineCommandUnanswered();
			throw error instanceof Error && /^[A-Z][A-Z0-9_]{2,60}$/.test(error.message) ? error : new Error(ERROR);
		}
	};
	/** A call; a read once more when the executor stopped saying what it takes (one rolled back under this process),
	 * since such an executor refuses a page past what it takes and says nothing, and a refused read showed nothing. */
	const request = async (
		action: "start" | "read" | "cancel",
		scope: CloudMachineCommandScope,
		input: unknown,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> => {
		// What a read may ask the executor for now; nothing for any other call, or a read that does not parse (`send`
		// refuses it).
		const limit = (): number => {
			try {
				return action === "read" ? Math.min(parseCloudCodingCommandRead(input).limit ?? 4096, pages.of(base)) : 0;
			} catch {
				return 0;
			}
		};
		const asked = limit();
		try {
			return await send(action, scope, input, signal);
		} catch (error) {
			if (
				error instanceof CloudMachineCommandRefusal ||
				error instanceof CloudMachineCommandUnanswered ||
				limit() >= asked
			)
				throw error;
			return send(action, scope, input, signal);
		}
	};
	return Object.freeze<CloudMachineCommandGateway>({
		start: (scope, input, signal) => request("start", scope, input, signal),
		read: (scope, input, signal) => request("read", scope, input, signal),
		cancel: (scope, commandId, signal) => request("cancel", scope, { commandId }, signal),
		wake: async (scope, wait, signal) => {
			try {
				const admitted = parseCloudMachineWakeHttpRequest({
					schema: "qorpera.machine-command-http/v1",
					binding,
					scope,
					action: "wake",
					input: { wait },
				});
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/wake`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: {
								authorization: `Bearer ${options.token}`,
								"content-type": "application/json",
								...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
							},
							body: JSON.stringify(admitted),
						});
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						const answer = closedObject(
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							),
							["schema", "told"],
						);
						if (answer.schema !== CLOUD_MACHINE_WAKE_SCHEMA || typeof answer.told !== "boolean")
							throw new Error(ERROR);
						return answer.told;
					},
					WAKE_DEADLINE_MS,
					signal,
				);
			} catch {
				throw new Error(ERROR);
			}
		},
		codingValue: async (scope, input, signal) => {
			try {
				const admitted = parseCloudMachineCodingValueHttpRequest({
					schema: "qorpera.machine-command-http/v1",
					binding,
					scope,
					action: "coding_value",
					input,
				});
				const body = JSON.stringify(admitted);
				if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/coding-value`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: {
								authorization: `Bearer ${options.token}`,
								"content-type": "application/json",
								...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
							},
							body,
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown };
							if (isCloudMachineCodingValueRefusal(code)) throw new CloudMachineCodingValueRefusal(code);
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMachineCodingValueAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 16384, requestSignal),
								),
							),
						);
					},
					30000,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMachineCodingValueRefusal) throw error;
				throw new Error(ERROR);
			}
		},
		accountFill: async (scope, input, signal) => {
			try {
				const admitted = parseCloudMachineAccountFillHttpRequest({
					schema: "qorpera.machine-command-http/v1",
					binding,
					scope,
					action: "account_fill",
					input,
				});
				const body = JSON.stringify(admitted);
				if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/account-fill`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: {
								authorization: `Bearer ${options.token}`,
								"content-type": "application/json",
								...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
							},
							body,
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code, vault } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown; vault?: unknown };
							if (isCloudMachineAccountFillRefusal(code))
								throw new CloudMachineAccountFillRefusal(code, cloudMachineVaultWords(vault));
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMachineAccountFillAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							),
						);
					},
					30000,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMachineAccountFillRefusal) throw error;
				throw new Error(ERROR);
			}
		},
		screen: async (scope, input, signal) => {
			try {
				const admitted = parseCloudMachineScreenHttpRequest({
					schema: "qorpera.machine-command-http/v1",
					binding,
					scope,
					action: "screen",
					input,
				});
				const body = JSON.stringify(admitted);
				if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/screen`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: {
								authorization: `Bearer ${options.token}`,
								"content-type": "application/json",
								...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
							},
							body,
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown };
							if (isCloudMachineScreenRefusal(code)) throw new CloudMachineScreenRefusal(code);
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMachineScreenAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, CLOUD_MACHINE_SCREEN_RESPONSE_LIMIT, requestSignal),
								),
							),
						);
					},
					SCREEN_DEADLINE_MS,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMachineScreenRefusal) throw error;
				throw new Error(ERROR);
			}
		},
		appStart: async (scope, input, signal) =>
			(await postApp(scope, { op: "start", ...input }, signal)) as CloudMachineAppStartAnswer,
		appStop: async (scope, input, signal) =>
			(await postApp(scope, { op: "stop", ...input }, signal)) as CloudMachineAppStopAnswer,
		appLogs: async (scope, input, signal) =>
			(await postApp(scope, { op: "logs", ...input }, signal)) as CloudMachineAppLogsAnswer,
		appHealth: async (scope, input, signal) =>
			(await postApp(scope, { op: "health", ...input }, signal)) as CloudMachineAppHealthAnswer,
		appReload: async (scope, input, signal) =>
			(await postApp(scope, { op: "reload", ...input }, signal)) as CloudMachineAppReloadAnswer,
	});

	async function postApp(
		scope: CloudMachineCommandScope,
		input: CloudMachineAppOpInput,
		signal: AbortSignal,
	): Promise<CloudMachineAppAnswer> {
		try {
			const admitted = parseCloudMachineAppHttpRequest({
				schema: "qorpera.machine-command-http/v1",
				binding,
				scope,
				action: "app",
				input,
			});
			const body = JSON.stringify(admitted);
			if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new Error(ERROR);
			return await withCloudDeadline(
				async (requestSignal) => {
					const response = await transport(`${base}/v1/machine-commands/app`, {
						method: "POST",
						redirect: "error",
						signal: requestSignal,
						headers: {
							authorization: `Bearer ${options.token}`,
							"content-type": "application/json",
							...(options.holder ? { "x-qorpera-identity": options.holder() } : {}),
						},
						body,
					}).catch(() => {
						throw new CloudMachineCommandUnanswered();
					});
					if (response.status >= 500) {
						void response.body?.cancel().catch(() => undefined);
						throw new CloudMachineCommandUnanswered();
					}
					if (response.status === 409) {
						const { code } = JSON.parse(
							new TextDecoder("utf8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 4096, requestSignal),
							),
						) as { code?: unknown };
						if (isCloudMachineAppRefusal(code)) throw new CloudMachineAppRefusal(code);
						throw new Error(ERROR);
					}
					if (response.status !== 200) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error(ERROR);
					}
					return parseCloudMachineAppAnswer(
						admitted,
						JSON.parse(
							new TextDecoder("utf8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, APP_RESPONSE_LIMIT, requestSignal),
							),
						),
					);
				},
				30000,
				signal,
			);
		} catch (error) {
			if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
				throw new CloudMachineCommandUnanswered();
			if (error instanceof CloudMachineAppRefusal) throw error;
			throw new Error(ERROR);
		}
	}
}

/** Sends one of a desktop's messages to a member's sink and gives up the moment `signal` aborts: a browser that stops
 * reading while it still answers pings must hold neither this peer request, nor the admission slot, nor the socket past
 * the pass's end (review r2 F3 of #1746). The message may still be on its way; nothing after it is sent. */
async function sendOrAbort(
	sink: { send(message: Buffer): Promise<void> },
	message: Buffer,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) throw new Error("MEMBER_MACHINE_STREAM_CANCELLED");
	let give: () => void = () => {};
	const stopped = new Promise<never>((_, reject) => {
		give = () => reject(new Error("MEMBER_MACHINE_STREAM_CANCELLED"));
		signal.addEventListener("abort", give, { once: true });
	});
	// Handled by the race below; nothing is left unhandled when the send wins.
	stopped.catch(() => {});
	try {
		await Promise.race([sink.send(message), stopped]);
	} finally {
		signal.removeEventListener("abort", give);
	}
}

/** A member's look sent to the executor of the machine's node (20260930712000), on its peer listener with the peer
 * token: sent once, never again (the use it carries is served once), and its refusal comes back as the same refusal. */
export function createHttpMemberMachineScreenPeer(options: {
	url: string;
	token: string;
	allowLoopback?: boolean;
	fetch?: typeof fetch;
	streamConnectTimeoutMs?: number;
}): {
	memberScreen(
		request: { useId: string; etag: string | null },
		signal: AbortSignal,
	): Promise<CloudMemberMachineScreen>;
	/** A member's action (20260930713000), sent once; its refusal comes back as the same refusal. */
	memberAct(
		request: { actionId: string; action: MachineScreenAction },
		signal: AbortSignal,
	): Promise<CloudMemberMachineAct>;
	/** A member's start of the desktop (20260930714000), sent once; its refusal comes back as the same refusal. */
	memberStart(request: { startId: string }, signal: AbortSignal): Promise<CloudMemberMachineStart>;
	/** A member's pointer move (20260930744000), sent once and never again (a newer one replaces it); its refusal comes
	 * back as the same refusal. */
	memberPointer(
		request: { passId: string; x: number; y: number },
		signal: AbortSignal,
	): Promise<CloudMemberMachinePointerMove>;
	/** A member's live picture (20260930745000): streams the peer's messages to `sink` until `signal` aborts or the peer
	 * ends it; answers why it ended (STREAM_UNAVAILABLE when the peer's answer broke off). */
	memberStream(
		request: { passId: string; epoch: number | null },
		sink: { send(message: Buffer): Promise<void> },
		signal: AbortSignal,
	): Promise<string>;
} {
	const base = origin(options.url, options.allowLoopback ?? false);
	if (!validToken(options.token)) throw new Error(ERROR);
	const transport = options.fetch ?? fetch;
	return Object.freeze({
		memberScreen: async (input: { useId: string; etag: string | null }, signal: AbortSignal) => {
			try {
				const admitted = parseCloudMemberMachineScreenPeerRequest({
					schema: CLOUD_MEMBER_MACHINE_SCREEN_HTTP_SCHEMA,
					useId: input.useId,
					etag: input.etag,
				});
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/member-screen`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
							body: JSON.stringify(admitted),
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown };
							if (isCloudMemberMachineScreenRefusal(code)) throw new CloudMemberMachineScreenRefusal(code);
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMemberMachineScreenAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, CLOUD_MACHINE_SCREEN_RESPONSE_LIMIT, requestSignal),
								),
							),
						);
					},
					SCREEN_DEADLINE_MS,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMemberMachineScreenRefusal) throw error;
				throw new Error(ERROR);
			}
		},
		memberAct: async (input: { actionId: string; action: MachineScreenAction }, signal: AbortSignal) => {
			try {
				const admitted = parseCloudMemberMachineActPeerRequest({
					schema: CLOUD_MEMBER_MACHINE_ACT_HTTP_SCHEMA,
					actionId: input.actionId,
					action: input.action,
				});
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/member-act`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
							body: JSON.stringify(admitted),
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown };
							if (isCloudMemberMachineActRefusal(code)) throw new CloudMemberMachineActRefusal(code);
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMemberMachineActAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							),
						);
					},
					SCREEN_DEADLINE_MS,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMemberMachineActRefusal) throw error;
				throw new Error(ERROR);
			}
		},
		memberStart: async (input: { startId: string }, signal: AbortSignal) => {
			try {
				const admitted = parseCloudMemberMachineStartPeerRequest({
					schema: CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA,
					startId: input.startId,
				});
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/member-start`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
							body: JSON.stringify(admitted),
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown };
							if (isCloudMemberMachineStartRefusal(code)) throw new CloudMemberMachineStartRefusal(code);
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMemberMachineStartAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							),
						);
					},
					SCREEN_DEADLINE_MS,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMemberMachineStartRefusal) throw error;
				throw new Error(ERROR);
			}
		},
		memberStream: async (
			input: { passId: string; epoch: number | null },
			sink: { send(message: Buffer): Promise<void> },
			signal: AbortSignal,
		) => {
			const admitted = parseCloudMemberMachineStreamPeerRequest({
				schema: CLOUD_MEMBER_MACHINE_STREAM_HTTP_SCHEMA,
				passId: input.passId,
				epoch: input.epoch,
			});
			// WHY: Bound peer connect/header wait without AbortSignal.any so a blackholed node cannot pin a stream slot for hours.
			const connectTimeoutMs = options.streamConnectTimeoutMs ?? 15_000;
			const requestController = new AbortController();
			const abortRequest = () => requestController.abort(signal.reason);
			if (signal.aborted) requestController.abort(signal.reason);
			else signal.addEventListener("abort", abortRequest, { once: true });
			let connectTimer: ReturnType<typeof setTimeout> | undefined;
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				connectTimer = setTimeout(() => {
					requestController.abort(new Error("STREAM_CONNECT_TIMEOUT"));
				}, connectTimeoutMs);
				let response: Response;
				try {
					response = await transport(`${base}/v1/machine-commands/member-stream`, {
						method: "POST",
						redirect: "error",
						signal: requestController.signal,
						headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
						body: JSON.stringify(admitted),
					});
				} catch {
					return signal.aborted ? "closed" : "STREAM_UNAVAILABLE";
				} finally {
					clearTimeout(connectTimer);
					connectTimer = undefined;
				}
				if (response.status === 409) {
					const { code } = JSON.parse(
						new TextDecoder("utf8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 4096, signal),
						),
					) as { code?: unknown };
					return isCloudMemberMachinePointerRefusal(code) ? code : "STREAM_UNAVAILABLE";
				}
				if (response.status !== 200 || !response.body) {
					void response.body?.cancel().catch(() => undefined);
					return "STREAM_UNAVAILABLE";
				}
				reader = response.body.getReader();
				// The pieces of the frame being read, joined once it is whole: never a growing buffer copied again for every
				// piece (the v245 release review: 8 MiB in small pieces was quadratic copying on node 1's event loop).
				const pieces = new PeerFramePieces();
				for (;;) {
					const next = await reader.read();
					if (next.done) return signal.aborted ? "closed" : "STREAM_UNAVAILABLE";
					pieces.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
					for (;;) {
						const head = pieces.head();
						if (!head) break;
						const { kind, length } = head;
						if ((kind !== 1 && kind !== 2) || length > STREAM_MESSAGE_BYTES) return "STREAM_UNAVAILABLE";
						const payload = pieces.take(length);
						if (!payload) break;
						if (kind === 2) {
							const reason = payload.toString("utf8");
							return /^[A-Za-z_]{1,64}$/.test(reason) ? reason : "STREAM_UNAVAILABLE";
						}
						// The member's browser takes it before the next is read: a slow one slows this, nothing else. One
						// that stops reading while it still answers pings holds nothing once the stream is cancelled:
						// the send gives up with the signal, and nothing after it is sent (review r2 F3 of #1746).
						if (signal.aborted) return "closed";
						await sendOrAbort(sink, payload, signal);
					}
				}
			} catch {
				return signal.aborted ? "closed" : "STREAM_UNAVAILABLE";
			} finally {
				if (connectTimer !== undefined) clearTimeout(connectTimer);
				signal.removeEventListener("abort", abortRequest);
				void reader?.cancel().catch(() => undefined);
			}
		},
		memberPointer: async (input: { passId: string; x: number; y: number }, signal: AbortSignal) => {
			try {
				const admitted = parseCloudMemberMachinePointerPeerRequest({
					schema: CLOUD_MEMBER_MACHINE_POINTER_HTTP_SCHEMA,
					passId: input.passId,
					x: input.x,
					y: input.y,
				});
				return await withCloudDeadline(
					async (requestSignal) => {
						const response = await transport(`${base}/v1/machine-commands/member-pointer`, {
							method: "POST",
							redirect: "error",
							signal: requestSignal,
							headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
							body: JSON.stringify(admitted),
						}).catch(() => {
							throw new CloudMachineCommandUnanswered();
						});
						if (response.status >= 500) {
							void response.body?.cancel().catch(() => undefined);
							throw new CloudMachineCommandUnanswered();
						}
						if (response.status === 409) {
							const { code } = JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							) as { code?: unknown };
							if (isCloudMemberMachinePointerRefusal(code)) throw new CloudMemberMachinePointerRefusal(code);
							throw new Error(ERROR);
						}
						if (response.status !== 200) {
							void response.body?.cancel().catch(() => undefined);
							throw new Error(ERROR);
						}
						return parseCloudMemberMachinePointerAnswer(
							admitted,
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							),
						);
					},
					POINTER_DEADLINE_MS,
					signal,
				);
			} catch (error) {
				if (error instanceof CloudMachineCommandUnanswered || error instanceof CloudRequestTimeoutError)
					throw new CloudMachineCommandUnanswered();
				if (error instanceof CloudMemberMachinePointerRefusal) throw error;
				throw new Error(ERROR);
			}
		},
	});
}

/** A refusal the agent can act on, sent back as 409 with its code, and for a command its machine lost for the
 * company folder, the cause (`folderLost`, a key of CLOUD_MACHINE_FOLDER_LOST; F3 6e-2a). */
export const CLOUD_MACHINE_COMMAND_REFUSALS = [
	"MACHINE_NOT_RUNNING",
	"MACHINE_COMMAND_ENDED",
	// A member holds the machine's desktop (20260930713000): no new command starts until they hand it back.
	"DESKTOP_MEMBER_IN_CONTROL",
] as const;
export type CloudMachineCommandRefusalCode = (typeof CLOUD_MACHINE_COMMAND_REFUSALS)[number];
export class CloudMachineCommandRefusal extends Error {
	readonly code: CloudMachineCommandRefusalCode;
	readonly folderLost?: string;
	constructor(code: CloudMachineCommandRefusalCode, folderLost?: string) {
		super(code);
		this.code = code;
		if (folderLost !== undefined) this.folderLost = folderLost;
	}
}
/** A refusal as it reaches a caller: from this executor's SQL, or from a peer's 409. */
export function cloudMachineCommandRefusal(error: unknown): CloudMachineCommandRefusalCode | null {
	if (error instanceof CloudMachineCommandRefusal) return error.code;
	return error instanceof Error && (CLOUD_MACHINE_COMMAND_REFUSALS as readonly string[]).includes(error.message)
		? (error.message as CloudMachineCommandRefusalCode)
		: null;
}

/** The executor side of the machine route (HttpCloudCodingCommandService):
 * authorize in SQL, execute on the machine's node, authorize again. */
export interface CloudMachineCommandServiceOptions {
	authorize(request: CloudMachineCommandHttpRequest, signal: AbortSignal): Promise<{ inputSha256: string }>;
	execute(request: CloudMachineCommandHttpRequest, signal: AbortSignal): Promise<unknown>;
	/** Asks the machines' executors for a pass now; true once a step took the machine somewhere. */
	wake?(request: CloudMachineWakeHttpRequest, signal: AbortSignal): Promise<boolean>;
	/** save_coding_value (20260930705000): authorized in SQL and run on the machine's node, or forwarded there; a
	 * refusal is a CloudMachineCodingValueRefusal. */
	codingValue?(
		request: CloudMachineCodingValueHttpRequest,
		signal: AbortSignal,
	): Promise<CloudMachineCodingValueAnswer>;
	accountFill?(
		request: CloudMachineAccountFillHttpRequest,
		signal: AbortSignal,
	): Promise<CloudMachineAccountFillAnswer>;
	/** machine_screen (20260930708000): authorized in SQL and run on the machine's node, or forwarded there; a refusal
	 * is a CloudMachineScreenRefusal. */
	screen?(request: CloudMachineScreenHttpRequest, signal: AbortSignal): Promise<CloudMachineScreenAnswer>;
	app?(request: CloudMachineAppHttpRequest, signal: AbortSignal): Promise<CloudMachineAppAnswer>;
	/** A member's look (20260930712000), on the peer listener only: authorized in SQL and looked at on this node; a
	 * refusal is a CloudMemberMachineScreenRefusal. */
	memberScreen?(request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
	/** A member's action (20260930713000), on the peer listener only: authorized in SQL and run on this node; a refusal
	 * is a CloudMemberMachineActRefusal. */
	memberAct?(request: CloudMemberMachineActPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineAct>;
	/** A member's start of the desktop (20260930714000), on the peer listener only: authorized in SQL and run on this
	 * node; a refusal is a CloudMemberMachineStartRefusal. */
	memberStart?(request: CloudMemberMachineStartPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineStart>;
	/** A member's pointer move (20260930744000), on the peer listener only: its pass read in SQL once and kept, and the
	 * pointer moved on this node; a refusal is a CloudMemberMachinePointerRefusal. */
	memberPointer?(
		request: CloudMemberMachinePointerPeerRequest,
		signal: AbortSignal,
	): Promise<CloudMemberMachinePointerMove>;
	/** A member's live picture (20260930745000), on the peer listener only: its pass read in SQL and the desktop streamed
	 * from this node to `sink` until `signal` aborts or it ends; answers why it ended. A refusal before it began (the
	 * pass) is a CloudMemberMachinePointerRefusal. */
	memberStream?(
		request: CloudMemberMachineStreamPeerRequest,
		sink: { send(message: Buffer): Promise<void> },
		signal: AbortSignal,
	): Promise<string>;
}
export async function serveCloudMachineCommand(
	options: CloudMachineCommandServiceOptions,
	body: unknown,
	action: string,
	signal: AbortSignal,
): Promise<CloudMachineCommandReceipt> {
	const admitted = parseCloudMachineCommandHttpRequest(body, action);
	const authority = await options.authorize(admitted, signal);
	if (
		!HASH.test(authority.inputSha256) ||
		(admitted.action === "start" && authority.inputSha256 !== admitted.input.inputSha256)
	)
		throw new Error(ERROR);
	signal.throwIfAborted();
	const receipt = checkCloudMachineCommandReceipt(admitted, await options.execute(admitted, signal));
	if (receipt.inputSha256 !== authority.inputSha256) throw new Error(ERROR);
	let after: { inputSha256: string };
	try {
		after = await options.authorize(admitted, signal);
	} catch (error) {
		// The machine stopped (or the command ended) after the guest answered: its answer stands,
		// so a start that happened is never reported as one that did not.
		if (cloudMachineCommandRefusal(error)) return receipt;
		throw error;
	}
	signal.throwIfAborted();
	if (after.inputSha256 !== authority.inputSha256) throw new Error(ERROR);
	return receipt;
}
