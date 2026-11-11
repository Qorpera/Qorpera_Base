import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { parseCloudCodingRepository } from "@qorpera/contracts";
import type {
	CloudCompanyCodeDescribed,
	CloudCompanyCodeRefusal,
	CloudCompanyCodeRequest,
	CloudCompanyCodeUndo,
	CloudCompanyFolderClient,
} from "./cloud-company-folder-client.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * `manage_code` (own code storage, step 2b; migration 20260930720000): what an agent does about the changes in the
 * company's code kept in Qorpera. Every change that goes into a repository's main code is a numbered row with a record
 * file, code/<owner>/<name>/changes/<n>.md.
 *
 * - undo: asks for one change to be taken out of main (`qorpera_folder_request_code_undo`), which adds a request the
 *   coding executor picks up within seconds. The tool then looks at the request every 2 s for at most 30 s
 *   (`qorpera_folder_code_request`) and says in words how it went. A request still open after that is said so: the same
 *   call again finds it and goes on waiting.
 * - describe: says what a customer will notice of a change, or gives a picture of it
 *   (`qorpera_folder_describe_code_change`).
 *
 * Both are run effects under the run's own receipt, keyed by the operation key. An agent's own company run has the
 * tool, never a worker's. Neither action is reviewed (`cloudActionEffect`): an undo puts main back to a state it had,
 * as a recorded change that can itself be undone.
 *
 * What SQL refused before anything was asked is the tool's refusal (the model reads `REFUSED:` and why). Once a request
 * is the executor's, the tool only answers: what the code host then refused is an answer too, since it names files of
 * the repository, which are the repository's own bytes.
 */

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ACTIONS = ["undo", "describe"] as const;
const KEYS = {
	undo: ["action", "operationKey", "owner", "name", "change", "andLater", "reason", "notice"],
	describe: ["action", "operationKey", "owner", "name", "change", "notice", "picture"],
} as const;
/** How often an undo's request is looked at, and for how long: the executor claims requests every 5 s, and an undo's job
 * is a handful of git commands. */
const UNDO_LOOK_MS = 2000;
const UNDO_WAIT_MS = 30_000;
/** The files of a refused undo one answer names; the rest are counted. */
const SHOWN_PATHS = 10;
const SHOWN_PATH_BYTES = 2000;

export const CLOUD_CODE_TOOL_DESCRIPTION =
	"Look after the company's code kept in Qorpera. Qorpera numbers every change that goes into a repository's main code and writes its record at code/<owner>/<name>/changes/<number>.md. " +
	"Actions: undo, describe. Both need operationKey, owner, name and change (the number). " +
	"undo puts main back as it was without that change, as a new change of its own: nothing is lost, and an undo can be undone. Give reason in one line, and notice when customers will see the undo. When later changes built on it, nothing happens and you are told the files: then undo with andLater true, which takes out that change and every change after it, or send the session a follow-up. After an undo, check main before you tell anyone. " +
	"describe sets the change's notice (one plain sentence on what a customer will notice) and picture (a .png, .jpg, .jpeg or .webp file of at most 4 MB that shows it, in a part of the company folder everyone can read). What you leave out stays as it is. " +
	"After a result you did not see, call again with the same operationKey. Change numbers are yours, never the members' words.";

interface CodeUndo {
	readonly action: "undo";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly change: number;
	readonly andLater: boolean;
	readonly reason: string;
	readonly notice?: string;
}
interface CodeDescribe {
	readonly action: "describe";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly change: number;
	readonly notice?: string;
	readonly picture?: string;
}

/** One line of text within its bound, trimmed; an empty one is one left out. */
function line(value: unknown, field: string, characters: number): string | undefined {
	const text = typeof value === "string" ? value.trim() : value;
	if (text === undefined || text === "") return undefined;
	if (
		typeof text !== "string" ||
		Array.from(text).length > characters ||
		/[\u0000-\u001f\u007f]/.test(text) ||
		Buffer.from(text).toString("utf8") !== text
	)
		throw new CloudToolArgumentRefusal(`${field} is one line of at most ${characters} characters`);
	return text;
}

