import {
	EMPTY_WALL,
	parseWall,
	renderWall,
	type Wall,
	WALL_DONE_MAX,
	WALL_ITEM_MAX_CHARS,
	WALL_MAX_BYTES,
	WALL_WAITING_MAX,
	WALL_WORKING_MAX,
	type WallDone,
	wallItemProblem,
	wallItemText,
	wallPath,
} from "@qorpera/cloud-client/agent-wall";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderFileEntry,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { args, cloudFolderRefusal, released, TOOL_VERSION, unavailable } from "./cloud-folder-file-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * `update_wall`: the agent keeps its wall, `QorperaOS/agents/<handle>/wall.md` (packages/cloud-client/src/agent-wall.ts;
 * Jonas, 5 November 2026), which the web pins above its thread. One call sets what waits on a member and what the
 * agent is working on (each a whole list, or null to keep it) and adds what it finished, dated today; the oldest done
 * items past the wall's limit drop off. The file is rewritten whole in the kept form under the call's receipt, against
 * the version read, so a wall that changed in between is refused and the agent calls again. The same wall again saves
 * nothing. It applies at once (review class internal): the wall is the agent's own report.
 */

interface WallRequest {
	readonly waiting: readonly string[] | null;
	readonly working: readonly string[] | null;
	readonly done: readonly string[];
}

const SCHEMA = "qorpera.agent-wall/v1";

