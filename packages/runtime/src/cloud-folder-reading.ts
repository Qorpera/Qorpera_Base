import {
	COMPANY_STATE_FILE_MAX_BYTES,
	isCompanyStateName,
	osPath,
	parseCompanyStateFile,
	READING_CHANGES,
	READING_FOUNDERS,
	READING_LIMITS,
	READING_PATH,
	READING_SHAPES,
	type ReadingChange,
	type ReadingFile,
	type ReadingThing,
	writeReadingFile,
} from "@qorpera/cloud-client/company-state-files";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderUnit } from "./cloud-company-folder-client.ts";
import { type CloudCompanyPathControl, CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { invalidMessage } from "./cloud-folder-hiring.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * The company's reading of itself (lanes/company-reading-20261114; the founder, 14 November 2026: "It should feel like
 * the company is conscious almost"). Two pieces of the Co-Founder's company runs:
 *
 * - Its senses: the platform's plain facts about the whole company (`qorpera_describe_company_senses`, 20260930765000),
 *   read beside its open work and put in its context message as they are. A read that fails leaves `senses` null and
 *   the run goes on.
 * - `update_reading`: a thin writer of the one file, QorperaOS/vision/reading.md (deploy/first-node/
 *   RUNTIME-COMPANY-STATE-FILES.md §2 "reading"), modelled on hire_agent's writer (cloud-folder-hiring.ts). The file's
 *   own checks run with the arguments; what the parser cannot know (that each agent is an active agent's folder, that
 *   each member waited for is a member) is checked from the company before the receipt, and so is the team decision a
 *   move of attention owes: a save whose attention names another thing than the saved reading's needs `team`, the
 *   changes in the team or none with a reason, and the changes become the file's `changes`. Without a move `team` may
 *   be left out, and the saved changes stay while they are under seven days old. One unit, under the call's receipt,
 *   over the version read; saving the reading is plain, the company's bookkeeping, so it is never reviewed. Every check
 *   before the receipt still passes once the call's own save is in, so a replay of the same call reaches its receipt.
 */

const TOOL_VERSION = "folder-v2/1";
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The saved changes stay through a save that does not move attention while they are younger than this. */
const CHANGES_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** Why a team stays as it is, in characters. */
const NONE_REASON_CHARS = 280;
/** The senses' answer as the runtime takes it into the context, at most: SQL keeps it under 8 KiB. */
const SENSES_MAX_BYTES = 16 * 1024;

const FIELDS = ["operationKey", "sentence", "line", "attention", "things", "notes", "team"] as const;
const THING_FIELDS = ["key", "name", "shape", "full", "state", "agents", "waitsFor"] as const;
const CHANGE_FIELDS = ["agent", "what", "line"] as const;

/** The team decision a move of attention owes: the changes, or none with a reason. */
export type CloudReadingTeam = { readonly changes: readonly ReadingChange[] } | { readonly none: string };

export interface CloudReadingRequest {
	readonly operationKey: string;
	readonly sentence: string;
	readonly line: string | null;
	readonly attention: string;
	readonly things: readonly ReadingThing[];
	readonly notes: readonly string[];
	readonly team?: CloudReadingTeam;
}

/** The Co-Founder's senses for its context message: the read's answer as it is, checked to be of this run. */
export async function describeCloudCompanySenses(
	binding: CloudNativeToolBinding,
	control: CloudCompanyPathControl,
	signal: AbortSignal,
): Promise<JsonValue> {
	const admitted = parseCloudNativeToolBinding(binding);
	const result = (await cloudToolRequest(
		(requestSignal) => control.call("qorpera_describe_company_senses", { p_binding: admitted }, requestSignal),
		signal,
	)) as Record<string, unknown> | null;
	if (
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		result.schema !== "qorpera.company-senses/v1" ||
		result.runId !== admitted.runId ||
		Buffer.byteLength(JSON.stringify(result)) > SENSES_MAX_BYTES
	)
		throw new Error("Company senses differ");
	return result as JsonValue;
}

export const CLOUD_UPDATE_READING_DESCRIPTION = [
	`Save the company's reading of itself, ${READING_PATH}, whole: where the company stands now, in its own words, as we. Every agent gets it at every run, and the founders see it as the company's page.`,
	`sentence: one sentence a founder would nod at, at most ${READING_LIMITS.sentence} bytes. line: one short line under it, at most ${READING_LIMITS.line} bytes, or null. things: the ${READING_LIMITS.thingsMin} to ${READING_LIMITS.thingsMax} things the company cares about now, each with key (lowercase letters, digits and single hyphens, at most ${READING_LIMITS.key} bytes, each once), name (what a founder reads, at most ${READING_LIMITS.name} bytes), shape (its emblem: ${READING_SHAPES.join(", ")}), full (a whole number from 0 to 100: how far it is), state (a few words, at most ${READING_LIMITS.state} bytes), agents (up to ${READING_LIMITS.agents} active agents who attend to it, by their folder names under ${osPath("agents")}/) and waitsFor (up to ${READING_LIMITS.waitsFor} member ids from your context's senses, or ["${READING_FOUNDERS}"] alone). attention: the key of the one thing most of the company is on. notes: up to ${READING_LIMITS.notes} lines of at most ${READING_LIMITS.note} bytes (what we do not know, what we wait for).`,
	`team: when attention moves to another thing than the saved reading's, the team decision it owes, or the save is refused: the changes, up to ${READING_LIMITS.changes} of {agent (its folder name), what (${READING_CHANGES.join(", ")}), line (a few words a founder reads, at most ${READING_LIMITS.change} bytes)}, or {"none": "<why the team stays as it is>"}. The changes show on the company's page. Without a move, leave team out: the saved changes stay for seven days.`,
	"When the answer's outcome is saved, every agent's next run reads it. A conflict or a refusal needs a new operationKey.",
].join("\n");

const oneLine = (value: unknown): string | null =>
	typeof value === "string" && !/[\r\n\0]/.test(value) ? value.trim() : null;

const closed = (value: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal(`${what} must be an object`);
	const extra = Object.keys(value).find((key) => !keys.includes(key));
	if (extra) throw new CloudToolArgumentRefusal(`${what} takes ${keys.join(", ")}, not ${extra}`);
	return value as Record<string, unknown>;
};

const texts = (value: unknown, what: string): string[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new CloudToolArgumentRefusal(`${what} must be a list`);
	return value.map((item) => {
		const text = oneLine(item);
		if (text === null) throw new CloudToolArgumentRefusal(`each of ${what} is one line of text`);
		return text;
	});
};

/** The file a request saves, with the changes it is given. */
const readingOf = (request: CloudReadingRequest, changes: readonly ReadingChange[]): Omit<ReadingFile, "kind"> => ({
	sentence: request.sentence,
	line: request.line,
	attention: request.attention,
	things: request.things,
	changes,
	notes: request.notes,
});

/** The parser's problems with the file a request saves. */
function readingProblems(file: Omit<ReadingFile, "kind">): { message: string }[] {
	const parsed = parseCompanyStateFile(READING_PATH, writeReadingFile(file));
	if (!parsed) return [{ message: `${READING_PATH} is not a company state file` }];
	return parsed.ok ? [] : [...parsed.problems];
}

/** update_reading's arguments, with the file's own checks: everything that needs no read. */
export function parseCloudReadingArguments(value: JsonValue): CloudReadingRequest {
	const a = closed(value, FIELDS, "update_reading");
	if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
		throw new CloudToolArgumentRefusal(
			"operationKey must be 1 to 96 letters, digits, dots, colons, dashes or underscores",
		);
	const sentence = oneLine(a.sentence);
	const attention = oneLine(a.attention);
	const line = a.line === undefined || a.line === null ? null : oneLine(a.line);
	if (
		sentence === null ||
		attention === null ||
		line === "" ||
		(a.line !== undefined && a.line !== null && line === null)
	)
		throw new CloudToolArgumentRefusal("sentence and attention are one line of text each, and line one line or null");
	if (!Array.isArray(a.things)) throw new CloudToolArgumentRefusal("things must be a list of the company's things");
	const things = a.things.map((item): ReadingThing => {
		const thing = closed(item, THING_FIELDS, "each of things");
		const key = oneLine(thing.key);
		const name = oneLine(thing.name);
		const state = oneLine(thing.state);
		if (key === null || name === null || state === null || typeof thing.shape !== "string")
			throw new CloudToolArgumentRefusal("each of things has key, name, shape, full and state");
		if (typeof thing.full !== "number" || !Number.isSafeInteger(thing.full))
			throw new CloudToolArgumentRefusal("full is a whole number from 0 to 100");
		return {
			key,
			name,
			shape: thing.shape as ReadingThing["shape"],
			full: thing.full,
			state,
			agents: texts(thing.agents, "agents"),
			waitsFor: texts(thing.waitsFor, "waitsFor"),
		};
	});
	let team: CloudReadingTeam | undefined;
	if (Array.isArray(a.team)) {
		if (a.team.length < 1)
			throw new CloudToolArgumentRefusal('team lists the changes, or is {"none": "<why>"} when there are none');
		team = {
			changes: a.team.map((item): ReadingChange => {
				const change = closed(item, CHANGE_FIELDS, "each change of team");
				const agent = oneLine(change.agent);
				const said = oneLine(change.line);
				if (agent === null || said === null || !READING_CHANGES.includes(change.what as ReadingChange["what"]))
					throw new CloudToolArgumentRefusal(
						`each change of team has agent, what (${READING_CHANGES.join(", ")}) and line`,
					);
				return { agent, what: change.what as ReadingChange["what"], line: said };
			}),
		};
	} else if (a.team !== undefined) {
		const none = oneLine(closed(a.team, ["none"], "team").none);
		if (!none || [...none].length > NONE_REASON_CHARS)
			throw new CloudToolArgumentRefusal(
				`team's none is one line of why the team stays as it is, at most ${NONE_REASON_CHARS} characters`,
			);
		team = { none };
	}
	const request: CloudReadingRequest = {
		operationKey: a.operationKey,
		sentence,
		line,
		attention,
		things,
		notes: texts(a.notes, "notes"),
		...(team ? { team } : {}),
	};
	const problems = readingProblems(readingOf(request, team && "changes" in team ? team.changes : []));
	if (problems.length)
		throw new CloudToolArgumentRefusal(
			invalidMessage(problems, "This reading cannot be saved as the company's file"),
		);
	return request;
}

/** The company's reading as a file of the folder: its one writer. */
export class CloudFolderReading {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	/** The company's members, by user id (the Co-Founder's crew_and_members read). */
	readonly #members: (signal: AbortSignal) => Promise<ReadonlySet<string>>;
	readonly #now: () => number;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		members: (signal: AbortSignal) => Promise<ReadonlySet<string>>;
		now?: () => number;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#members = options.members;
		this.#now = options.now ?? Date.now;
	}

	async save(request: CloudReadingRequest, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		let found: Awaited<ReturnType<CloudCompanyFolderClient["readText"]>>;
		try {
			found = await this.#folder.readText(READING_PATH, COMPANY_STATE_FILE_MAX_BYTES, signal);
		} catch (error) {
			if (error instanceof CloudCompanyPathNotText)
				throw new CloudToolRefusal(
					`${READING_PATH} is not a text file of at most 64 KiB; replace it with company_write or company_delete first`,
				);
			throw error;
		}
		const parsed = found ? parseCompanyStateFile(READING_PATH, found.text) : null;
		// A saved file that does not read as a reading (a member's hand edit gone wrong) is replaced, and owes nothing.
		const saved = parsed?.ok && parsed.file.kind === "reading" ? parsed.file : null;
		const moved = saved !== null && saved.attention !== request.attention;
		if (moved && !request.team)
			throw new CloudToolRefusal(
				'attention moves to another thing than the saved reading\'s, and a move owes the team decision: call again with team, the changes in the team (agent, what: joined, ended or changed, line) or {"none": "<why the team stays as it is>"}',
			);
		const changes =
			request.team && "changes" in request.team
				? request.team.changes
				: saved && found && this.#now() - Date.parse(found.entry.updatedAt) < CHANGES_KEPT_MS
					? saved.changes
					: [];
		await this.#checkCompany(request, changes, signal);
		const file = readingOf(request, changes);
		const problems = readingProblems(file);
		if (problems.length)
			throw new CloudToolRefusal(invalidMessage(problems, "This reading cannot be saved as the company's file"));
		const unit: CloudCompanyFolderUnit = {
			op: "write",
			path: READING_PATH,
			content: { text: writeReadingFile(file), mediaType: "text/markdown" },
			...(found ? { expectedVersion: found.entry.version } : {}),
		};
		return this.#operations.execute({
			operation: {
				tool: "update_reading",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `reading:${request.operationKey}`,
				arguments: {
					sentence: request.sentence,
					line: request.line,
					attention: request.attention,
					things: request.things as unknown as JsonValue,
					notes: [...request.notes],
					...(request.team
						? {
								team:
									"changes" in request.team
										? (request.team.changes as unknown as JsonValue)
										: { none: request.team.none },
							}
						: {}),
				},
				target: { path: READING_PATH },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const committed = await this.#folder.commit(
					`reading-file:${request.operationKey}`,
					[unit],
					{ receiptId },
					performSignal,
				);
				const written = committed.units[0];
				if (!written || committed.units.length !== 1) throw new Error("Company folder commit answered other units");
				const output = cloudToolJsonText({
					schema: "qorpera.company-reading-receipt/v1",
					runId: this.#identity.runId,
					receiptId,
					outcome: written.outcome,
					...(written.reason ? { reason: written.reason } : {}),
					...(written.problems.length ? { problems: written.problems } : {}),
					path: READING_PATH,
					version: written.outcome === "saved" ? written.version : null,
					attention: request.attention,
					next:
						written.outcome === "saved"
							? "The reading is saved: every agent's next run reads it, and the founders see it on the company's page."
							: written.outcome === "conflict"
								? "The reading changed since it was read: read it again and call once more with a new operationKey."
								: "Nothing was saved: correct the reading and call again with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}

	/** What the parser cannot check: each agent of a thing is an active agent's folder, each agent of a change an agent's
	 * folder (an ended role is archived), and each member waited for a member of the company. */
	async #checkCompany(
		request: CloudReadingRequest,
		changes: readonly ReadingChange[],
		signal: AbortSignal,
	): Promise<void> {
		const attending = new Set(request.things.flatMap((thing) => thing.agents));
		const named = new Set([...attending, ...changes.map((change) => change.agent)]);
		const statuses = new Map<string, "active" | "archived" | null>();
		await Promise.all(
			[...named].map(async (handle) => {
				const path = osPath(`agents/${handle}/agent.md`);
				let status: "active" | "archived" | null = null;
				if (isCompanyStateName(handle)) {
					try {
						const read = await this.#folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
						const agent = read ? parseCompanyStateFile(path, read.text) : null;
						if (agent?.ok && agent.file.kind === "agent") status = agent.file.status;
					} catch (error) {
						if (!(error instanceof CloudCompanyPathNotText)) throw error;
					}
				}
				statuses.set(handle, status);
			}),
		);
		for (const handle of [...attending].sort())
			if (statuses.get(handle) !== "active")
				throw new CloudToolRefusal(
					`${handle} is not an active agent's folder under ${osPath("agents")}/: a thing's agents are the folder names of agents who work here now`,
				);
		for (const change of changes)
			if (!statuses.get(change.agent))
				throw new CloudToolRefusal(
					`${change.agent} is not an agent's folder under ${osPath("agents")}/: a change names the agent by its folder name`,
				);
		const waited = [...new Set(request.things.flatMap((thing) => thing.waitsFor))].filter((id) => UUID.test(id));
		if (!waited.length) return;
		const members = await this.#members(signal);
		const stranger = waited.find((id) => !members.has(id));
		if (stranger)
			throw new CloudToolRefusal(
				`${stranger} is not a member of the company: waitsFor takes member ids from your context's senses, or the word ${READING_FOUNDERS}`,
			);
	}
}

/** The company's members by user id, as the Co-Founder's crew read gives them (qorpera_cofounder_crew). */
export function cloudCompanyMembers(
	binding: CloudNativeToolBinding,
	control: CloudCompanyPathControl,
): (signal: AbortSignal) => Promise<ReadonlySet<string>> {
	const admitted = parseCloudNativeToolBinding(binding);
	return async (signal) => {
		const result = (await cloudToolRequest(
			(requestSignal) => control.call("qorpera_cofounder_crew", { p_binding: admitted }, requestSignal),
			signal,
		)) as Record<string, unknown> | null;
		if (
			!result ||
			result.schema !== "qorpera.cofounder-crew/v1" ||
			result.runId !== admitted.runId ||
			!Array.isArray(result.members)
		)
			throw new Error("Company members differ");
		return new Set(
			(result.members as Record<string, unknown>[])
				.map((member) => member.userId)
				.filter((id): id is string => typeof id === "string"),
		);
	};
}

/** `update_reading`, the Co-Founder's in its company runs (the runtime offers it to no other run). */
export function cloudReadingTool(identity: CloudNativeToolIdentity, writer: CloudFolderReading): CloudNativeTool {
	const expected = Object.freeze({ ...identity });
	// One request per operation key in this run: a key is bound to the first request that ran under it.
	const bound = new Map<string, string>();
	const rebinding = (request: CloudReadingRequest) => {
		const text = JSON.stringify(request);
		const previous = bound.get(request.operationKey);
		if (previous !== undefined && previous !== text)
			throw new CloudToolArgumentRefusal(
				"operationKey is already used in this run for a different reading, which may already be saved: repeat it only with identical arguments",
			);
		return text;
	};
	const shapeSchema = { type: "string", enum: [...READING_SHAPES] };
	return {
		name: "update_reading" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_UPDATE_READING_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["operationKey", "sentence", "attention", "things"],
			properties: {
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				sentence: { type: "string" },
				line: { type: ["string", "null"] },
				attention: { type: "string" },
				things: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["key", "name", "shape", "full", "state"],
						properties: {
							key: { type: "string" },
							name: { type: "string" },
							shape: shapeSchema,
							full: { type: "integer" },
							state: { type: "string" },
							agents: { type: "array", items: { type: "string" } },
							waitsFor: { type: "array", items: { type: "string" } },
						},
					},
				},
				notes: { type: "array", items: { type: "string" } },
				team: {
					anyOf: [
						{
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["agent", "what", "line"],
								properties: {
									agent: { type: "string" },
									what: { type: "string", enum: [...READING_CHANGES] },
									line: { type: "string" },
								},
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["none"],
							properties: { none: { type: "string" } },
						},
					],
				},
			},
		},
		parseArguments(value) {
			const request = parseCloudReadingArguments(value);
			rebinding(request);
			return request as unknown as JsonValue;
		},
		async execute(value, context) {
			if (
				context.runId !== expected.runId ||
				context.companyId !== expected.companyId ||
				!context.identity ||
				Object.entries(expected).some(
					([key, item]) => context.identity![key as keyof CloudNativeToolIdentity] !== item,
				)
			)
				throw new Error("Reading tool identity differs");
			context.signal.throwIfAborted();
			const request = value as unknown as CloudReadingRequest;
			const text = rebinding(request);
			// Bound before it runs, so reusing the key with other arguments is refused, not retried.
			if (!bound.has(request.operationKey)) bound.set(request.operationKey, text);
			return writer.save(request, context);
		},
	};
}