function parse(value: unknown): CodeUndo | CodeDescribe {
	const a = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const action = ACTIONS.find((known) => known === a.action);
	if (action === undefined) throw new CloudToolArgumentRefusal("action is undo or describe");
	if (Object.keys(a).some((key) => !(KEYS[action] as readonly string[]).includes(key)))
		throw new CloudToolArgumentRefusal(`${action} takes only ${KEYS[action].join(", ")}`);
	if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
		throw new CloudToolArgumentRefusal(
			"operationKey is 1 to 96 letters, digits, dots, colons, hyphens and underscores, and starts with a letter or digit",
		);
	try {
		// The repository's folder, code/<owner>/<name>/, by the rule its coding sessions were started under.
		parseCloudCodingRepository({ host: "qorpera", owner: a.owner, name: a.name, baseBranch: "main" });
	} catch {
		throw new CloudToolArgumentRefusal(
			"owner and name are the repository's, as in code/<owner>/<name>/: lowercase, such as owner company and name shop",
		);
	}
	if (!Number.isSafeInteger(a.change) || (a.change as number) < 1 || (a.change as number) > 999_999_999)
		throw new CloudToolArgumentRefusal(
			"change is the change's number, a whole number from 1: changes/index.md in the repository's folder lists them",
		);
	const shared = {
		operationKey: a.operationKey,
		owner: a.owner as string,
		name: a.name as string,
		change: a.change as number,
	};
	const notice = line(a.notice, "notice", 200);
	if (action === "undo") {
		const reason = line(a.reason, "reason", 500);
		if (reason === undefined || Buffer.byteLength(reason) > 500)
			throw new CloudToolArgumentRefusal(
				"undo needs reason: why the change is taken out, in one line of at most 500 bytes",
			);
		if (a.andLater !== undefined && typeof a.andLater !== "boolean")
			throw new CloudToolArgumentRefusal("andLater is true or false");
		return { action, ...shared, andLater: a.andLater === true, reason, ...(notice === undefined ? {} : { notice }) };
	}
	let picture: string | undefined;
	if (a.picture !== undefined && a.picture !== "") {
		try {
			picture = parseCloudCompanyPath(a.picture);
		} catch {
			picture = undefined;
		}
		if (picture === undefined || Buffer.byteLength(picture) > 1024 || !/\.(png|jpe?g|webp)$/i.test(picture))
			throw new CloudToolArgumentRefusal(
				"picture is the company path of a .png, .jpg, .jpeg or .webp file, such as product/screens/new-price.png: not a machine path, and at most 1024 bytes",
			);
	}
	if (notice === undefined && picture === undefined)
		throw new CloudToolArgumentRefusal("describe needs notice, picture or both");
	return {
		action,
		...shared,
		...(notice === undefined ? {} : { notice }),
		...(picture === undefined ? {} : { picture }),
	};
}

/** The files a refusal named, as an answer shows them: each quoted as JSON, so a name can pass for no words of the
 * answer, the first few only, and the rest counted. */
function inFiles(paths: readonly string[] | null): string {
	const all = paths ?? [];
	const shown: string[] = [];
	let bytes = 0;
	for (const path of all) {
		const quoted = JSON.stringify(path);
		bytes += Buffer.byteLength(quoted);
		if (shown.length === SHOWN_PATHS || bytes > SHOWN_PATH_BYTES) break;
		shown.push(quoted);
	}
	if (!shown.length) return all.length ? `, in ${all.length} ${all.length === 1 ? "file" : "files"}` : "";
	return `, in ${shown.join(", ")}${all.length > shown.length ? ` and ${all.length - shown.length} more` : ""}`;
}

/** The code of a failure or of a refusal with no words of its own, for whoever looks into it. */
function codeMark(code: string | null): string {
	return code !== null && /^[A-Z][A-Z0-9_:]{0,119}$/.test(code) ? ` [code=${code}]` : "";
}

/** Why SQL raised instead of taking the call: nothing was asked and nothing was saved. */
function raised(reason: CloudCompanyCodeRefusal, request: CodeUndo | CodeDescribe): string {
	switch (reason) {
		case "no_change":
			return `There is no change ${request.change} in ${request.owner}/${request.name}: code/${request.owner}/${request.name}/changes/index.md lists its changes.`;
		case "invalid":
			return "The request was not taken as written: check owner, name, change and the texts, and call again.";
		case "key_reused":
			return "That operationKey was used for a different request: use a new one.";
		case "authority":
			return "Only an agent's own run looks after the company's code, never a worker's.";
		case "acknowledgement":
			return "This conversation needs your first reply before any work: answer the member, then call again.";
		case "final":
			return "This run already sent its final reply, so it starts no more work.";
		case "paused":
			return "The company's work is paused, so nothing can be changed now.";
	}
}

