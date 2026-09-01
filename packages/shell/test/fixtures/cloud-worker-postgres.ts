import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	CLOUD_COMPANY_TREE_OMITTED_LAYERS,
	type CloudCompanyTreeEntry,
	type CloudCompanyTreeReference,
	readCloudCompanyTreeManifest,
	verifyCloudCompanyTreeRestore,
} from "../../src/cloud-company-snapshot.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../../src/cloud-object-store.ts";
import {
	parseWorkerTodo,
	type WorkerContinuation,
	type WorkerDispatch,
	type WorkerHandle,
	type WorkerParentIdentity,
	type WorkerResult,
	type WorkerSourceReference,
	type WorkerTodo,
	type WorkerTodoIdentity,
	type WorkerToolReference,
	workerDigest,
	workerSame,
	workerStableId,
} from "../../src/cloud-worker-contract.ts";
import { InHouseWorkerLifecycle } from "../../src/cloud-worker-lifecycle.ts";
import {
	type WorkerAuthorityPort,
	type WorkerCommandReceipt,
	type WorkerCompanyFilePort,
	type WorkerContinuationPort,
	type WorkerContinuationReceipt,
	type WorkerEffectGuard,
	type WorkerLookup,
	type WorkerRunPort,
	type WorkerRunRequest,
	workerRunRequestDigest,
} from "../../src/cloud-worker-ports.ts";
import { CompanyFileWorkerTodoStore, WorkerTodoConflict } from "../../src/cloud-worker-todo-store.ts";
import { signal, workerDispatch, workerIdentities, workerResult, workerScope } from "./cloud-worker-fixture.ts";

const EMPTY_SHA = createHash("sha256").update("").digest("hex");

