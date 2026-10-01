import { createHash } from "node:crypto";
import {
	COMPANY_STATE_FILE_MAX_BYTES,
	newCompanyStateId,
	parseCompanyStateFile,
	setCompanyStateSettings,
	type TodoFile,
	writeTodoFile,
} from "@qorpera/cloud-client/company-state-files";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderFileEntry,
	type CloudCompanyFolderRelease,
	type CloudCompanyFolderUnit,
	sha256,
} from "./cloud-company-folder-client.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

/*
 * `manage_todo` as a thin writer of a folder-v2 agent's todo files (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
 * §2 "todo", §5): `agents/<handle>/todos/<todoKey>.md`, whose name is the todo's key. The folder core's commit decides
 * every save (F2-5a's rules: a closed todo is not opened again, done is refused while a worker is at work), under the
 * tool call's receipt, so the change is exactly once and the index follows the file.
 *
 * A call reads the file first, outside the receipt, and refuses what can never succeed. Every such check still passes
 * once the call's own change is saved, so a replay of the same call reaches its receipt and returns the stored result.
 * The receipt binds the model's request, not the version read: the commit carries that version, and a file changed in
 * between is a `conflict`, which the model redoes under a new operation key.
 */

/** A todo's file name is its key (§1 "Names"). */
const TODO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TODO_NAME_BYTES = 64;
const TOOL_VERSION = "folder-v2/1";

/** At most this many todos a page, as the kernel's pages had. */
const PAGE_TODOS = 32;
/** A listed todo shows the start of its detail; naming its todoKey shows all of it. */
const DETAIL_PREVIEW = 280;
/** More todo files than this in one agent's folder is not a listing this tool reads. */
const MAX_TODO_FILES = 10_000;

export interface CloudFolderTodoListing {
	readonly includeClosed?: boolean;
	readonly todoKey?: string;
	readonly state?: TodoFile["status"];
	readonly search?: string;
	/** The version of the last todo an earlier page showed. */
	readonly cursor?: string;
}

