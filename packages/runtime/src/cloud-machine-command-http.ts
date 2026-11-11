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
	parseCloudCodingCommandRead,
	parseCloudMachineCommandReceipt,
} from "@qorpera/contracts";
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
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
 * running, and one whose image has no helper yet (it gets it once it sleeps and wakes from the current image). */
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
 * picture and the windows' titles back (`heldBack`; what the action did is still told). */
export interface CloudMachineScreenAnswer {
	readonly schema: typeof CLOUD_MACHINE_SCREEN_SCHEMA;
	readonly commandId: string | null;
	readonly header: MachineScreenHeader;
	readonly png: string | null;
	readonly heldBack?: string;
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
	const input = record(value, ["schema", "useId", "etag"]);
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
	const answer = record(value, ["schema", "useId", "etag", "png"]);
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
	const input = record(value, ["schema", "actionId", "action"]);
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
	const answer = record(value, ["schema", "actionId", "exitCode"]);
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
// `desktop start`. The answer is whether the desktop started or ran already, or why it did not.
export const CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA = "qorpera.member-machine-start-http/v1";
export const CLOUD_MEMBER_MACHINE_START_SCHEMA = "qorpera.member-machine-start-answer/v1";
export interface CloudMemberMachineStartPeerRequest {
	readonly schema: typeof CLOUD_MEMBER_MACHINE_START_HTTP_SCHEMA;
	readonly startId: string;
}
/** The desktop runs now: started by this start, or running already (the image's `desktop start` found it running). */
export interface CloudMemberMachineStart {
	readonly outcome: "started" | "running";
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
	const input = record(value, ["schema", "startId"]);
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
	const answer = record(value, ["schema", "startId", "outcome"]);
	if (
		answer.schema !== CLOUD_MEMBER_MACHINE_START_SCHEMA ||
		answer.startId !== request.startId ||
		(answer.outcome !== "started" && answer.outcome !== "running")
	)
		throw new Error(ERROR);
	return Object.freeze({ outcome: answer.outcome });
}

/** Host-side: the fixed gateway to the executor of the machine's node. */
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
	/** machine_screen (20260930708000): one look, or one action for one executing receipt, and the screen after it, or
	 * its refusal (CloudMachineScreenRefusal). Sent once: an action is never sent again (an unanswered one is the
	 * agent's to look at). */
	screen?(
		scope: CloudMachineCommandScope,
		input: CloudMachineScreenInput,
		signal: AbortSignal,
	): Promise<CloudMachineScreenAnswer>;
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

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error(ERROR);
	return value as Record<string, unknown>;
}
/** The first line of a command, for people and notifications (300 characters at most). */
export function cloudMachineCommandHead(command: string): string {
	const head = command.trim().replace(/\s+/g, " ");
	return head.length > 300 ? `${head.slice(0, 297)}...` : head;
}
export function parseCloudMachineCommandHttpRequest(value: unknown, action: string): CloudMachineCommandHttpRequest {
	const input = record(value, ["schema", "binding", "scope", "action", "input"]);
	if (
		input.schema !== "qorpera.machine-command-http/v1" ||
		input.action !== action ||
		!["start", "read", "cancel"].includes(action)
	)
		throw new Error(ERROR);
	const scope = record(input.scope, ["machineId"]);
	if (typeof scope.machineId !== "string" || !UUID.test(scope.machineId)) throw new Error(ERROR);
	const body =
		action === "read"
			? { ...parseCloudCodingCommandRead(input.input) }
			: record(
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
	const input = record(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = record(input.scope, ["machineId"]);
	const body = record(input.input, ["wait"]);
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
	const input = record(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = record(input.scope, ["machineId"]);
	const body = record(input.input, ["commandId", "envelope"]);
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
/** The executor's answer to exactly this request: its receipt and a box of the helper's shape. */
export function parseCloudMachineCodingValueAnswer(
	request: CloudMachineCodingValueHttpRequest,
	value: unknown,
): CloudMachineCodingValueAnswer {
	const answer = record(value, ["schema", "commandId", "box"]);
	const box = record(answer.box, ["schema", "ephemeralPublicKey", "iv", "tag", "ciphertext"]);
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
	const input = record(value, ["schema", "binding", "scope", "action", "input"]);
	const scope = record(input.scope, ["machineId"]);
	const body = record(input.input, ["commandId", "envelope", "settleMs", "look"]);
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
	const answer = record(value, ["schema", "commandId", "header", "png", ...(held ? ["heldBack"] : [])]);
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
	});
}
function validToken(value: string): boolean {
	return (
		TOKEN.test(value) &&
		Buffer.from(value, "base64url").length === 32 &&
		Buffer.from(value, "base64url").toString("base64url") === value
	);
}
function origin(value: string, allowLoopback: boolean): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(ERROR);
	return url.origin;
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
	allowLoopback?: boolean;
	fetch?: typeof fetch;
}): CloudMachineCommandGateway {
	const base = origin(options.url, options.allowLoopback ?? false);
	if (!validToken(options.token)) throw new Error(ERROR);
	const binding = parseCloudNativeToolBinding(options.binding);
	const transport = options.fetch ?? fetch;
	const request = async (
		action: "start" | "read" | "cancel",
		scope: CloudMachineCommandScope,
		input: unknown,
		signal: AbortSignal,
	): Promise<CloudMachineCommandReceipt> => {
		try {
			const admitted = parseCloudMachineCommandHttpRequest(
				{ schema: "qorpera.machine-command-http/v1", binding, scope, action, input },
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
						const answer = record(
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
	});
}

/** A member's look sent to the executor of the machine's node (20260930712000), on its peer listener with the peer
 * token: sent once, never again (the use it carries is served once), and its refusal comes back as the same refusal. */
export function createHttpMemberMachineScreenPeer(options: {
	url: string;
	token: string;
	allowLoopback?: boolean;
	fetch?: typeof fetch;
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
	/** machine_screen (20260930708000): authorized in SQL and run on the machine's node, or forwarded there; a refusal
	 * is a CloudMachineScreenRefusal. */
	screen?(request: CloudMachineScreenHttpRequest, signal: AbortSignal): Promise<CloudMachineScreenAnswer>;
	/** A member's look (20260930712000), on the peer listener only: authorized in SQL and looked at on this node; a
	 * refusal is a CloudMemberMachineScreenRefusal. */
	memberScreen?(request: CloudMemberMachineScreenPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineScreen>;
	/** A member's action (20260930713000), on the peer listener only: authorized in SQL and run on this node; a refusal
	 * is a CloudMemberMachineActRefusal. */
	memberAct?(request: CloudMemberMachineActPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineAct>;
	/** A member's start of the desktop (20260930714000), on the peer listener only: authorized in SQL and run on this
	 * node; a refusal is a CloudMemberMachineStartRefusal. */
	memberStart?(request: CloudMemberMachineStartPeerRequest, signal: AbortSignal): Promise<CloudMemberMachineStart>;
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