export function sqlValue(value: unknown): string {
	if (value === null) return "null";
	return `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}

export function disposableSql(container: string, sql: string): string {
	if (!/^qorpera-step5-test-[0-9]+-[0-9a-f]{12}$/.test(container)) throw new Error("Not a Step 5 disposable database");
	const result = spawnSync(
		"docker",
		[
			"exec",
			"-i",
			container,
			"psql",
			"-U",
			"postgres",
			"-d",
			"qorpera_test",
			"-X",
			"-qAt",
			"-v",
			"ON_ERROR_STOP=1",
			"-v",
			"VERBOSITY=verbose",
		],
		{
			input: sql,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (result.stderr.includes("PT409")) throw new WorkerTodoConflict();
		throw new Error(result.stderr);
	}
	return result.stdout.trim().split("\n").at(-1) ?? "";
}

interface DatabaseIdentity {
	todo: WorkerTodoIdentity;
	parent: WorkerParentIdentity;
	sponsorId: string;
	assignmentId: string;
}

interface TreeState {
	head: string | null;
	entries: CloudCompanyTreeEntry[];
	document: WorkerTodo | null;
	text: string | null;
}

type StoredWork = Extract<WorkerResult["work"], { kind: "company-file" | "proposal" }>;
type FileEntry = Extract<CloudCompanyTreeEntry, { kind: "file" }>;

interface OutputPlan {
	kind: StoredWork["kind"];
	worker: WorkerHandle;
	entry: FileEntry;
	tool: WorkerToolReference;
	receiptId: string;
	proposalId: string | null;
}

interface OutputReceipt {
	id: string;
	input_sha256: string;
	output_snapshot_id: string | null;
	proposal_id: string | null;
	result: {
		schema: "test.worker-output/v1";
		kind: StoredWork["kind"];
		binding: Pick<
			WorkerResult,
			"workerId" | "todo" | "parentRunId" | "execution" | "delegation" | "epoch" | "sequence"
		>;
		tool: WorkerToolReference;
		entry: FileEntry;
		source: WorkerSourceReference;
	};
}

/** Immutable object bytes, fsynced on disk. The live Company File head is only in PostgreSQL. */
class DiskObjectTransport implements CloudObjectTransport {
	readonly #directory: string;
	constructor(directory: string) {
		this.#directory = directory;
	}
	async put(path: string, bytes: Uint8Array): Promise<"stored" | "exists"> {
		if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(path)) throw new Error("Invalid test object path");
		const target = join(this.#directory, path);
		await mkdir(dirname(target), { recursive: true });
		let file: FileHandle;
		try {
			file = await open(target, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
			throw error;
		}
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		const directory = await open(dirname(target), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
		return "stored";
	}
	async get(path: string): Promise<Uint8Array> {
		if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(path)) throw new Error("Invalid test object path");
		return readFile(join(this.#directory, path));
	}
}

/**
 * Test-only adapter, never production wiring. Uses real snapshot publication,
 * object closure/proofs, run admission and existing operation receipts. Model
 * execution, stream input and parent wake delivery are deliberately simulated.
 * No worker/todo/queue tables or migrations are introduced.
 */
export class PostgresWorkerFixture {
	readonly container: string;
	readonly objectsDirectory: string;
	readonly identity: DatabaseIdentity;
	readonly objects: CloudContentAddressedStore;
	readonly authority: WorkerAuthorityPort;
	readonly file: WorkerCompanyFilePort;
	readonly runs: WorkerRunPort;
	readonly continuations: WorkerContinuationPort;
	afterFileCommit?: (guard: WorkerEffectGuard) => void;
	beforeFilePublish?: (guard: WorkerEffectGuard) => void | Promise<void>;
	afterRunCommit?: (request: WorkerRunRequest) => void;
	afterContinuationCommit?: () => void;
	beforeRunCommit?: () => void;
	rollbackBeforePublish = false;

	constructor(container: string, objectsDirectory: string, identity: DatabaseIdentity) {
		this.container = container;
		this.objectsDirectory = objectsDirectory;
		this.identity = structuredClone(identity);
		this.objects = new CloudContentAddressedStore(new DiskObjectTransport(objectsDirectory));
		this.authority = {
			assertParent: async (todo, parent, actor) => {
				if (
					!workerSame(todo, this.identity.todo) ||
					!workerSame(parent, this.identity.parent) ||
					actor !== parent.runId
				)
					throw new Error("Wrong parent authority");
				this.query(`do $$ begin ${this.authoritySql(false)} end $$;`);
			},
			resolve: async (dispatch) => {
				if (!this.active()) return null;
				// This is a fixed test grant, not authority inferred from a worker's requested tools.
				const expected = this.dispatch(dispatch.workerId, dispatch.operationKey);
				expected.tools.push(
					this.outputTool(dispatch.workerId, "company-file"),
					this.outputTool(dispatch.workerId, "proposal"),
				);
				return workerScope(expected);
			},
		};
		this.file = {
			read: async (path, offset, limit, requestSignal) => {
				requestSignal.throwIfAborted();
				const state = await this.tree();
				if (state.text === null) return { path, kind: "absent", version: null };
				const bytes = Buffer.from(state.text);
				let end = Math.min(bytes.length, offset + limit);
				while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
				return {
					path,
					kind: "file",
					version: state.head,
					offset,
					bytesRead: end - offset,
					totalBytes: bytes.length,
					text: bytes.subarray(offset, end).toString(),
					nextOffset: end === bytes.length ? null : end,
				};
			},
			commit: async (guard, mutation, requestSignal) => {
				requestSignal.throwIfAborted();
				const current = await this.tree();
				if (mutation.expectedVersion !== (current.document ? current.head : null)) throw new WorkerTodoConflict();
				this.validateGuard(guard, current);
				const next = parseWorkerTodo(JSON.parse(mutation.text));
				if (!workerSame(next.identity, this.identity.todo) || !workerSame(next.parent, this.identity.parent))
					throw new Error("Changed todo identity");
				const worker = next.workers.find((worker) => worker.dispatch.workerId === guard.workerId);
				const result =
					guard.purpose === "followup"
						? worker?.history.find((checkpoint) => checkpoint.result.sequence === guard.sequence)?.result
						: ["complete", "accept"].includes(guard.purpose)
							? worker?.result
							: null;
				if (result) await this.verifyStoredResult(guard, result, current);
				const file = await this.objects.putFile(
					this.identity.todo.companyId,
					Buffer.from(mutation.text),
					"application/octet-stream",
				);
				const entries: CloudCompanyTreeEntry[] = [
					...current.entries.filter((entry) => entry.path !== mutation.path),
					{ kind: "file", path: mutation.path, executable: false, file },
				];
				const snapshot = await this.publish(
					entries,
					current.head,
					workerStableId(mutation.operationKey),
					guard,
					undefined,
					result ? [result] : [],
				);
				this.afterFileCommit?.(guard);
				return {
					schema: "qorpera.company-path-result/v1",
					state: "applied",
					operationKey: mutation.operationKey,
					path: mutation.path,
					version: snapshot,
					snapshotId: snapshot,
					receiptId: snapshot,
					proposalId: null,
				};
			},
		};
		this.runs = {
			submit: async (request) => {
				this.beforeRunCommit?.();
				const receipt = await this.submitRun(request);
				this.afterRunCommit?.(request);
				return receipt;
			},
			lookup: async (request) =>
				this.lookup<WorkerCommandReceipt>(this.commandKey(request), workerRunRequestDigest(request)),
			inspect: async (_guard, execution) => {
				const result = this.query<WorkerResult | null>(
					`select result from public.qorpera_run_operation_receipts where run_id=${sqlValue(this.identity.parent.runId)} and operation_kind='test_worker_result' and result #>> '{execution,runId}'=${sqlValue(execution.runId)} order by created_at desc limit 1;`,
				);
				return result ? { state: "terminal", result } : { state: "active" };
			},
			verifyResult: async (guard, result) => this.verifyStoredResult(guard, result, await this.tree()),
		};
		this.continuations = {
			submit: async (guard, intent) => {
				const receipt = await this.submitContinuation(guard, intent);
				this.afterContinuationCommit?.();
				return receipt;
			},
			lookup: async (_guard, intent) =>
				this.lookup<WorkerContinuationReceipt>(
					`continuation:${intent.intentId}`,
					workerDigest(this.continuationIdentity(intent)),
				),
		};
	}

	query<T = unknown>(sql: string): T {
		const claims = {
			sub: this.identity.parent.requesterUserId,
			role: "authenticated",
			email: "worker-test@example.test",
		};
		const result = disposableSql(
			this.container,
			`begin; set local request.jwt.claims=${sqlValue(claims)}; ${sql} commit;`,
		);
		return (result === "t" ? true : result === "f" ? false : result ? JSON.parse(result) : null) as T;
	}

	active(): boolean {
		return this.query<boolean>(
			`select exists(select 1 from public.qorpera_execution_sponsor_bindings where id=${sqlValue(this.identity.sponsorId)} and status='active');`,
		);
	}

	authoritySql(cleanup: boolean): string {
		return `if not exists(select 1 from public.qorpera_profile_members where profile_id=${sqlValue(this.identity.todo.companyId)} and user_id=auth.uid() and role='owner') then raise exception 'test parent revoked'; end if;
		${cleanup ? "" : `perform 1 from public.qorpera_execution_sponsor_bindings where id=${sqlValue(this.identity.sponsorId)} and status='active' for share; if not found then raise exception 'test delegation revoked'; end if;`}`;
	}

	validateGuard(guard: WorkerEffectGuard, state: TreeState): void {
		if (
			guard.actorRunId !== this.identity.parent.runId ||
			!workerSame(guard.todo, this.identity.todo) ||
			!workerSame(guard.parent, this.identity.parent)
		)
			throw new Error("Wrong effect principal");
		if (guard.workerId) {
			const worker = state.document?.workers.find((worker) => worker.dispatch.workerId === guard.workerId);
			if (
				!worker &&
				guard.purpose === "dispatch" &&
				guard.epoch === null &&
				guard.sequence === null &&
				workerSame(guard.delegation, { id: this.identity.sponsorId, version: 1 })
			)
				return;
			if (
				!worker ||
				!workerSame(worker.dispatch.delegation, guard.delegation) ||
				worker.epoch !== guard.epoch ||
				worker.sequence !== guard.sequence
			)
				throw new Error("Worker effect fenced");
			if (!["cancel", "reconcile"].includes(guard.purpose) && ["cancelled", "revoked"].includes(worker.phase))
				throw new Error("Worker effect cancelled");
		}
	}

	async tree(): Promise<TreeState> {
		const row = this.query<{ head: string; tree: CloudCompanyTreeReference } | null>(
			`select jsonb_build_object('head', snapshot.id, 'tree', jsonb_build_object('manifestSha256', tree_manifest_sha256, 'manifestBytes', tree_manifest_bytes, 'contractVersion', tree_contract_version, 'fileCount', file_count, 'totalBytes', total_bytes)) from public.qorpera_company_files as file join public.qorpera_company_snapshots as snapshot on snapshot.id=file.head_snapshot_id where file.environment_id=${sqlValue(this.identity.todo.environmentId)};`,
		);
		if (!row) return { head: null, entries: [], document: null, text: null };
		const tree = await readCloudCompanyTreeManifest(this.identity.todo.companyId, row.tree, this.objects);
		const entry = tree.entries.find((entry) => entry.path === this.identity.todo.path);
		const text =
			entry?.kind === "file"
				? Buffer.from(await this.objects.getFile(this.identity.todo.companyId, entry.file)).toString()
				: null;
		return { head: row.head, entries: tree.entries, document: text ? parseWorkerTodo(JSON.parse(text)) : null, text };
	}

	dispatch(workerId: string = randomUUID(), operationKey: string = randomUUID()): WorkerDispatch {
		const dispatch = workerDispatch(this.identity.todo, this.identity.parent);
		dispatch.workerId = workerId;
		dispatch.operationKey = operationKey;
		dispatch.delegation = { id: this.identity.sponsorId, version: 1 };
		dispatch.tools[0].grant = dispatch.delegation;
		dispatch.context.sources = [];
		return dispatch;
	}

	outputTool(workerId: string, kind: StoredWork["kind"]): WorkerToolReference {
		return {
			name: kind === "company-file" ? "company_write" : "company_propose",
			schemaVersion: "v1",
			grant: { id: workerStableId([this.identity.sponsorId, workerId, kind]), version: 1 },
			effect: "company-file",
			audience: "private",
		};
	}

	dispatchOutput(kind: StoredWork["kind"]): WorkerDispatch {
		const dispatch = this.dispatch();
		dispatch.tools.push(this.outputTool(dispatch.workerId, kind));
		return dispatch;
	}

	async snapshotEntries(snapshotId: string): Promise<CloudCompanyTreeEntry[]> {
		const reference = this.query<CloudCompanyTreeReference | null>(
			`select jsonb_build_object('manifestSha256', tree_manifest_sha256, 'manifestBytes', tree_manifest_bytes, 'contractVersion', tree_contract_version, 'fileCount', file_count, 'totalBytes', total_bytes) from public.qorpera_company_snapshots where id=${sqlValue(snapshotId)} and profile_id=${sqlValue(this.identity.todo.companyId)} and environment_id=${sqlValue(this.identity.todo.environmentId)};`,
		);
		if (!reference) throw new Error("Output snapshot does not belong to this Company File");
		return (await readCloudCompanyTreeManifest(this.identity.todo.companyId, reference, this.objects)).entries;
	}

	async verifyStoredResult(guard: WorkerEffectGuard, result: WorkerResult, current: TreeState): Promise<void> {
		if (!this.active()) throw new Error("Revoked result authority");
		if (guard.parent.runId !== result.parentRunId) throw new Error("Wrong completion parent");
		const saved = this.query<WorkerResult | null>(
			`select result from public.qorpera_run_operation_receipts where id=${sqlValue(result.receiptId)} and run_id=${sqlValue(this.identity.parent.runId)} and operation_kind='test_worker_result' and status='completed';`,
		);
		if (!workerSame(saved, result)) throw new Error("Unauthenticated test completion");
		if (result.work.kind === "no-change") return;
		const worker = current.document?.workers.find((worker) => worker.dispatch.workerId === result.workerId);
		const receiptIds = result.work.kind === "company-file" ? result.work.receiptIds : [result.work.receiptId];
		const sources = result.work.kind === "company-file" ? result.work.outputs : result.work.sources;
		if (receiptIds.length !== sources.length || new Set(receiptIds).size !== receiptIds.length)
			throw new Error("Output receipts and references differ");
		for (const [index, receiptId] of receiptIds.entries()) {
			const receipt = this.query<OutputReceipt | null>(
				`select to_jsonb(receipt) from public.qorpera_run_operation_receipts as receipt where id=${sqlValue(receiptId)} and run_id=${sqlValue(this.identity.parent.runId)} and operation_kind='test_worker_output' and status='completed' and requires_company_revision;`,
			);
			const { workerId, todo, parentRunId, execution, delegation, epoch, sequence } = result;
			const tool = this.outputTool(workerId, result.work.kind);
			if (
				!receipt ||
				receipt.result.schema !== "test.worker-output/v1" ||
				receipt.result.kind !== result.work.kind ||
				!workerSame(receipt.result.binding, {
					workerId,
					todo,
					parentRunId,
					execution,
					delegation,
					epoch,
					sequence,
				}) ||
				!workerSame(receipt.result.source, sources[index]) ||
				!workerSame(receipt.result.tool, tool) ||
				!worker?.dispatch.tools.some((requested) => workerSame(requested, tool))
			)
				throw new Error("Output receipt is not bound to this worker and reference");
			const entry = (await this.snapshotEntries(sources[index].version)).find(
				(entry) => entry.path === sources[index].path,
			);
			if (entry?.kind !== "file" || !workerSame(entry, receipt.result.entry))
				throw new Error("Output object differs from its receipt");
			// getFile verifies the actual immutable bytes, not only catalog metadata.
			await this.objects.getFile(this.identity.todo.companyId, entry.file);
			if (result.work.kind === "company-file") {
				if (
					receipt.output_snapshot_id !== sources[index].version ||
					receipt.proposal_id !== null ||
					!workerSame(
						current.entries.find((item) => item.path === entry.path),
						entry,
					) ||
					!this.query<boolean>(
						`select exists(select 1 from public.qorpera_company_snapshot_publications where snapshot_id=${sqlValue(sources[index].version)} and status='published');`,
					)
				)
					throw new Error("Output is no longer the receipted live Company File artifact");
			} else if (
				receipt.proposal_id !== result.work.proposalId ||
				receipt.output_snapshot_id !== null ||
				!this.query<boolean>(
					`select exists(select 1 from public.qorpera_company_proposals where id=${sqlValue(result.work.proposalId)} and profile_id=${sqlValue(todo.companyId)} and environment_id=${sqlValue(todo.environmentId)} and execution_kind='run' and execution_id=${sqlValue(execution.runId)} and proposal_snapshot_id=${sqlValue(sources[index].version)} and status in ('open','accepted'));`,
				)
			) {
				throw new Error("Proposal output is missing, changed or rejected");
			}
		}
	}

	/** Test output bridge: real object publication/proposal storage, no native executor or public message. */
	async publishWorkerOutput(worker: WorkerHandle, kind: StoredWork["kind"], text: string): Promise<StoredWork> {
		const current = await this.tree();
		const tool = this.outputTool(worker.dispatch.workerId, kind);
		if (!worker.execution || !worker.dispatch.tools.some((requested) => workerSame(requested, tool)))
			throw new Error("Worker lacks the explicit output grant");
		const guard: WorkerEffectGuard = {
			todo: this.identity.todo,
			parent: this.identity.parent,
			actorRunId: this.identity.parent.runId,
			expectedVersion: current.head,
			workerId: worker.dispatch.workerId,
			delegation: worker.dispatch.delegation,
			epoch: worker.epoch,
			sequence: worker.sequence,
			purpose: "complete",
		};
		this.validateGuard(guard, current);
		const path = `work/${kind === "company-file" ? "output" : "proposed"}-${worker.dispatch.workerId}.md`;
		const entry: FileEntry = {
			kind: "file",
			path,
			executable: false,
			file: await this.objects.putFile(this.identity.todo.companyId, Buffer.from(text), "application/octet-stream"),
		};
		const receiptId = workerStableId([this.identity.parent.runId, worker.dispatch.workerId, worker.sequence, kind]);
		const proposalId = kind === "proposal" ? workerStableId([receiptId, "proposal"]) : null;
		await this.publish(
			[...current.entries.filter((item) => item.path !== path), entry],
			current.head,
			workerStableId([receiptId, "snapshot"]),
			guard,
			{ kind, worker, entry, tool, receiptId, proposalId },
		);
		const receipt = this.query<OutputReceipt>(
			`select to_jsonb(receipt) from public.qorpera_run_operation_receipts as receipt where id=${sqlValue(receiptId)};`,
		);
		return kind === "company-file"
			? { kind, outputs: [receipt.result.source], receiptIds: [receiptId] }
			: { kind, proposalId: proposalId!, receiptId, sources: [receipt.result.source] };
	}

	lifecycle(): InHouseWorkerLifecycle {
		return new InHouseWorkerLifecycle({
			store: new CompanyFileWorkerTodoStore(this.identity.todo, this.identity.parent, this.file),
			authority: this.authority,
			runs: this.runs,
			continuations: this.continuations,
			actorRunId: this.identity.parent.runId,
		});
	}

	reopen(): PostgresWorkerFixture {
		return new PostgresWorkerFixture(this.container, this.objectsDirectory, this.identity);
	}

	async publish(
		entries: CloudCompanyTreeEntry[],
		expectedHead: string | null,
		clientId: string,
		guard?: WorkerEffectGuard,
		output?: OutputPlan,
		verifiedResults: WorkerResult[] = [],
	): Promise<string> {
		entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		const tree = {
			schema: "qorpera.company-tree/v1",
			contractVersion: 3,
			omittedLayers: CLOUD_COMPANY_TREE_OMITTED_LAYERS,
			entries,
		};
		const object = await this.objects.putObject(
			this.identity.todo.companyId,
			Buffer.from(JSON.stringify(tree)),
			"application/vnd.qorpera.company-tree+json",
		);
		const files = entries.flatMap((entry) => (entry.kind === "file" ? [entry.file] : []));
		const reference: CloudCompanyTreeReference = {
			manifestSha256: object.sha256,
			manifestBytes: object.bytes,
			contractVersion: 3,
			fileCount: files.length,
			totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
		};
		const restore = await verifyCloudCompanyTreeRestore(this.identity.todo.companyId, reference, this.objects);
		const digest = createHash("sha256")
			.update(restore.objects.map((object) => `${object.sha256}:${object.bytes}`).join("\n"))
			.digest("hex");
		const bytes = restore.objects.reduce((sum, object) => sum + object.bytes, 0);
		const ownerClaims = { sub: this.identity.parent.requesterUserId, role: "authenticated" };
		const serviceClaims = { ...ownerClaims, role: "service_role" };
		const outputDigest = output
			? workerDigest([
					output.kind,
					output.worker.dispatch.workerId,
					output.worker.sequence,
					output.tool,
					output.entry,
				])
			: null;
		const outputBinding = output
			? {
					workerId: output.worker.dispatch.workerId,
					todo: output.worker.dispatch.todo,
					parentRunId: output.worker.dispatch.parent.runId,
					execution: output.worker.execution,
					delegation: output.worker.dispatch.delegation,
					epoch: output.worker.epoch,
					sequence: output.worker.sequence,
				}
			: null;
		if (guard) await this.beforeFilePublish?.(guard);
		return this.query<string>(`do $$ declare v_snapshot uuid; v_graph uuid; v_head uuid; v_output public.qorpera_run_operation_receipts%rowtype; begin
			select head_snapshot_id into v_head from public.qorpera_company_files where environment_id=${sqlValue(this.identity.todo.environmentId)} for update;
			if v_head is distinct from ${sqlValue(expectedHead)}::uuid then raise sqlstate 'PT409' using message='fixture head changed'; end if;
			${guard ? this.authoritySql(["cancel", "reconcile"].includes(guard.purpose)) : ""}
			${verifiedResults.flatMap((result) => (result.work.kind === "proposal" ? [`perform 1 from public.qorpera_company_proposals where id=${sqlValue(result.work.proposalId)} and profile_id=${sqlValue(result.todo.companyId)} and environment_id=${sqlValue(result.todo.environmentId)} and execution_kind='run' and execution_id=${sqlValue(result.execution.runId)} and proposal_snapshot_id=${sqlValue(result.work.sources[0].version)} and status in ('open','accepted') for share; if not found then raise exception 'proposal changed before result publication'; end if;`] : [])).join("\n")}
			${
				output
					? `select * into v_output from public.qorpera_run_operation_receipts where id=${sqlValue(output.receiptId)};
			if found then
				if v_output.status <> 'completed' or v_output.input_sha256 <> ${sqlValue(outputDigest)} then raise exception 'output operation identity changed'; end if;
				perform set_config('qorpera_test.worker_snapshot',coalesce(v_output.output_snapshot_id,(select proposal_snapshot_id from public.qorpera_company_proposals where id=v_output.proposal_id))::text,true); return;
			end if;`
					: ""
			}
			${restore.objects.map((item) => `insert into storage.objects(bucket_id,name,metadata) values ('qorpera-profile-objects',${sqlValue(`${this.identity.todo.companyId}/${item.sha256}`)},${sqlValue({ size: item.bytes })}::jsonb) on conflict (bucket_id,name) do nothing;`).join("\n")}
			v_snapshot := (public.${output?.kind === "proposal" ? "qorpera_prepare_company_file_proposal" : "qorpera_prepare_company_file_revision"}(${sqlValue(this.identity.todo.environmentId)},${sqlValue(clientId)},${sqlValue(expectedHead)},${sqlValue(object.sha256)},${object.bytes},3,${reference.fileCount},${reference.totalBytes})->>'snapshot_id')::uuid;
			v_graph := (public.qorpera_begin_object_reachability_graph('company_snapshot',v_snapshot,${sqlValue(workerStableId([clientId, "graph"]))},${sqlValue(object.sha256)},1,${sqlValue(digest)},${restore.objects.length},${bytes})->>'graph_id')::uuid;
			perform public.qorpera_append_object_reachability_entries(v_graph,${sqlValue(restore.objects)}::jsonb);
			perform public.qorpera_complete_object_reachability_graph(v_graph);
			perform set_config('request.jwt.claims',${sqlValue(serviceClaims)},true);
			perform public.qorpera_verify_company_snapshot_closure(v_snapshot,v_graph,${sqlValue(this.identity.parent.requesterUserId)},${sqlValue(digest)},${restore.objects.length},${bytes},${sqlValue(restore.restoredContentSha256)},${restore.restoredBytes},${sqlValue(EMPTY_SHA)});
			perform set_config('request.jwt.claims',${sqlValue(ownerClaims)},true);
			perform public.qorpera_create_object_restore_proof(v_graph,${sqlValue(workerStableId([clientId, "proof"]))},${sqlValue(restore.restoredContentSha256)},${restore.restoredBytes});
			${this.rollbackBeforePublish ? "raise exception 'test interrupted before publish';" : ""}
			${
				output?.kind === "proposal"
					? `insert into public.qorpera_company_proposals(id,profile_id,environment_id,client_proposal_id,base_snapshot_id,proposal_snapshot_id,execution_kind,execution_id,execution_claimant_id,session_id,trail_end_sequence,reason,title,reviewer_staff_ids,created_by_user_id)
			values (${sqlValue(output.proposalId)},${sqlValue(this.identity.todo.companyId)},${sqlValue(this.identity.todo.environmentId)},${sqlValue(clientId)},${sqlValue(expectedHead)},v_snapshot,'run',${sqlValue(output.worker.execution!.runId)},${sqlValue(output.worker.execution!.runId)},null,0,'policy','Bounded test worker proposal','{}',${sqlValue(this.identity.parent.requesterUserId)});`
					: `perform public.qorpera_publish_company_file_revision(${sqlValue(this.identity.todo.environmentId)},v_snapshot,${sqlValue(expectedHead)});`
			}
			${
				output
					? `insert into public.qorpera_run_operation_receipts(id,run_id,job_id,assignment_id,logical_operation_key,operation_kind,input_sha256,downstream_idempotency_sha256,status,result,completed_at,requires_company_revision,output_snapshot_id,proposal_id)
			select ${sqlValue(output.receiptId)},id,job_id,${sqlValue(this.identity.assignmentId)},${sqlValue(`output:${output.receiptId}`)},'test_worker_output',${sqlValue(outputDigest)},${sqlValue(workerDigest(output.receiptId))},'completed',jsonb_build_object('schema','test.worker-output/v1','kind',${sqlValue(output.kind)},'binding',${sqlValue(outputBinding)}::jsonb,'tool',${sqlValue(output.tool)}::jsonb,'entry',${sqlValue(output.entry)}::jsonb,'source',jsonb_build_object('objectId',${sqlValue(workerStableId([this.identity.todo.companyId, output.entry.path]))},'path',${sqlValue(output.entry.path)},'version',v_snapshot::text)),statement_timestamp(),true,${output.kind === "company-file" ? "v_snapshot" : "null"},${sqlValue(output.proposalId)} from public.qorpera_execution_runs where id=${sqlValue(this.identity.parent.runId)};`
					: ""
			}
			perform set_config('qorpera_test.worker_snapshot',v_snapshot::text,true);
		end $$; select to_jsonb(current_setting('qorpera_test.worker_snapshot'));`);
	}

	commandKey(request: WorkerRunRequest): string {
		return `worker:${request.dispatch.workerId}:${request.command.key}`;
	}

	continuationIdentity(intent: WorkerContinuation) {
		const { delivery: _delivery, receiptId: _receiptId, ...identity } = intent;
		return identity;
	}

	lookup<T>(key: string, digest: string): WorkerLookup<T> {
		const receipt = this.query<{
			id: string;
			input_sha256: string;
			status: string;
			result: T;
			recovery_resolution: string | null;
		} | null>(
			`select to_jsonb(receipt) from public.qorpera_run_operation_receipts as receipt where run_id=${sqlValue(this.identity.parent.runId)} and logical_operation_key=${sqlValue(key)};`,
		);
		if (!receipt) return { state: "uncertain" };
		if (receipt.input_sha256 !== digest) throw new Error("Receipt input changed");
		if (receipt.status === "completed") return { state: "confirmed", receipt: receipt.result };
		if (receipt.status === "cancelled" && receipt.recovery_resolution === "confirmed_not_run")
			return { state: "not-started", reconciliationReceiptId: receipt.id };
		return { state: "uncertain" };
	}

	/** Caller already read and verified the immutable bytes at head; lock/CAS and live grant checks serialize the effect. */
	async effect<T>(
		guard: WorkerEffectGuard,
		key: string,
		digest: string,
		kind: string,
		effectSql: (state: TreeState) => string,
	): Promise<T> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const state = await this.tree();
			this.validateGuard(guard, state);
			try {
				return this.query<T>(`do $$ declare v_head uuid; v_receipt public.qorpera_run_operation_receipts%rowtype; v_job public.qorpera_runner_jobs%rowtype; v_execution jsonb; v_result jsonb; begin
					select head_snapshot_id into v_head from public.qorpera_company_files where environment_id=${sqlValue(this.identity.todo.environmentId)} for update;
					if v_head is distinct from ${sqlValue(state.head)}::uuid then raise sqlstate 'PT409' using message='fixture head changed'; end if;
					${this.authoritySql(guard.purpose === "cancel")}
					select * into v_receipt from public.qorpera_run_operation_receipts where run_id=${sqlValue(this.identity.parent.runId)} and logical_operation_key=${sqlValue(key)} for update;
					if found then
						if v_receipt.input_sha256 <> ${sqlValue(digest)} or v_receipt.operation_kind <> ${sqlValue(kind)} then raise exception 'fixture operation conflict'; end if;
						if v_receipt.status='completed' then
							perform set_config('qorpera_test.worker_receipt',v_receipt.result::text,true); return;
						end if;
						if v_receipt.recovery_resolution is distinct from 'confirmed_not_run' then raise exception 'fixture operation ambiguous'; end if;
						update public.qorpera_run_operation_receipts set status='executing',completed_at=null where id=v_receipt.id;
					else
						insert into public.qorpera_run_operation_receipts(id,run_id,job_id,assignment_id,logical_operation_key,operation_kind,input_sha256,downstream_idempotency_sha256)
						select ${sqlValue(randomUUID())},id,job_id,${sqlValue(this.identity.assignmentId)},${sqlValue(key)},${sqlValue(kind)},${sqlValue(digest)},${sqlValue(workerDigest([this.identity.parent.runId, key]))} from public.qorpera_execution_runs where id=${sqlValue(this.identity.parent.runId)} returning * into v_receipt;
					end if;
					${effectSql(state)}
					update public.qorpera_run_operation_receipts set status='completed',completed_at=statement_timestamp(),result=v_result where id=v_receipt.id;
					perform set_config('qorpera_test.worker_receipt',v_result::text,true);
				end $$; select current_setting('qorpera_test.worker_receipt')::jsonb;`);
			} catch (error) {
				if (!(error instanceof WorkerTodoConflict)) throw error;
			}
		}
		throw new WorkerTodoConflict();
	}

	async submitRun(request: WorkerRunRequest): Promise<WorkerCommandReceipt> {
		const digest = workerRunRequestDigest(request);
		const runId = workerStableId([request.dispatch.workerId, "child-run"]);
		const streamId = workerStableId([request.dispatch.workerId, "child-stream"]);
		return this.effect(request.guard, this.commandKey(request), digest, "test_worker_command", (state) => {
			let effect: string;
			if (request.command.kind === "dispatch") {
				const substrateId = workerStableId([runId, state.head]);
				// Payload is a tied projection, not a duplicate work description or parent transcript.
				const payload = {
					schema: "test.worker-input/v1",
					todo: request.dispatch.todo,
					workerId: request.dispatch.workerId,
					version: state.head,
					inputSha256: digest,
				};
				effect = `${this.substrateSql(substrateId, state.head!)}
					perform public.qorpera_enqueue_execution_run(${sqlValue(runId)},${sqlValue(this.identity.todo.environmentId)},null,'system',${sqlValue(request.dispatch.workerId)},${sqlValue(substrateId)},${sqlValue(this.identity.parent.staffAgentId)},1,${sqlValue(this.identity.sponsorId)},1,'agent_turn','worker_component_test',${sqlValue(payload)}::jsonb);
					v_execution := ${sqlValue({ runId, streamId })}::jsonb;`;
			} else {
				const dispatchKey = `worker:${request.dispatch.workerId}:${request.dispatch.operationKey}`;
				effect = `select result->'execution' into v_execution from public.qorpera_run_operation_receipts where run_id=${sqlValue(this.identity.parent.runId)} and logical_operation_key=${sqlValue(dispatchKey)} and status='completed';`;
				if (request.command.kind === "followup")
					effect += `if v_execution is distinct from ${sqlValue(request.execution)}::jsonb then raise exception 'fixture followup continuity changed'; end if;`;
				else {
					// Sponsor revocation already terminalizes queued jobs as failed. Preserve
					// that outcome; an existing terminal lease fence proves this inert fixture
					// stopped, without issuing a cancellation RPC against a finished job.
					effect += `if v_execution is not null then
						select job.* into v_job from public.qorpera_runner_jobs as job join public.qorpera_execution_runs as run on run.job_id=job.id where run.id=(v_execution->>'runId')::uuid for update of job;
						if not found then raise exception 'fixture stop target is missing'; end if;
						if v_job.status not in ('completed','failed','cancelled') then perform public.qorpera_cancel_runner_job(v_job.id);
						elsif v_job.lease_token_sha256 is not null or v_job.lease_expires_at is not null then raise exception 'fixture terminal run still holds a lease'; end if;
					end if;`;
				}
			}
			return `${effect}
				v_result := jsonb_build_object('schema','qorpera.worker-command-receipt/v1','workerId',${sqlValue(request.dispatch.workerId)},'commandKey',${sqlValue(request.command.key)},'inputSha256',${sqlValue(digest)},'receiptId',v_receipt.id,'status',${sqlValue(request.command.kind === "cancel" ? "stopped" : "admitted")},'execution',v_execution);`;
		});
	}

	async submitContinuation(guard: WorkerEffectGuard, intent: WorkerContinuation): Promise<WorkerContinuationReceipt> {
		return this.effect(
			guard,
			`continuation:${intent.intentId}`,
			workerDigest(this.continuationIdentity(intent)),
			"test_worker_continuation",
			() =>
				`v_result := jsonb_build_object('schema','qorpera.worker-continuation-receipt/v1','intentId',${sqlValue(intent.intentId)},'parentRunId',${sqlValue(intent.parent.runId)},'todoId',${sqlValue(intent.todo.todoId)},'workerId',${sqlValue(intent.workerId)},'completionId',${sqlValue(intent.completionId)},'receiptId',v_receipt.id);`,
		);
	}

	substrateSql(id: string, head: string): string {
		return `insert into public.qorpera_company_substrate_versions(id,profile_id,environment_id,company_snapshot_id,client_version_id,contract_version,operation_sequence,operation_count,content_sha256,created_by_user_id) values (${sqlValue(id)},${sqlValue(this.identity.todo.companyId)},${sqlValue(this.identity.todo.environmentId)},${sqlValue(head)},${sqlValue(id)},1,0,0,${sqlValue(EMPTY_SHA)},${sqlValue(this.identity.parent.requesterUserId)});`;
	}

	result(
		worker: WorkerHandle,
		fillBudget = false,
		options: Partial<Pick<WorkerResult, "outcome" | "work">> = {},
	): WorkerResult {
		const result = workerResult(worker, options.outcome ?? "succeeded", fillBudget);
		if (options.work) {
			if (fillBudget) throw new Error("Budget padding is only supported for the default test result");
			result.work = options.work;
			result.summary = "The bounded worker output is durably stored.";
		}
		this.query(`insert into public.qorpera_run_operation_receipts(id,run_id,job_id,assignment_id,logical_operation_key,operation_kind,input_sha256,downstream_idempotency_sha256,status,result,completed_at)
			select ${sqlValue(result.receiptId)},id,job_id,${sqlValue(this.identity.assignmentId)},${sqlValue(`result:${result.completionId}`)},'test_worker_result',${sqlValue(workerDigest(result))},${sqlValue(workerDigest(result.completionId))},'completed',${sqlValue(result)}::jsonb,statement_timestamp() from public.qorpera_execution_runs where id=${sqlValue(this.identity.parent.runId)};`);
		return result;
	}
}

