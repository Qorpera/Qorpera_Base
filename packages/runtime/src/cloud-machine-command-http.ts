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
import { type CloudNativeToolBinding, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";

// Machine commands travel the coding executor's command gateway (the same
// HTTPS ingress, peer routing and transport credential) on their own route,
// /v1/machine-commands/{start|read|cancel}. The scope names a company
// machine, never a node, host or address; SQL decides where it runs.
// /v1/machine-commands/wake asks the machines' executors for a pass now: it
// carries no authority (each step of that pass asks SQL) and gives nothing away
// but "look again".

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
	});
}

/** A refusal the agent can act on, sent back as 409 with its code, and for a command its machine lost for the
 * company folder, the cause (`folderLost`, a key of CLOUD_MACHINE_FOLDER_LOST; F3 6e-2a). */
export const CLOUD_MACHINE_COMMAND_REFUSALS = ["MACHINE_NOT_RUNNING", "MACHINE_COMMAND_ENDED"] as const;
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
