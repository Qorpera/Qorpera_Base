import { isUuid } from "./wire-values.ts";

// The coding guest agent's protocol (F3 step 5g-2b; deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md "The guest
// agent", "Mounts in the VM", "Commands and sessions"). The agent is root's program in a member's coding machine and
// is untrusted: the executor drives it only over LXD exec, one verb per exec (`/usr/bin/node <agent> <verb>`), with
// the request as JSON on stdin (never in an argument, LXD config or a unit's environment) and the answer as one JSON
// line on stdout. `output` follows its line with exactly the bytes the line names. Both sides parse with these
// functions: the agent its requests, the executor every answer as bounded, untrusted data. The executor's journal and
// SQL stay the truth; an answer is an observation.

const CODE = /^(?:[A-Z][A-Z0-9_]{2,80}(?::[A-Z][A-Z0-9_]{0,63})?|AbortError|TimeoutError)$/;
const SIGNAL = /^SIG[A-Z0-9]{2,12}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The agent's fixed places and bounds. */
export const CODING_GUEST = /* @__PURE__ */ Object.freeze({
	node: "/usr/bin/node",
	/** Pushed by the executor at each start; 5f makes the folder (root 0755). */
	agent: "/opt/qorpera-guest/agent.mjs",
	/** On the machine's disk: each session's commands, their intents and their output rings. */
	state: "/var/lib/qorpera-guest",
	/** In memory: a command's input until systemd opened it, and the session networks' allocation. */
	runtime: "/run/qorpera-guest",
	/** In memory: each session's view file, the folder program's state and its mount. */
	folder: "/run/qorpera-folder",
	folderProgram: "/opt/qorpera-folder/qorpera-folder",
	/** A request on stdin. */
	maxInputBytes: 65536,
	/** One `output` answer's bytes. */
	maxPageBytes: 1048576,
	/** How long `output` waits for new bytes while the command runs. */
	maxWaitMs: 20000,
	/** A command's output ring: this many segments of this size; anything older is a gap. */
	segmentBytes: 1048576,
	segments: 8,
	/** Session uids (SQL allocates one per session). */
	minUid: 200000,
	maxUid: 524287,
	/** One `status` answer's commands. */
	maxStatusCommands: 256,
});

export type CodingGuestVerb = "mount" | "run" | "output" | "cancel" | "quiesce" | "stop-session" | "status";
export const CODING_GUEST_VERBS: readonly CodingGuestVerb[] = /* @__PURE__ */ Object.freeze([
	"mount",
	"run",
	"output",
	"cancel",
	"quiesce",
	"stop-session",
	"status",
]);

/** A coding view the node's folder service opened for the session (5g-4 opens it). */
export interface CodingGuestView {
	readonly environmentId: string;
	readonly viewId: string;
	readonly pass: string;
}
/** Shows the session's newest view at /run/qorpera-folder/mounts/<worker32>, owned by the session's uid. */
export interface CodingGuestMountRequest {
	readonly schema: "qorpera.coding-guest-mount/v1";
	readonly workerId: string;
	readonly uid: number;
	readonly gid: number;
	readonly view: CodingGuestView;
}
/** Starts a command once per commandId: the same request again only reads its state, another is refused. */
export interface CodingGuestRunRequest {
	readonly schema: "qorpera.coding-guest-run/v1";
	readonly workerId: string;
	readonly commandId: string;
	readonly uid: number;
	readonly gid: number;
	/** Run by `bash --noprofile --norc -c`. */
	readonly command: string;
	readonly cwd: string;
	/** The whole environment, built by the executor; nothing of the guest's is added. */
	readonly environment: Readonly<Record<string, string>>;
	/** A deadline the agent chose; null runs it until it exits or is cancelled. */
	readonly timeoutMs: number | null;
}
/** Reads a command's output from `offset`; waits up to `waitMs` while it runs and has nothing new. */
export interface CodingGuestOutputRequest {
	readonly schema: "qorpera.coding-guest-output/v1";
	readonly workerId: string;
	readonly commandId: string;
	readonly offset: number;
	readonly maxBytes: number;
	readonly waitMs: number;
}
export interface CodingGuestCancelRequest {
	readonly schema: "qorpera.coding-guest-cancel/v1";
	readonly workerId: string;
	readonly commandId: string;
}
/** `quiesce`, `stop-session` and `status`. */
export interface CodingGuestSessionRequest {
	readonly schema: "qorpera.coding-guest-session/v1";
	readonly workerId: string;
}
export interface CodingGuestRequests {
	mount: CodingGuestMountRequest;
	run: CodingGuestRunRequest;
	output: CodingGuestOutputRequest;
	cancel: CodingGuestCancelRequest;
	quiesce: CodingGuestSessionRequest;
	"stop-session": CodingGuestSessionRequest;
	status: CodingGuestSessionRequest;
}