export async function createPostgresWorkerFixture(
	container: string,
	objectsDirectory: string,
): Promise<PostgresWorkerFixture> {
	const { todo, parent } = workerIdentities();
	parent.sessionId = null;
	const initial: DatabaseIdentity = { todo, parent, sponsorId: randomUUID(), assignmentId: randomUUID() };
	disposableSql(
		container,
		`insert into auth.users(id,email) values (${sqlValue(parent.requesterUserId)},${sqlValue(`${parent.requesterUserId}@worker-test.invalid`)});`,
	);
	let fixture = new PostgresWorkerFixture(container, objectsDirectory, initial);
	const company = fixture.query<{ profile_id: string; environment_id: string }>(
		`select public.qorpera_create_cloud_company(${sqlValue(randomUUID())},'Disposable worker component test',2);`,
	);
	initial.todo.companyId = company.profile_id;
	initial.todo.environmentId = company.environment_id;
	fixture = new PostgresWorkerFixture(container, objectsDirectory, initial);
	const source = await fixture.objects.putFile(
		company.profile_id,
		Buffer.from("Test source retained across every Company File revision.\n"),
		"application/octet-stream",
	);
	const head = await fixture.publish(
		[
			{ kind: "directory", path: "work" },
			{ kind: "file", path: "work/source.md", executable: false, file: source },
			{ kind: "directory", path: "work/todos" },
		],
		null,
		randomUUID(),
	);
	fixture.query(`insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
		values (${sqlValue(company.profile_id)},${sqlValue(parent.staffAgentId)},'Worker component fixture','Testing','No real model execution.','blue','round','active','active','openai','gpt-test',statement_timestamp(),statement_timestamp(),${sqlValue(parent.requesterUserId)});`);
	const provider = fixture.query<{ connection_id: string }>(
		`select public.qorpera_register_provider_connection(${sqlValue(company.profile_id)},${sqlValue(randomUUID())},null,'openai','api_key','openai-responses','vault://fixture-never-resolved/worker-test','acct_fixture','company-api-budget','qorpera-provider-consent/v1',null,'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}'::jsonb);`,
	);
	const sponsor = fixture.query<{ binding_id: string }>(
		`select public.qorpera_create_execution_sponsor_binding(${sqlValue(company.profile_id)},${sqlValue(randomUUID())},'company_api_billing',${sqlValue(provider.connection_id)},1,true);`,
	);
	initial.sponsorId = sponsor.binding_id;
	fixture = new PostgresWorkerFixture(container, objectsDirectory, initial);
	const substrateId = randomUUID();
	const orchestratorId = randomUUID();
	const claimId = randomUUID();
	const runnerId = randomUUID();
	fixture.query(`${fixture.substrateSql(substrateId, head)}
		do $$ declare v_job uuid; begin
			perform public.qorpera_enqueue_execution_run(${sqlValue(parent.runId)},${sqlValue(company.environment_id)},null,'system',${sqlValue(randomUUID())},${sqlValue(substrateId)},${sqlValue(parent.staffAgentId)},1,${sqlValue(sponsor.binding_id)},1,'agent_turn','parent_component_test','{}'::jsonb);
			select job_id into v_job from public.qorpera_execution_runs where id=${sqlValue(parent.runId)};
			insert into public.qorpera_runners(id,profile_id,client_runner_id,display_name,capabilities,activation_token_sha256,activation_expires_at,registered_by_user_id)
			values (${sqlValue(runnerId)},${sqlValue(company.profile_id)},${sqlValue(randomUUID())},'Inactive fixture runner','["agent_turn"]'::jsonb,${sqlValue(EMPTY_SHA)},statement_timestamp()+interval '1 hour',${sqlValue(parent.requesterUserId)});
			insert into public.qorpera_runner_orchestrators(id,display_name,provider_adapter,control_token_sha256,control_token_expires_at)
			values (${sqlValue(orchestratorId)},'Inactive fixture orchestrator','fixture',${sqlValue(EMPTY_SHA)},statement_timestamp()+interval '1 hour');
			insert into public.qorpera_runner_job_claims(id,orchestrator_id,client_claim_id,job_id,run_id,lease_expires_at)
			values (${sqlValue(claimId)},${sqlValue(orchestratorId)},${sqlValue(randomUUID())},v_job,${sqlValue(parent.runId)},statement_timestamp()+interval '1 hour');
			insert into public.qorpera_runner_assignments(id,claim_id,job_id,run_id,runner_id,capability_sha256,expires_at)
			values (${sqlValue(initial.assignmentId)},${sqlValue(claimId)},v_job,${sqlValue(parent.runId)},${sqlValue(runnerId)},${sqlValue(EMPTY_SHA)},statement_timestamp()+interval '1 hour');
		end $$;`);
	await fixture
		.lifecycle()
		.createTodo(
			{ goal: "Durable review", definitionOfDone: ["Parent accepts evidence"], sources: [] },
			"create",
			signal,
		);
	return fixture;
}