/** One release id per tool call: a replay of the same call releases the same reads under it. */
function releaseIdFor(runId: string, callId: string): string {
	const hex = createHash("sha256").update(`qorpera.todo-release/v1:${runId}:${callId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CloudFolderTodoChange {
	readonly action: "upsert" | "done" | "cancel";
	readonly operationKey: string;
	readonly todoKey: string;
	readonly title?: string;
	readonly detail?: string;
	readonly state?: "open" | "blocked";
}

interface CurrentTodo {
	readonly entry: CloudCompanyFolderFileEntry;
	readonly text: string;
	readonly todo: TodoFile;
}

const closed = (status: TodoFile["status"]) => status === "done" || status === "cancelled";

/** The run agent's todos as files. `handle` is the agent's folder name from the run context. */
export class CloudFolderTodos {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	readonly #todos: string;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		handle: string;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#todos = `agents/${options.handle}/todos`;
	}

	/** The path of a todo, or a refusal the model can act on. */
	path(todoKey: string): string {
		if (!TODO_NAME.test(todoKey) || Buffer.byteLength(todoKey) > TODO_NAME_BYTES)
			throw new CloudToolArgumentRefusal(
				"In this company a todoKey is the todo's file name: lowercase letters, digits and single hyphens, at most 64 characters",
			);
		return `${this.#todos}/${todoKey}.md`;
	}

	/**
	 * The agent's todos from their files, newest first, as many as fit one result (`fits`). Each shown todo's read is
	 * released with the result. Open and blocked by default; `state` or `includeClosed` widen it; `search` matches a
	 * title or a key in any case; `todoKey` shows one todo's whole detail. A page continues after the todo whose version
	 * is the cursor; `moreTodos` counts the files after the last one shown, so a last page may come back empty.
	 */
	async list(
		request: CloudFolderTodoListing,
		context: CloudToolContext,
		fits: (text: string) => boolean,
	): Promise<CloudToolContent> {
		const signal = context.signal;
		type Shown = Record<string, unknown> & { read: CloudCompanyFolderRelease; position: number };
		const shownOf = (
			entry: CloudCompanyFolderFileEntry,
			todoKey: string,
			todo: TodoFile,
			whole: boolean,
			position: number,
		): Shown => ({
			todoKey,
			title: todo.title,
			state: todo.status,
			detail:
				whole || todo.detail.length <= DETAIL_PREVIEW ? todo.detail : `${todo.detail.slice(0, DETAIL_PREVIEW)}…`,
			path: entry.path,
			version: entry.version,
			updatedAt: entry.updatedAt,
			read: {
				path: entry.path,
				version: entry.version,
				authority: entry.authority,
				fileSha256: entry.file.fileSha256,
			},
			position,
		});
		const todoOf = (path: string, text: string) => {
			const parsed = parseCompanyStateFile(path, text);
			return parsed?.ok && parsed.file.kind === "todo" ? parsed.file : null;
		};
		let items: Shown[] = [];
		let files = 0;
		if (request.todoKey !== undefined) {
			const path = this.path(request.todoKey);
			const found = await this.#folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
			const todo = found ? todoOf(path, found.text) : null;
			if (found && todo) items = [shownOf(found.entry, request.todoKey, todo, true, 0)];
			files = items.length;
		} else if ((await this.#folder.read(this.#todos, signal)).entry) {
			const listed = (await this.#folder.listAll(this.#todos, { maxEntries: MAX_TODO_FILES }, signal)).entries
				.filter(
					(entry): entry is CloudCompanyFolderFileEntry => entry.kind === "file" && entry.path.endsWith(".md"),
				)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
			files = listed.length;
			let start = 0;
			if (request.cursor !== undefined) {
				start = listed.findIndex((entry) => entry.version === request.cursor) + 1;
				if (start === 0)
					throw new CloudToolArgumentRefusal("That cursor is no longer a todo's version; list again without it");
			}
			const search = request.search?.toLowerCase();
			for (let position = start; position < listed.length && items.length < PAGE_TODOS; position++) {
				const entry = listed[position];
				if (!entry) continue;
				const todoKey = entry.path.slice(this.#todos.length + 1, -3);
				const found = await this.#folder.readText(entry.path, COMPANY_STATE_FILE_MAX_BYTES, signal);
				const todo = found ? todoOf(entry.path, found.text) : null;
				if (!found || !todo) continue;
				if (request.state ? todo.status !== request.state : !request.includeClosed && closed(todo.status)) continue;
				if (search && !todo.title.toLowerCase().includes(search) && !todoKey.includes(search)) continue;
				items.push(shownOf(found.entry, todoKey, todo, false, position));
			}
		}
		const render = (count: number) => {
			const shown = items.slice(0, count);
			const last = shown.at(-1);
			const more = request.todoKey !== undefined || !last ? 0 : files - (last.position + 1);
			return cloudToolJsonText({
				schema: "qorpera.agent-todos/v1",
				runId: this.#identity.runId,
				todos: shown.map(({ read: _read, position: _position, ...item }) => item),
				moreTodos: more,
				nextCursor: more > 0 && last ? last.version : null,
			});
		};
		// Grown from one todo, so a wide page is never rendered whole.
		let count = Math.min(items.length, 1);
		while (count < items.length && fits(render(count + 1))) count++;
		const output = render(count);
		if (count > 0)
			await this.#folder.release(
				releaseIdFor(this.#identity.runId, context.callId),
				items.slice(0, count).map((item) => item.read),
				sha256(new TextEncoder().encode(output)),
				signal,
			);
		return { kind: "text", value: output };
	}

	async change(request: CloudFolderTodoChange, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		const path = this.path(request.todoKey);
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const found = await this.#folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
		let current: CurrentTodo | null = null;
		if (found) {
			const parsed = parseCompanyStateFile(path, found.text);
			if (!parsed?.ok || parsed.file.kind !== "todo")
				throw new CloudToolArgumentRefusal(
					"That todo's file does not read as a todo; correct it with the file tools first",
				);
			current = { entry: found.entry, text: found.text, todo: parsed.file };
		}
		let text: string;
		let todo: Omit<TodoFile, "kind" | "id" | "requestedBy">;
		if (request.action === "upsert") {
			if (current && closed(current.todo.status))
				throw new CloudToolArgumentRefusal(
					"That todo is closed, and a closed todo is not opened again: upsert it under a new todoKey",
				);
			todo = { title: request.title ?? "", status: request.state ?? "open", detail: request.detail ?? "" };
			text = writeTodoFile({
				id: current?.todo.id ?? newCompanyStateId(),
				// A new todo is asked for by the run's requester; an existing one keeps whoever asked.
				requestedBy: current ? current.todo.requestedBy : this.#identity.requesterUserId,
				...todo,
			});
		} else {
			if (!current) throw new CloudToolArgumentRefusal("You have no todo with that todoKey");
			const status = request.action === "done" ? "done" : "cancelled";
			if (closed(current.todo.status) && current.todo.status !== status)
				throw new CloudToolArgumentRefusal("That todo is already closed the other way");
			todo = { title: current.todo.title, status, detail: current.todo.detail };
			text = setCompanyStateSettings(current.text, { status });
		}
		const units: CloudCompanyFolderUnit[] = [];
		// The folder core never invents a parent folder.
		if (!current && !(await this.#folder.read(this.#todos, signal)).entry)
			units.push({ op: "mkdir", path: this.#todos });
		units.push({
			op: "write",
			path,
			content: { text, mediaType: "text/markdown" },
			...(current ? { expectedVersion: current.entry.version } : {}),
		});
		return this.#operations.execute({
			operation: {
				tool: "manage_todo",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `todo:${request.operationKey}`,
				arguments:
					request.action === "upsert"
						? {
								action: request.action,
								todoKey: request.todoKey,
								title: todo.title,
								detail: todo.detail,
								state: todo.status,
							}
						: { action: request.action, todoKey: request.todoKey },
				target: { path },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const committed = await this.#folder.commit(
					`todo-file:${request.operationKey}`,
					units,
					{ receiptId },
					performSignal,
				);
				const written = committed.units.at(-1);
				if (!written) throw new Error("Company folder commit answered no unit");
				const output = cloudToolJsonText({
					schema: "qorpera.agent-todo-receipt/v1",
					runId: this.#identity.runId,
					receiptId,
					action: request.action,
					outcome: written.outcome,
					...(written.reason ? { reason: written.reason } : {}),
					...(written.problems.length ? { problems: written.problems } : {}),
					...(written.outcome === "conflict"
						? {
								next: "The todo changed since it was read: read it again and call once more with a new operationKey",
							}
						: {}),
					todo: {
						todoKey: request.todoKey,
						title: todo.title,
						detail: todo.detail,
						state: written.outcome === "saved" ? todo.status : (current?.todo.status ?? null),
						path,
						version: written.outcome === "saved" ? written.version : (current?.entry.version ?? null),
					},
				});
				// done and cancel show the todo as read: release that read with this result.
				if (current && request.action !== "upsert")
					await this.#folder.release(
						receiptId,
						[
							{
								path,
								version: current.entry.version,
								authority: current.entry.authority,
								fileSha256: current.entry.file.fileSha256,
							},
						],
						sha256(new TextEncoder().encode(output)),
						performSignal,
					);
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}
}