/** running: its unit runs it; exited: bash ended (exit says how); cancelled: the executor stopped it; timed_out: its
 * deadline stopped it; lost: it ended with no record of how (the machine restarted, or its unit is gone). */
export type CodingGuestCommandState = "running" | "exited" | "cancelled" | "timed_out" | "lost";
/** How bash ended: one of the two is set. */
export interface CodingGuestExit {
	readonly code: number | null;
	readonly signal: string | null;
}
export interface CodingGuestCommand {
	readonly commandId: string;
	readonly state: CodingGuestCommandState;
	readonly exit: CodingGuestExit | null;
	/** Every byte the command printed so far; final once the state is not running. */
	readonly end: number;
}
export interface CodingGuestMountAnswer {
	readonly schema: "qorpera.coding-guest-mounted/v1";
	readonly workerId: string;
	readonly viewId: string;
	/** mounted: the program's mount is up; closed: the node closed or refused the view; unanswered: not yet. */
	readonly mount: "mounted" | "closed" | "unanswered";
}
/** `run` and `cancel`. */
export interface CodingGuestCommandAnswer extends CodingGuestCommand {
	readonly schema: "qorpera.coding-guest-command/v1";
	readonly workerId: string;
}
/** Followed by exactly `bytes` bytes of output, which start at `offset`. `gap` is how many bytes before `offset` the
 * ring had already dropped since the requested offset. */
export interface CodingGuestOutputAnswer extends CodingGuestCommand {
	readonly schema: "qorpera.coding-guest-output/v1";
	readonly workerId: string;
	readonly offset: number;
	readonly bytes: number;
	readonly gap: number;
}
/** Nothing of the session runs any more (its commands, its user manager), and its view is still mounted. */
export interface CodingGuestSessionQuiescedAnswer {
	readonly schema: "qorpera.coding-guest-session-quiesced/v1";
	readonly workerId: string;
}
export interface CodingGuestSessionStoppedAnswer {
	readonly schema: "qorpera.coding-guest-session-stopped/v1";
	readonly workerId: string;
}
/** The session's work so far, on its boot's clock: what the executor's one idle rule (`@qorpera/contracts` idle-rule)
 * compares between two looks, to tell busy commands from waiting ones. */
export interface CodingGuestUsage {
	readonly bootId: string;
	/** When it was read: /proc/uptime. */
	readonly uptimeMs: number;
	/** The processor time of the session's slice and of its user's slice (the user manager and what that started). */
	readonly cpuUsageUsec: number;
	/** The bytes their running processes passed to read and write calls so far (/proc/<pid>/io rchar + wchar), the
	 * command relays' aside. */
	readonly ioBytes: number;
}
export interface CodingGuestStatusAnswer {
	readonly schema: "qorpera.coding-guest-status/v2";
	readonly workerId: string;
	/** Every running command, then the newest of the rest; at most CODING_GUEST.maxStatusCommands. The agent refuses
	 * rather than leave a running command out. */
	readonly commands: readonly CodingGuestCommand[];
	readonly usage: CodingGuestUsage;
}
export interface CodingGuestAnswers {
	mount: CodingGuestMountAnswer;
	run: CodingGuestCommandAnswer;
	output: CodingGuestOutputAnswer;
	cancel: CodingGuestCommandAnswer;
	quiesce: CodingGuestSessionQuiescedAnswer;
	"stop-session": CodingGuestSessionStoppedAnswer;
	status: CodingGuestStatusAnswer;
}
/** Any verb's refusal: nothing was started, or the outcome is unknown and a read shows it. */
export interface CodingGuestRefusal {
	readonly schema: "qorpera.coding-guest-refusal/v1";
	readonly code: string;
}

function object(value: unknown, keys: string, error: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error(error);
	return value as Record<string, unknown>;
}
function id(value: unknown, error: string): string {
	if (!isUuid(value)) throw new Error(error);
	return value;
}
function count(value: unknown, max: number, error: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(error);
	return Number(value);
}
function sessionUid(value: unknown, error: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < CODING_GUEST.minUid || Number(value) > CODING_GUEST.maxUid)
		throw new Error(error);
	return Number(value);
}
function text(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		!value.includes("\0") &&
		!/[\ud800-\udfff]/u.test(value) &&
		Buffer.byteLength(value) <= maxBytes
	);
}
/** An absolute path without `.` or `..` parts, empty parts or a trailing slash (but `/`). */
function absolutePath(value: unknown): value is string {
	return (
		text(value, 4096) &&
		value.startsWith("/") &&
		(value === "/" ||
			value
				.slice(1)
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== ".."))
	);
}

