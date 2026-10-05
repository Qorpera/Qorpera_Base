import { createHash, randomUUID } from "node:crypto";
import { parseCompanyStateFile, type RoutineFile } from "@qorpera/cloud-client/company-state-files";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderBytes,
	CloudCompanyFolderClient,
	type CloudCompanyFolderFile,
} from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import type { CloudToolContext } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
} from "@qorpera/runtime/cloud-native-tool-operations";
import type { BeginCloudRunnerOperationInput } from "@qorpera/runtime/cloud-runner-broker";
import { vi } from "vitest";
import { nativeToolAuthorityFixture } from "./native-tool-authority-fixture.ts";

/** The folder core and the receipt ledger, simulated at the wire with the shapes the folder client and the tool
 * operations parse (tests 760 and 650 pin them against the real SQL). The caller closes `run`. */
export const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const uuidFrom = (text: string) => {
	const hex = sha(text);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

interface Stored {
	version: string;
	file: CloudCompanyFolderFile;
	updatedAt: string;
}

/** The todos folder whose index the fake answers (`qorpera_folder_agent_todos`). */
const TODOS = "agents/nora/todos";
/** The routines folder whose index the fake answers (`qorpera_folder_agent_routines`). A write or delete of a routine
 * file is delegation. */
const ROUTINES = "agents/nora/routines";
const isRoutine = (path: string) =>
	path.startsWith(`${ROUTINES}/`) && /^[^/]+\.md$/.test(path.slice(ROUTINES.length + 1));

/** How the fake routine index runs a routine other than its file says: the platform's pauses, an ended routine. */
export interface FolderWriterRoutineState {
	readonly status: "paused" | "expired";
	readonly pauseReason: string | null;
}

/** A save the fake hook decides other than "saved": a structured file's rule, as F2's hooks word it. */
export interface FolderWriterHookAnswer {
	readonly outcome: "refused" | "denied" | "waiting_for_review";
	readonly reason: string;
	readonly problems?: readonly { code: string; message: string }[];
}

/** A fake folder core and receipt ledger for a folder writer's tests, with seeded files and folders. A write whose
 * parse has problems is refused as `structured_invalid`, as the real hook does; `hook` may refuse any other write. A
 * new folder with an `agent.md` or a `group.md`, and a write or delete of a routine file, is delegation (C1B §6): the
 * commit saves it only with a review recorded (`qorpera_folder_record_review`, C2 R1) for exactly its change set, and
 * `recorder` may answer the recording instead. A write of `decisionRoutineId`'s file (the run's own dynamic routine,
 * its decision taken as owed) that only decides it (a new at, effort or reply, or its conclusion) is plain, as SQL's
 * review class. The routine index runs each routine as its file says, unless `routineStates` says otherwise, and keeps
 * SQL's resume rule: a paid save of the active file, unchanged, ends the platform's pause, and a paid edit that makes a
 * new version ends a wait for a login; a change of the file's status overrides. `login` answers `qorpera_prepare_routine_login` (a paying login
 * by default), and its last answer is whether a save pays. A commit is not replayed by its operation key (SQL's step
 * 0); the receipt ledger replays a completed call. */
export async function folderWriterFixture(
	seed: { files?: Record<string, string>; folders?: string[] } = {},
	options: {
		hook?: (path: string, text: string) => FolderWriterHookAnswer | null;
		recorder?: (request: Record<string, unknown>) => Record<string, unknown> | null;
		login?: () => Record<string, unknown>;
		decisionRoutineId?: string;
		/** The worker index by todo key (`qorpera_folder_agent_workers`, with each worker's folder); a todo not named is
		 * one the run does not have (P0002), and a cancel finds its worker here. */
		workers?: Record<string, Record<string, unknown>[]>;
		/** Answers any other call (the proposal calls, P40); undefined leaves it unexpected. */
		rpc?: (method: string, args: Record<string, unknown>) => unknown;
	} = {},
) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const receipt = { resourceId: randomUUID(), resourceRevision: 1, grantId: randomUUID(), grantRevision: 1 };
	const bytesBySha = new Map<string, Uint8Array>();
	const files = new Map<string, Stored>();
	const rowIds = new Map<string, string>();
	const folders = new Set<string>(["agents", "agents/nora", ...(seed.folders ?? [])]);
	// A folder keeps its version until it is deleted.
	const folderVersions = new Map<string, string>();
	const folderVersion = (path: string) => {
		if (!folderVersions.has(path)) folderVersions.set(path, randomUUID());
		return folderVersions.get(path) as string;
	};
	const commits: { key: string; receiptId: unknown; reviewId: unknown; units: Record<string, unknown>[] }[] = [];
	// Recorded reviews: id → the change set's JSON, as the commit receives it.
	const reviews = new Map<string, string>();
	const recordings: Record<string, unknown>[] = [];
	const releases: Record<string, unknown>[] = [];
	const logins: Record<string, unknown>[] = [];
	// The worker tool's requests a worker commit carried (`qorpera_folder_worker_commit`), and the cancels.
	const workerRequests: Record<string, unknown>[] = [];
	const cancels: Record<string, unknown>[] = [];
	// Routine key → how the index runs it, where that differs from its file.
	const routineStates = new Map<string, FolderWriterRoutineState>();
	// Whether the requester's login pays, as the last login preparation found it.
	let paid = true;
	const routineOf = (path: string, data: Uint8Array | undefined) => {
		const parsed = parseCompanyStateFile(path, new TextDecoder().decode(data));
		if (!parsed?.ok || parsed.file.kind !== "routine") throw new Error("Fixture routine does not parse");
		return parsed.file;
	};
	// A routine change is delegation: saved only with the review recorded for exactly this change set.
	const reviewed = (args: Record<string, unknown>, units: Record<string, unknown>[]) =>
		typeof args.p_review_id === "string" && reviews.get(args.p_review_id) === JSON.stringify(units);
	let seq = 1;
	let tick = 0;
	const now = () =>
		`2026-10-01T00:${String(Math.floor(tick / 60)).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}+00:00`;
	// A file as another writer left it, in a folder that exists.
	const store = (path: string, content: string) => {
		const data = new TextEncoder().encode(content);
		bytesBySha.set(sha(data), data);
		files.set(path, {
			version: randomUUID(),
			file: {
				manifestSha256: sha(`manifest:${sha(data)}`),
				fileSha256: sha(data),
				bytes: data.byteLength,
				mediaType: "text/markdown",
				executable: false,
			},
			updatedAt: now(),
		});
		folders.add(path.split("/").slice(0, -1).join("/"));
	};
	for (const [path, content] of Object.entries(seed.files ?? {})) store(path, content);
	const entry = (path: string) => {
		const file = files.get(path);
		if (file)
			return {
				path,
				kind: "file",
				version: file.version,
				seq,
				updatedAt: file.updatedAt,
				...file.file,
				authority: receipt,
			};
		if (folders.has(path))
			return {
				path,
				kind: "folder",
				version: folderVersion(path),
				seq,
				updatedAt: "2026-10-01T00:00:00+00:00",
				authority: receipt,
			};
		return null;
	};
	const bytes: CloudCompanyFolderBytes = {
		put: vi.fn(async (data: Uint8Array, mediaType: string): Promise<CloudFileReference> => {
			bytesBySha.set(sha(data), Uint8Array.from(data));
			return {
				manifestSha256: sha(`manifest:${sha(data)}`),
				fileSha256: sha(data),
				bytes: data.byteLength,
				mediaType,
			};
		}),
		get: vi.fn(async (file: CloudCompanyFolderFile) => bytesBySha.get(file.fileSha256) ?? new Uint8Array()),
		range: vi.fn(async (file: CloudCompanyFolderFile, offset: number, length: number) =>
			(bytesBySha.get(file.fileSha256) ?? new Uint8Array()).subarray(offset, offset + length),
		),
	};
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (called, args) => {
			let method = called;
			// A worker commit is a commit that carries the worker tool's request, which the hook checks (F2-5b).
			if (method === "qorpera_folder_worker_commit") {
				workerRequests.push(structuredClone(args.p_request as Record<string, unknown>));
				method = "qorpera_folder_commit";
			}
			// The worker index as SQL pages it (20260930075000): filtered, 16 newest first, each with its cursor.
			if (method === "qorpera_folder_agent_workers") {
				const request = args.p_request as {
					todoKey: string;
					workerKey?: string;
					state?: string;
					search?: string;
					cursor?: string;
				};
				const listed = options.workers?.[request.todoKey];
				if (!listed) throw new CloudCompanyFolderRpcError("P0002", "Todo is unavailable");
				const all = listed.map(
					(worker) =>
						({ ...structuredClone(worker), cursor: uuidFrom(`worker:${worker.folder}`) }) as Record<
							string,
							unknown
						> & {
							cursor: string;
						},
				);
				const at = request.cursor ? all.findIndex((worker) => worker.cursor === request.cursor) : -1;
				if (request.cursor && at < 0)
					throw new CloudCompanyFolderRpcError("P0002", "Worker cursor is unavailable; list again without it");
				const search = request.search?.trim().toLowerCase();
				const rows = all
					.filter((_worker, index) => index > at)
					.filter(
						(worker) =>
							(request.workerKey === undefined || worker.workerKey === request.workerKey) &&
							(request.state === undefined ||
								(request.state === "active"
									? worker.state === "queued" || worker.state === "running"
									: worker.state === request.state)) &&
							(!search ||
								String(worker.title).toLowerCase().includes(search) ||
								String(worker.workerKey).includes(search)),
					);
				const page = rows.slice(0, 16);
				const more = rows.length - page.length;
				return {
					schema: "qorpera.folder-agent-workers/v1",
					todoKey: request.todoKey,
					workers: page,
					moreWorkers: more,
					nextCursor: more > 0 ? (page.at(-1)?.cursor ?? null) : null,
				};
			}
			if (method === "qorpera_folder_cancel_agent_worker") {
				const request = args.p_request as { folder: string; operationKey: string };
				cancels.push(structuredClone(args));
				const found = Object.values(options.workers ?? {})
					.flat()
					.find((worker) => worker.folder === request.folder);
				if (!found) throw new CloudCompanyFolderRpcError("P0002", "Worker is unavailable");
				const { folder: _folder, ...worker } = found;
				return {
					schema: "qorpera.agent-worker-receipt/v1",
					runId: (args.p_binding as { runId: string }).runId,
					receiptId: uuidFrom(`cancel:${request.operationKey}`),
					action: "cancel",
					folder: request.folder,
					worker: { ...worker, state: "cancelled" },
				};
			}
			if (method === "qorpera_folder_read") {
				const found = entry(args.p_path as string);
				return { schema: "qorpera.folder-read/v1", asOfSeq: seq, found: found !== null, entry: found };
			}
			if (method === "qorpera_folder_record_review") {
				const request = args.p_request as Record<string, unknown>;
				recordings.push(structuredClone(args));
				const answer = options.recorder?.(request);
				if (answer) return answer;
				const reviewId = uuidFrom(`review:${request.actionReviewId as string}`);
				const units = JSON.stringify(request.units);
				if (reviews.has(reviewId) && reviews.get(reviewId) !== units)
					throw new CloudCompanyFolderRpcError("23505", "This approval was already used for another change");
				reviews.set(reviewId, units);
				return {
					schema: "qorpera.folder-review/v1",
					reviewId,
					approvedBy: null,
					units: (request.units as unknown[]).length,
				};
			}
			if (method === "qorpera_folder_commit") {
				const units = args.p_units as Record<string, unknown>[];
				commits.push({
					key: args.p_operation_key as string,
					receiptId: args.p_receipt_id,
					reviewId: args.p_review_id,
					units,
				});
				const results = units.map((unit, index) => {
					const path = unit.path as string;
					const parent = path.split("/").slice(0, -1).join("/");
					const base = { unit: index + 1, op: unit.op, path };
					if (unit.op === "new_folder") {
						const taken = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
						if ([...files.keys(), ...folders].some(taken))
							return { ...base, outcome: "conflict", reason: "exists" };
						if (!folders.has(parent)) return { ...base, outcome: "refused", reason: "parent_missing" };
						// As SQL: the unit's own shape, then the hook decides each file, then the review is consulted.
						const contents = unit.contents as { path: string; kind?: string; file?: CloudCompanyFolderFile }[];
						const inner = new Set(contents.filter((item) => !item.file).map((item) => item.path));
						if (
							contents.some(
								(item) => item.path.includes("/") && !inner.has(item.path.split("/").slice(0, -1).join("/")),
							)
						)
							return { ...base, outcome: "refused", reason: "invalid" };
						const entries = (unit.structured as { problems?: Record<string, unknown>[] }[] | undefined) ?? [];
						const invalid = entries.find((item) => item.problems);
						if (invalid?.problems)
							return { ...base, outcome: "refused", reason: "structured_invalid", problems: invalid.problems };
						for (const item of contents) {
							if (!item.file) continue;
							const hooked = options.hook?.(
								`${path}/${item.path}`,
								new TextDecoder().decode(bytesBySha.get(item.file.fileSha256)),
							);
							if (hooked) return { ...base, ...hooked };
						}
						// A new agent or group chat is delegation.
						if (
							contents.some((item) => item.path === "agent.md" || item.path === "group.md") &&
							(typeof args.p_review_id !== "string" || reviews.get(args.p_review_id) !== JSON.stringify(units))
						)
							return { ...base, outcome: "denied", reason: "review_required" };
						folders.add(path);
						for (const item of contents)
							if (item.file)
								files.set(`${path}/${item.path}`, { version: randomUUID(), file: item.file, updatedAt: now() });
							else folders.add(`${path}/${item.path}`);
						return { ...base, outcome: "saved", version: randomUUID() };
					}
					if (unit.op === "mkdir") {
						if (files.has(path) || folders.has(path)) return { ...base, outcome: "conflict", reason: "exists" };
						if (parent !== "" && !folders.has(parent))
							return { ...base, outcome: "refused", reason: "parent_missing" };
						folders.add(path);
						return { ...base, outcome: "saved", version: folderVersion(path) };
					}
					// A folder's deletion, as SQL's subtree delete: its version, the listing it was seen at, its review.
					if (unit.op === "delete" && folders.has(path)) {
						if (folderVersion(path) !== unit.expectedVersion)
							return { ...base, outcome: "conflict", reason: "version_changed" };
						if (unit.asOfSeq === undefined) return { ...base, outcome: "refused", reason: "as_of_seq_required" };
						const inside = (candidate: string) => candidate.startsWith(`${path}/`);
						if ([...files.keys(), ...folders].some(inside) && (unit.asOfSeq as number) < seq)
							return { ...base, outcome: "conflict", reason: "unseen_change" };
						if (!reviewed(args, units)) return { ...base, outcome: "denied", reason: "review_required" };
						folders.delete(path);
						folderVersions.delete(path);
						return { ...base, outcome: "saved", version: randomUUID() };
					}
					if (unit.op === "delete") {
						const current = files.get(path);
						if (current?.version !== unit.expectedVersion)
							return { ...base, outcome: "conflict", reason: current ? "version_changed" : "missing" };
						// A deletion is reviewed (C1B §6).
						if (!reviewed(args, units)) return { ...base, outcome: "denied", reason: "review_required" };
						files.delete(path);
						routineStates.delete(path.slice(ROUTINES.length + 1, -3));
						// The deletion's own version, as the commit answers it.
						return { ...base, outcome: "saved", version: randomUUID() };
					}
					if (!folders.has(parent)) return { ...base, outcome: "refused", reason: "parent_missing" };
					const current = files.get(path);
					// A write without a version creates the file, and meets one that is there as SQL does.
					if (unit.expectedVersion === undefined && current)
						return { ...base, outcome: "conflict", reason: "exists" };
					if (unit.expectedVersion !== undefined && current?.version !== unit.expectedVersion)
						return { ...base, outcome: "conflict", reason: current ? "version_changed" : "missing" };
					// The structured hook: a parse with problems is refused with them (nulls stripped, as the commit does).
					const structured = (unit.structured as { problems?: Record<string, unknown>[] }[] | undefined)?.[0];
					if (structured?.problems)
						return {
							...base,
							outcome: "refused",
							reason: "structured_invalid",
							problems: structured.problems.map((problem) =>
								Object.fromEntries(Object.entries(problem).filter(([, value]) => value !== null)),
							),
						};
					const hooked = options.hook?.(
						path,
						new TextDecoder().decode(bytesBySha.get((unit.file as CloudCompanyFolderFile).fileSha256)),
					);
					if (hooked) return { ...base, ...hooked };
					if (isRoutine(path)) {
						const key = path.slice(ROUTINES.length + 1, -3);
						const next = routineOf(path, bytesBySha.get((unit.file as CloudCompanyFolderFile).fileSha256));
						const previous = current ? routineOf(path, bytesBySha.get(current.file.fileSha256)) : null;
						// Delegation, except a dynamic routine's decision: a new at, effort or reply, or its conclusion.
						const without = (routine: RoutineFile, keys: readonly string[]) =>
							JSON.stringify(
								Object.fromEntries(Object.entries(routine).filter(([name]) => !keys.includes(name))),
							);
						const decision =
							options.decisionRoutineId !== undefined &&
							previous?.id === options.decisionRoutineId &&
							previous.trigger.when === "once" &&
							((next.status === "active" &&
								next.trigger.when === "once" &&
								without(next, ["trigger", "effort", "reply"]) ===
									without(previous, ["trigger", "effort", "reply"])) ||
								(next.status === "concluded" &&
									without(next, ["status", "conclusion"]) === without(previous, ["status", "conclusion"])));
						if (!decision && !reviewed(args, units))
							return { ...base, outcome: "denied", reason: "review_required" };
						// SQL's resume rule: a paid save of the active file, unchanged, ends the platform's pause, and a paid edit
						// that makes a new version (a new title, instructions, trigger with its time zone and reply, or effort)
						// ends a wait for a login; any other edit keeps the pause. A change of the file's status overrides, and so
						// does a changed routine over an ended one. An archive's pause ends once the agent is active again, which
						// the fixture's agent always is.
						const state = routineStates.get(key);
						const same = JSON.stringify(next) === JSON.stringify(previous);
						const version = (routine: RoutineFile | null) =>
							routine &&
							JSON.stringify([
								routine.title,
								routine.instructions,
								routine.trigger,
								routine.timezone,
								routine.reply,
								routine.effort,
							]);
						const platform =
							state?.status === "paused" &&
							["member", "authorization_failed", "needs_model_account", "agent_archived"].includes(
								state.pauseReason ?? "",
							);
						if (previous && next.status !== previous.status) routineStates.delete(key);
						else if (
							platform &&
							paid &&
							next.status === "active" &&
							(same || (state?.pauseReason === "needs_model_account" && version(next) !== version(previous)))
						)
							routineStates.delete(key);
						else if (state?.status === "expired" && !same) routineStates.delete(key);
					}
					const version = randomUUID();
					files.set(path, { version, file: unit.file as CloudCompanyFolderFile, updatedAt: now() });
					return { ...base, outcome: "saved", version };
				});
				// The folder's clock moves only when a unit is saved.
				const any = results.some((result) => result.outcome === "saved");
				if (any) seq += 1;
				return {
					schema: "qorpera.folder-commit/v1",
					commitId: randomUUID(),
					seq: any ? seq : null,
					replay: false,
					units: results,
				};
			}
			// The todo index as the commit keeps it: one row per todo file, in the order the files were made.
			if (method === "qorpera_folder_agent_todos") {
				const request = args.p_request as {
					includeClosed?: boolean;
					state?: string;
					search?: string;
					cursor?: string;
				};
				const search = request.search?.trim().toLowerCase();
				const all = [...files.entries()]
					.filter(([path]) => path.startsWith(`${TODOS}/`) && /^[^/]+\.md$/.test(path.slice(TODOS.length + 1)))
					.map(([path, stored]) => {
						const parsed = parseCompanyStateFile(
							path,
							new TextDecoder().decode(bytesBySha.get(stored.file.fileSha256)),
						);
						const todo = parsed?.ok && parsed.file.kind === "todo" ? parsed.file : null;
						if (!todo) throw new Error("Fixture todo does not parse");
						if (!rowIds.has(path)) rowIds.set(path, randomUUID());
						return { path, stored, todo, id: rowIds.get(path) as string, key: path.slice(TODOS.length + 1, -3) };
					})
					.reverse();
				// As the real function, the cursor is looked up among all the agent's rows, not only those that match.
				const at = request.cursor ? all.findIndex((row) => row.id === request.cursor) : -1;
				if (request.cursor && at < 0) throw new Error("Todo cursor is unavailable; list again without it");
				const rows = all
					.filter((_row, index) => index > at)
					.filter(
						({ todo, key }) =>
							(request.state
								? todo.status === request.state
								: request.includeClosed || todo.status === "open" || todo.status === "blocked") &&
							(!search || todo.title.toLowerCase().includes(search) || key.includes(search)),
					);
				const page = rows.slice(0, 32);
				const more = rows.length - page.length;
				return {
					schema: "qorpera.folder-agent-todos/v1",
					todos: page.map(({ path, stored, todo, id, key }) => ({
						todoKey: key,
						title: todo.title,
						state: todo.status,
						// Code points, as SQL's left and char_length.
						detail: Array.from(todo.detail).slice(0, 200).join(""),
						...(Array.from(todo.detail).length > 200 ? { detailTruncated: true } : {}),
						path,
						version: stored.version,
						updatedAt: stored.updatedAt,
						cursor: id,
					})),
					moreTodos: more,
					nextCursor: more > 0 ? (page.at(-1)?.id ?? null) : null,
				};
			}
			// The routine index as the commit keeps it: one row per routine file, in the order the files were made.
			if (method === "qorpera_folder_agent_routines") {
				const request = args.p_request as { routineKey?: string; cursor?: string };
				const all = [...files.entries()]
					.filter(([path]) => isRoutine(path))
					.map(([path, stored]) => {
						const routine = routineOf(path, bytesBySha.get(stored.file.fileSha256));
						const key = path.slice(ROUTINES.length + 1, -3);
						const state = routineStates.get(key);
						return { path, stored, routine, key, state };
					})
					.reverse();
				const at = request.cursor ? all.findIndex((row) => row.routine.id === request.cursor) : -1;
				if (request.cursor && at < 0) throw new Error("Routine cursor is unavailable; list again without it");
				const rows = all
					.filter((_row, index) => index > at)
					.filter((row) => request.routineKey === undefined || row.key === request.routineKey);
				const page = rows.slice(0, 32);
				const more = rows.length - page.length;
				return {
					schema: "qorpera.folder-agent-routines/v1",
					routines: page.map(({ path, stored, routine, key, state }) => {
						// A page cuts the instructions to 200 characters, as SQL's left.
						const cut = request.routineKey === undefined && Array.from(routine.instructions).length > 200;
						return {
							routineKey: key,
							routineId: routine.id,
							version: 1,
							status: state?.status ?? routine.status,
							pauseReason: state ? state.pauseReason : routine.status === "paused" ? "agent" : null,
							title: routine.title,
							trigger: { id: "file", kind: "schedule" },
							effort: routine.effort,
							expiresAt: routine.ends,
							maxOccurrences: routine.runs,
							quietHours: null,
							occurrences: 2,
							nextRunAt: routine.status === "active" && !state ? "2026-10-02T09:00:00Z" : null,
							conclusion: routine.conclusion,
							concludedAt: null,
							path,
							folderVersion: stored.version,
							cursor: routine.id,
							file: cut
								? { ...routine, instructions: Array.from(routine.instructions).slice(0, 200).join("") }
								: routine,
							...(cut ? { instructionsTruncated: true } : {}),
						};
					}),
					moreRoutines: more,
					nextCursor: more > 0 ? (page.at(-1)?.routine.id ?? null) : null,
				};
			}
			if (method === "qorpera_prepare_routine_login") {
				logins.push(structuredClone(args));
				const answer = options.login?.() ?? {
					schema: "qorpera.routine-login/v1",
					runId: (args.p_binding as { runId: string }).runId,
					login: { bindingId: "0b1c2d3e-4444-4444-8444-444444444444", version: 1 },
				};
				paid = answer.login !== null;
				return answer;
			}
			if (method === "qorpera_folder_list") {
				const parent = args.p_parent as string;
				const after = args.p_after as string | null;
				const children = [...files.keys(), ...folders]
					.filter((path) =>
						parent === ""
							? !path.includes("/")
							: path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/"),
					)
					.sort()
					.filter((path) => after === null || path > after);
				const page = children.slice(0, args.p_limit as number);
				return {
					schema: "qorpera.folder-list/v1",
					asOfSeq: seq,
					entries: page.map(entry),
					next: page.length === (args.p_limit as number) ? (page.at(-1) ?? null) : null,
				};
			}
			if (method === "qorpera_folder_record_release") {
				releases.push(structuredClone(args));
				return {
					schema: "qorpera.folder-release/v1",
					releaseId: args.p_release_id,
					reads: (args.p_reads as unknown[]).length,
					replay: false,
				};
			}
			const answer = options.rpc?.(method, args);
			if (answer !== undefined) return answer;
			throw new Error(`Unexpected ${method}`);
		}),
	};
	const folder = new CloudCompanyFolderClient({ binding, identity, control, bytes });
	// The receipt ledger: folder receipts that a commit satisfies, completed with that commit.
	const ledger = new Map<
		string,
		{ input: BeginCloudRunnerOperationInput; result: JsonValue | null; commit: string | null }
	>();
	const operationControl = {
		beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async (b, input) => {
			let row = ledger.get(input.logicalOperationKey);
			if (row && row.input.inputSha256 !== input.inputSha256) throw new Error("other work");
			if (!row) {
				row = { input: structuredClone(input), result: null, commit: null };
				ledger.set(input.logicalOperationKey, row);
			}
			return {
				run_id: b.runId,
				receipt_id: row.input.receiptId,
				state: row.result === null ? "executing" : "completed",
				result: row.result,
				output_snapshot_id: null,
				proposal_id: null,
				folder_commit_id: row.commit,
			};
		}),
		completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(async () => {
			throw new Error("A folder writer completes with its commit");
		}),
		completeFolderToolOperation: vi.fn<
			NonNullable<CloudNativeToolOperationControlPlane["completeFolderToolOperation"]>
		>(async (b, input) => {
			const row = [...ledger.values()].find((value) => value.input.receiptId === input.receiptId);
			if (!row || row.result !== null) throw new Error("invalid completion");
			row.result = structuredClone(input.result);
			row.commit = input.folderCommitId;
			return {
				run_id: b.runId,
				receipt_id: input.receiptId,
				state: "completed",
				result: input.result,
				folder_commit_id: input.folderCommitId,
			};
		}),
	};
	const abort = new AbortController();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: vi.fn(async () => structuredClone(authority)) },
		abort.signal,
	);
	const operations = () => new CloudNativeToolOperations(run, operationControl);
	const context: CloudToolContext = {
		companyId: identity.companyId,
		runId: identity.runId,
		callId: randomUUID(),
		argumentSha256: "a".repeat(64),
		signal: abort.signal,
		identity,
		actionReviewId: randomUUID(),
	};
	const text = (path: string) => {
		const stored = files.get(path);
		return stored ? new TextDecoder().decode(bytesBySha.get(stored.file.fileSha256)) : null;
	};
	return {
		binding,
		identity,
		folder,
		files,
		folders,
		commits,
		recordings,
		reviews,
		releases,
		logins,
		workerRequests,
		cancels,
		routineStates,
		ledger,
		operationControl,
		operations,
		run,
		context,
		text,
		seed: store,
	};
}