/** Why no undo was asked for, in words the agent can pass on. */
function undoRefused(reason: Extract<CloudCompanyCodeUndo, { state: "refused" }>["reason"], request: CodeUndo): string {
	const n = request.change;
	const followUp = "send the session a follow-up that puts the old behaviour back";
	switch (reason) {
		case "never_landed":
			return `Change ${n} never went into main, so there is nothing to undo.`;
		case "lost":
			return `Change ${n} is no longer in the repository: a restore went back past it, so there is nothing to undo.`;
		case "restore":
			return `Change ${n} put the repository back from its copy, and that cannot be undone.`;
		case "wall":
			return request.andLater
				? `Nothing was undone: the repository was put back from its copy after change ${n}, and andLater does not reach back past that. Undo change ${n} alone, or ${followUp}.`
				: `Change ${n} cannot be undone: the record does not hold main as it was before it. Instead, ${followUp}.`;
		case "too_many":
			return `Nothing was undone: that would take out more than 500 changes at once. Instead, ${followUp}.`;
		// The answer is kept under the call's operation key, so a later try needs a new one. The other undo may be of this
		// very change with the other scope (alone, where this call says andLater, or the other way round): the kernel
		// hands a call the open request only when it is the same undo, so what this call reports is what it asked for.
		case "busy":
			return `Nothing was undone: another undo, or a restore, is being made in ${request.owner}/${request.name}. Call again with a new operationKey when it is done.`;
		case "no_executor":
			return "Nothing was undone: Qorpera's code service is not running for this company right now. Try again in a few minutes, with a new operationKey.";
		default:
			return raised(reason, request);
	}
}

/** How an undo's request ended, in words the agent can pass on. */
function undoEnded(request: CodeUndo, ended: CloudCompanyCodeRequest): string {
	const n = request.change;
	const folder = `code/${request.owner}/${request.name}`;
	const nothing = `Nothing was undone: main no longer holds what change ${n} did.`;
	const followUp = "send the session a follow-up that puts the old behaviour back";
	if (ended.state === "done" && ended.result === "undone") {
		// The undo is a change of its own, numbered after the changes it took out.
		const made =
			ended.change === null ? "" : ` This is change ${ended.change}: ${folder}/changes/${ended.change}.md.`;
		const last = ended.change === null ? n : ended.change - 1;
		return `${
			request.andLater && last > n
				? `Changes ${n} to ${last} are undone. Main is as it was before change ${n}.`
				: `Change ${n} is undone. Main is as it was without it.`
		}${made} Check ${folder}/main/ before you tell anyone.`;
	}
	if (ended.state === "done" && ended.result === "nothing") return nothing;
	// This request's answer is kept under its operation key: another try, or the same undo with andLater, needs a new one.
	if (ended.state === "refused") {
		const code = ended.code ?? "";
		if (code === "CODE_HOST_UNDO_CONFLICT" && !request.andLater)
			return `Nothing was undone: later changes built on change ${n}${inFiles(ended.paths)}. Undo with andLater true and a new operationKey to take out change ${n} and every change after it, or ${followUp}.`;
		// The change's commits are not in main, or not in the repository any more.
		if (code === "CODE_HOST_UNDO_NOT_IN_MAIN" || code === "CODE_HOST_UNDO_UNKNOWN_COMMIT") return nothing;
		if (code.startsWith("CODE_HOST_NAMES_"))
			return `Nothing was undone: the files it would put back have names a repository kept in Qorpera does not take${inFiles(ended.paths)}. Instead, ${followUp}.`;
		return `Nothing was undone. Look at ${folder}/changes/index.md before you try again, with a new operationKey.${codeMark(ended.code)}`;
	}
	return `The undo did not finish. Look at ${folder}/changes/index.md before you try again, with a new operationKey.${codeMark(ended.code)}`;
}

/** Why a change's description was not saved. */
function describeRefused(
	reason: Extract<CloudCompanyCodeDescribed, { state: "refused" }>["reason"],
	request: CodeDescribe,
): string {
	switch (reason) {
		case "missing":
			return "Nothing was saved: there is no file at the picture's path in the company folder.";
		case "not_a_file":
			return "Nothing was saved: the picture's path is a folder, not a file.";
		case "too_large":
			return "Nothing was saved: the picture is larger than 4 MB. Give a smaller one.";
		case "not_a_picture":
			return "Nothing was saved: the picture's name must end in .png, .jpg, .jpeg or .webp.";
		case "not_shared":
			return "Nothing was saved: the picture must be in a part of the company folder every member and agent can read, not in a private folder.";
		default:
			return raised(reason, request);
	}
}