const REQUEST_KEYS: Record<CodingGuestVerb, string> = {
	mount: "gid,schema,uid,view,workerId",
	run: "command,commandId,cwd,environment,gid,schema,timeoutMs,uid,workerId",
	output: "commandId,maxBytes,offset,schema,waitMs,workerId",
	cancel: "commandId,schema,workerId",
	quiesce: "schema,workerId",
	"stop-session": "schema,workerId",
	status: "schema,workerId",
};
const REQUEST_SCHEMAS: Record<CodingGuestVerb, string> = {
	mount: "qorpera.coding-guest-mount/v1",
	run: "qorpera.coding-guest-run/v1",
	output: "qorpera.coding-guest-output/v1",
	cancel: "qorpera.coding-guest-cancel/v1",
	quiesce: "qorpera.coding-guest-session/v1",
	"stop-session": "qorpera.coding-guest-session/v1",
	status: "qorpera.coding-guest-session/v1",
};

/** The view's three fields are printable ASCII without spaces: the folder program reads them from a file. */
function codingView(value: unknown, error: string): CodingGuestView {
	const view = object(value, "environmentId,pass,viewId", error);
	if (!Object.values(view).every((field) => typeof field === "string" && /^[\x21-\x7e]{1,256}$/.test(field)))
		throw new Error(error);
	return Object.freeze({
		environmentId: view.environmentId as string,
		viewId: view.viewId as string,
		pass: view.pass as string,
	});
}

/** A verb's request, closed and bounded. Never quotes the input in its error: a view's pass or an environment's
 * secret may be in it. */
export function parseCodingGuestRequest<V extends CodingGuestVerb>(verb: V, value: unknown): CodingGuestRequests[V] {
	const error = "Invalid coding guest request";
	if (!CODING_GUEST_VERBS.includes(verb)) throw new Error(error);
	const input = object(value, REQUEST_KEYS[verb], error);
	if (input.schema !== REQUEST_SCHEMAS[verb]) throw new Error(error);
	id(input.workerId, error);
	if ("commandId" in input) id(input.commandId, error);
	if (verb === "mount" || verb === "run") {
		sessionUid(input.uid, error);
		sessionUid(input.gid, error);
	}
	if (verb === "mount") return Object.freeze({ ...input, view: codingView(input.view, error) }) as never;
	if (verb === "run") {
		const environment = input.environment;
		if (
			!text(input.command, 16384) ||
			!input.command.trim() ||
			!absolutePath(input.cwd) ||
			!environment ||
			typeof environment !== "object" ||
			Array.isArray(environment) ||
			Object.keys(environment).length > 256 ||
			!Object.entries(environment).every(([name, setting]) => ENVIRONMENT_NAME.test(name) && text(setting, 32768)) ||
			(input.timeoutMs !== null && (!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000))
		)
			throw new Error(error);
		return Object.freeze({ ...input, environment: Object.freeze({ ...environment }) }) as never;
	}
	if (verb === "output") {
		count(input.offset, Number.MAX_SAFE_INTEGER, error);
		if (count(input.maxBytes, CODING_GUEST.maxPageBytes, error) < 1) throw new Error(error);
		count(input.waitMs, CODING_GUEST.maxWaitMs, error);
	}
	return Object.freeze({ ...input }) as never;
}

function exit(value: unknown, error: string): CodingGuestExit | null {
	if (value === null) return null;
	const input = object(value, "code,signal", error);
	if (
		input.code === null
			? typeof input.signal !== "string" || !SIGNAL.test(input.signal)
			: input.signal !== null ||
				!Number.isSafeInteger(input.code) ||
				Number(input.code) < 0 ||
				Number(input.code) > 255
	)
		throw new Error(error);
	return Object.freeze({ code: input.code as number | null, signal: input.signal as string | null });
}
function command(input: Record<string, unknown>, error: string): CodingGuestCommand {
	const state = input.state;
	const ended = exit(input.exit, error);
	if (
		typeof state !== "string" ||
		!["running", "exited", "cancelled", "timed_out", "lost"].includes(state) ||
		(state === "exited" ? ended === null : (state === "running" || state === "lost") && ended !== null)
	)
		throw new Error(error);
	return {
		commandId: id(input.commandId, error),
		state: state as CodingGuestCommandState,
		exit: ended,
		end: count(input.end, Number.MAX_SAFE_INTEGER, error),
	};
}