function items(value: JsonValue | undefined, label: string, max: number, nullable: boolean): string[] | null {
	if (value === null && nullable) return null;
	if (!Array.isArray(value) || value.length > max)
		throw new CloudToolArgumentRefusal(
			`${label} must be a list of at most ${max} items${nullable ? ", or null to keep it as it is" : ""}`,
		);
	return value.map((item) => {
		if (typeof item !== "string") throw new CloudToolArgumentRefusal(`each item of ${label} is one line of text`);
		const problem = wallItemProblem(item);
		if (problem) throw new CloudToolArgumentRefusal(`${label}: ${problem}`);
		return wallItemText(item);
	});
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The wall after a request on `today` (`YYYY-MM-DD`): a finished item already on the wall since its last week is not
 * added again, so a retried call does not repeat it. */
export function nextWall(stored: Wall, request: WallRequest, today: string): Wall {
	const recent = stored.done.filter((item) => item.day >= dayBefore(today, 7));
	const added: WallDone[] = [];
	for (const text of request.done)
		if (!recent.some((item) => same(item.text, text)) && !added.some((item) => same(item.text, text)))
			added.push({ day: today, text });
	const done = [...added, ...stored.done]
		.map((item, index) => ({ item, index }))
		.sort((a, b) => (a.item.day === b.item.day ? a.index - b.index : a.item.day < b.item.day ? 1 : -1))
		.map(({ item }) => item)
		.slice(0, WALL_DONE_MAX);
	return { waiting: request.waiting ?? stored.waiting, working: request.working ?? stored.working, done };
}

function dayBefore(day: string, days: number): string {
	const date = new Date(`${day}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

export const CLOUD_WALL_TOOL_DESCRIPTION = `Keep your wall: the card pinned above your thread where members see at a glance what you have done, what you are working on and what waits on them. It replaces status messages: update it instead of writing to say that work started, moved on or finished. waiting: what you need from a member, each a short line that says what to decide or do (a whole list, or null to keep it; at most ${WALL_WAITING_MAX}). working: what you are doing now (a whole list, or null to keep it; at most ${WALL_WORKING_MAX}). done: what you finished since the last update, added on top with today's date ([] for nothing new). Each item is one plain line of at most ${WALL_ITEM_MAX_CHARS} characters, in the company's language and your messages' plain words, with a link to the work: [Name](folder:path/in/the/company/file) or [Title](app:<name>) for an interface app. Move an item, don't repeat it: what you finish leaves working (or waiting) and goes to done in the same call. Fix a wrong item where it stands. It applies at once. When the result says the wall changed since it was read, call again.`;

/** The wall tool of a folder-v2 run, for the agent whose folder is `handle`. */
export function cloudWallTools(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
	handle: string;
	/** Today, `YYYY-MM-DD`; tests set it. */
	today?: () => string;
}): CloudNativeTool[] {
	const { folder, operations, identity } = options;
	const path = wallPath(options.handle);
	const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
	const tool: CloudNativeTool = {
		name: "update_wall" satisfies CloudRuntimeToolOperation,
		source: "company_file",
		description: CLOUD_WALL_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["waiting", "working", "done"],
			properties: {
				waiting: {
					type: ["array", "null"],
					maxItems: WALL_WAITING_MAX,
					items: { type: "string", maxLength: WALL_ITEM_MAX_CHARS * 4 },
				},
				working: {
					type: ["array", "null"],
					maxItems: WALL_WORKING_MAX,
					items: { type: "string", maxLength: WALL_ITEM_MAX_CHARS * 4 },
				},
				done: { type: "array", maxItems: 12, items: { type: "string", maxLength: WALL_ITEM_MAX_CHARS * 4 } },
			},
		},
		parseArguments(value) {
			const input = args(value, "update_wall", ["waiting", "working", "done"]);
			const request: WallRequest = {
				waiting: items(input.waiting, "waiting", WALL_WAITING_MAX, true),
				working: items(input.working, "working", WALL_WORKING_MAX, true),
				done: items(input.done, "done", 12, false) ?? [],
			};
			return request as unknown as JsonValue;
		},
		refused: cloudFolderRefusal,
		async execute(value, context) {
			const request = value as unknown as WallRequest;
			if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
			let found: { entry: CloudCompanyFolderFileEntry; text: string } | null;
			try {
				found = await folder.readText(path, WALL_MAX_BYTES, context.signal);
			} catch (error) {
				if (error instanceof CloudCompanyPathNotText)
					throw new CloudToolRefusal(
						`WALL_UNREADABLE: ${path} is not a text file of at most ${WALL_MAX_BYTES / 1024} KiB; nothing was written`,
					);
				return unavailable(error, "read");
			}
			// A wall someone wrote out of shape is kept in shape from what reads.
			const stored = found ? parseWall(found.text).wall : EMPTY_WALL;
			const next = nextWall(stored, request, today());
			const text = renderWall(next);
			const answer = (saved: boolean, wall: Wall, extra: Record<string, unknown> = {}) =>
				cloudToolJsonText({ schema: SCHEMA, path, saved, ...extra, wall: wall as unknown as JsonValue });
			const reads = found ? [cloudCompanyFolderRelease(found.entry)] : [];
			if (found?.text === text)
				return released(
					folder,
					identity.runId,
					context,
					answer(false, stored, { note: "Already so: nothing changed" }),
					reads,
				);
			const content = await operations.execute({
				operation: {
					tool: "update_wall",
					toolVersion: TOOL_VERSION,
					logicalOperationKey: `wall:${context.callId}`,
					arguments: request as unknown as Record<string, JsonValue>,
					target: { path },
					requiresCompanyRevision: true,
				},
				// The folder core decides at the commit, under this call's receipt.
				authorize: async () => {},
				refused: cloudFolderRefusal,
				perform: async (_operation, { receiptId, signal }) => {
					const committed = await folder.commit(
						`wall-file:${receiptId}`,
						[
							{
								op: "write",
								path,
								content: { text, mediaType: "text/markdown" },
								...(found ? { expectedVersion: found.entry.version } : {}),
							},
						],
						{ receiptId },
						signal,
					);
					const written = committed.units[0];
					if (!written) throw new Error("Company folder commit answered no unit");
					const shown =
						written.outcome === "saved"
							? answer(true, next)
							: answer(false, stored, {
									outcome: "not_applied",
									reason: written.reason ?? written.outcome,
									refused:
										written.outcome === "conflict"
											? "The wall changed since it was read; nothing changed: call again"
											: written.problems.length
												? written.problems.map((problem) => problem.message).join("; ")
												: `Not saved (${written.reason ?? written.outcome})`,
								});
					return { content: { kind: "text", value: shown }, folderCommitId: committed.commitId };
				},
				signal: context.signal,
				...(context.observation ? { observation: context.observation } : {}),
			});
			if (content.kind !== "text") throw new Error("A wall change answered no text");
			// After the receipt the change is made or settled, so an answer that cannot be released is unconfirmed, never
			// a refusal (which says nothing happened): the replay of the same call answers.
			return released(folder, identity.runId, context, content.value, reads).catch((error) => {
				if (error instanceof CloudToolRefusal)
					throw new Error("A committed answer could not be released", { cause: error });
				throw error;
			});
		},
	};
	return [tool];
}