/** The company's code kept in Qorpera, for an agent's own company run: `manage_code`. */
export function cloudCodeTools(options: {
	folder: Pick<CloudCompanyFolderClient, "requestCodeUndo" | "codeRequest" | "describeCodeChange">;
	identity: CloudNativeToolIdentity;
	/** The pause between looks at an undo's request and how long the tool waits for it, when not 2 s and 30 s. */
	lookMs?: number;
	waitMs?: number;
}): readonly CloudNativeTool[] {
	const { folder } = options;
	const expected = Object.freeze({ ...options.identity });
	const lookMs = options.lookMs ?? UNDO_LOOK_MS;
	const waitMs = options.waitMs ?? UNDO_WAIT_MS;
	const said = (value: string): CloudToolContent => ({ kind: "text", value });

	const undo = async (request: CodeUndo, signal: AbortSignal): Promise<CloudToolContent> => {
		const { action: _action, ...asked } = request;
		const answer = await folder.requestCodeUndo(asked, signal);
		if (answer.state === "already")
			return said(`Change ${request.change} is already undone, by change ${answer.undoneBy}.`);
		if (answer.state === "refused") throw new CloudToolRefusal(undoRefused(answer.reason, request));
		// The request is the executor's now. From here the tool only looks and says what it saw: a look that fails is
		// only a failed look, and the next one comes after the pause.
		const until = Date.now() + waitMs;
		for (let left = waitMs; left > 0; left = until - Date.now()) {
			await cloudControlPause(Math.min(lookMs, left), signal);
			let now: CloudCompanyCodeRequest | undefined;
			try {
				now = await folder.codeRequest(answer.requestId, signal);
			} catch {
				signal.throwIfAborted();
			}
			if (now && now.kind !== "undo") throw new Error("Code request differs");
			if (now && now.state !== "queued" && now.state !== "running") return said(undoEnded(request, now));
		}
		return said(
			`The undo of change ${request.change} is still being made. Call manage_code undo for it again to see how it went.`,
		);
	};

	const describe = async (request: CodeDescribe, signal: AbortSignal): Promise<CloudToolContent> => {
		const { action: _action, ...asked } = request;
		const answer = await folder.describeCodeChange(asked, signal);
		if (answer.state === "refused") throw new CloudToolRefusal(describeRefused(answer.reason, request));
		return said(
			`Saved: change ${request.change} has ${answer.notice === null ? "no notice yet" : "its notice"} and ${answer.picture ? "its picture" : "no picture yet"}. Its record, code/${request.owner}/${request.name}/changes/${request.change}.md, shows that within a minute.`,
		);
	};

	const code: CloudNativeTool = {
		name: "manage_code" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_CODE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action", "operationKey", "owner", "name", "change"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				owner: { type: "string", minLength: 1, maxLength: 39 },
				name: { type: "string", minLength: 1, maxLength: 100 },
				change: { type: "integer", minimum: 1 },
				andLater: { type: "boolean" },
				reason: { type: "string", minLength: 1, maxLength: 500 },
				notice: { type: "string", minLength: 1, maxLength: 200 },
				picture: {
					type: "string",
					minLength: 1,
					maxLength: 1024,
					description: "Its path in the company folder, such as product/screens/new-price.png.",
				},
			},
		},
		parseArguments: (value) => parse(value) as never,
		// An undo the code host refused, or one that found nothing to take out, changed nothing: main was not as an undo
		// of that change needs it.
		refused: (content) =>
			content.kind === "text" && content.value.startsWith("Nothing was undone") ? "stale_version" : undefined,
		async execute(value, context) {
			if (
				context.runId !== expected.runId ||
				context.companyId !== expected.companyId ||
				!context.identity ||
				Object.entries(expected).some(
					([name, held]) => context.identity![name as keyof CloudNativeToolIdentity] !== held,
				)
			)
				throw new Error("Code tool identity differs");
			context.signal.throwIfAborted();
			const request = value as unknown as CodeUndo | CodeDescribe;
			return request.action === "undo" ? undo(request, context.signal) : describe(request, context.signal);
		},
	};
	return [code];
}