/** A refusal, or undefined when the line is not one. */
export function parseCodingGuestRefusal(value: unknown): CodingGuestRefusal | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if ((value as Record<string, unknown>).schema !== "qorpera.coding-guest-refusal/v1") return undefined;
	const input = object(value, "code,schema", "Invalid coding guest refusal");
	if (typeof input.code !== "string" || !CODE.test(input.code)) throw new Error("Invalid coding guest refusal");
	return Object.freeze({ schema: "qorpera.coding-guest-refusal/v1", code: input.code });
}

/** A verb's answer line (already parsed JSON), checked against the request it answers. A refusal is not an answer:
 * read it with parseCodingGuestRefusal first. */
export function parseCodingGuestAnswer<V extends CodingGuestVerb>(
	verb: V,
	request: CodingGuestRequests[V],
	value: unknown,
): CodingGuestAnswers[V] {
	const error = "Invalid coding guest answer";
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
	const workerId = request.workerId;
	if ((value as Record<string, unknown>).workerId !== workerId) throw new Error(error);
	if (verb === "mount") {
		const input = object(value, "mount,schema,viewId,workerId", error);
		if (
			input.schema !== "qorpera.coding-guest-mounted/v1" ||
			input.viewId !== (request as CodingGuestMountRequest).view.viewId ||
			typeof input.mount !== "string" ||
			!["mounted", "closed", "unanswered"].includes(input.mount)
		)
			throw new Error(error);
		return Object.freeze({ ...input }) as never;
	}
	if (verb === "run" || verb === "cancel") {
		const input = object(value, "commandId,end,exit,schema,state,workerId", error);
		const read = command(input, error);
		if (
			input.schema !== "qorpera.coding-guest-command/v1" ||
			read.commandId !== (request as CodingGuestCancelRequest).commandId
		)
			throw new Error(error);
		return Object.freeze({ schema: "qorpera.coding-guest-command/v1", workerId, ...read }) as never;
	}
	if (verb === "output") {
		const asked = request as CodingGuestOutputRequest;
		const input = object(value, "bytes,commandId,end,exit,gap,offset,schema,state,workerId", error);
		const read = command(input, error);
		const offset = count(input.offset, Number.MAX_SAFE_INTEGER, error);
		const bytes = count(input.bytes, asked.maxBytes, error);
		const gap = count(input.gap, Number.MAX_SAFE_INTEGER, error);
		if (
			input.schema !== "qorpera.coding-guest-output/v1" ||
			read.commandId !== asked.commandId ||
			offset !== asked.offset + gap ||
			offset + bytes > read.end
		)
			throw new Error(error);
		return Object.freeze({
			schema: "qorpera.coding-guest-output/v1",
			workerId,
			...read,
			offset,
			bytes,
			gap,
		}) as never;
	}
	if (verb === "quiesce" || verb === "stop-session") {
		const schema =
			verb === "quiesce" ? "qorpera.coding-guest-session-quiesced/v1" : "qorpera.coding-guest-session-stopped/v1";
		const input = object(value, "schema,workerId", error);
		if (input.schema !== schema) throw new Error(error);
		return Object.freeze({ schema, workerId }) as never;
	}
	const input = object(value, "commands,schema,usage,workerId", error);
	if (
		input.schema !== "qorpera.coding-guest-status/v2" ||
		!Array.isArray(input.commands) ||
		input.commands.length > CODING_GUEST.maxStatusCommands
	)
		throw new Error(error);
	const commands = input.commands.map((entry) =>
		Object.freeze(command(object(entry, "commandId,end,exit,state", error), error)),
	);
	if (new Set(commands.map((entry) => entry.commandId)).size !== commands.length) throw new Error(error);
	const usage = object(input.usage, "bootId,cpuUsageUsec,ioBytes,uptimeMs", error);
	return Object.freeze({
		schema: "qorpera.coding-guest-status/v2",
		workerId,
		commands: Object.freeze(commands),
		usage: Object.freeze({
			bootId: id(usage.bootId, error),
			uptimeMs: count(usage.uptimeMs, Number.MAX_SAFE_INTEGER, error),
			cpuUsageUsec: count(usage.cpuUsageUsec, Number.MAX_SAFE_INTEGER, error),
			ioBytes: count(usage.ioBytes, Number.MAX_SAFE_INTEGER, error),
		}),
	}) as never;
}
