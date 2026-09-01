import {
	type CompanyFileKnowledgeGateway,
	type CompanyFileKnowledgePreparation,
	type CompanyKnowledgeCollection,
	type CompanyKnowledgeMutationResult,
	type CompanyKnowledgeRetentionPolicy,
	type CompanyKnowledgeRun,
	CompanyKnowledgeSession,
} from "../../src/company-knowledge.ts";
import { parseCompanyMemoryObject } from "../../src/company-memory.ts";
import { type CompanySkillLoadRecord, parseCompanySkill } from "../../src/company-skills.ts";

export const signal: AbortSignal = new AbortController().signal;
export const budget = { maxBytes: 32 * 1024, maxItems: 32 };
export const retentionPolicy: CompanyKnowledgeRetentionPolicy = {
	id: "synthetic-preserve-policy",
	version: "policy-1",
	history: "preserve",
};
export const collections: CompanyKnowledgeCollection[] = [
	{ id: "company", path: "memory/company", kind: "memory", scope: { kind: "company_shared" } },
	{
		id: "project",
		path: "projects/project-1/memory",
		kind: "memory",
		scope: { kind: "project_scoped", projectId: "project-1" },
	},
	{ id: "room", path: "rooms/room-1/memory", kind: "memory", scope: { kind: "room_scoped", roomId: "room-1" } },
	{
		id: "member",
		path: "members/member-1/private/memory",
		kind: "memory",
		scope: { kind: "member_private", memberId: "member-1" },
	},
	{ id: "agent", path: "agents/agent-1/memory", kind: "memory", scope: { kind: "agent_private", agentId: "agent-1" } },
	{ id: "skills", path: "playbooks", kind: "skills", scope: { kind: "company_shared" } },
	{
		id: "agent-skills",
		path: "agents/agent-1/skills",
		kind: "skills",
		scope: { kind: "agent_private", agentId: "agent-1" },
	},
];

interface Entry {
	text: string;
	version: string;
}
interface Mutation {
	path: string;
	operationKey: string;
	expectedVersion: string | null;
	text: string;
}

interface Preparation {
	paths: Set<string>;
	versions: Map<string, string | null>;
	closed: boolean;
	abort: AbortController;
}

/** Synthetic transaction/ACL fixture only. It is not the Step-2 SQL gateway or cloud acceptance. */
export class SyntheticCompanyFile {
	readonly skillLoads = new Map<string, CompanySkillLoadRecord>();
	/** Synthetic canonical collection approvals, separate from the policy reference supplied to a session. */
	readonly approvedRetentionPolicies = new Map<string, Readonly<CompanyKnowledgeRetentionPolicy>>();
	readonly files = new Map<string, Entry>();
	/** In-memory history only; this fixture does not model GC or prove durable preservation. */
	readonly history = new Map<string, Entry[]>();
	readonly receipts = new Map<string, { input: string; result: CompanyKnowledgeMutationResult }>();
	readonly provenance: {
		actor: string;
		requester: string;
		sponsor: string;
		run: CompanyKnowledgeRun;
		receiptId: string;
	}[] = [];
	readonly proposals: Mutation[] = [];
	readonly heads = new Map<string, number>();
	readonly #runReadPaths = new Map<string, ReadonlySet<string>>();
	#sequence = 0;

	key(run: Pick<CompanyKnowledgeRun, "companyId" | "environmentId">, path: string): string {
		return JSON.stringify([run.companyId, run.environmentId, path]);
	}

	readPaths(run: CompanyKnowledgeRun): ReadonlySet<string> {
		return this.#runReadPaths.get(this.key(run, run.runId)) ?? new Set<string>();
	}

	/** Models the SQL transaction's durable per-run union, not a per-gateway allowance. */
	rememberReads(run: CompanyKnowledgeRun, paths: readonly string[]): void {
		const next = new Set([...this.readPaths(run), ...paths]);
		if (next.size > 128) throw new Error("Synthetic durable run read set is full");
		this.#runReadPaths.set(this.key(run, run.runId), next);
	}

	head(run: CompanyKnowledgeRun): string {
		return `snapshot-${this.heads.get(this.key(run, "")) ?? 0}`;
	}

	get(run: CompanyKnowledgeRun, path: string): Entry | undefined {
		return this.files.get(this.key(run, path));
	}

	put(run: CompanyKnowledgeRun, path: string, text: string, version = `version-${++this.#sequence}`): Entry {
		const key = this.key(run, path);
		const current = this.files.get(key);
		if (current) this.history.set(key, [...(this.history.get(key) ?? []), current]);
		const entry = { text, version };
		this.files.set(key, entry);
		this.heads.set(this.key(run, ""), (this.heads.get(this.key(run, "")) ?? 0) + 1);
		return entry;
	}

	remove(run: CompanyKnowledgeRun, path: string): void {
		const entry = this.get(run, path);
		if (entry) this.history.set(this.key(run, path), [...(this.history.get(this.key(run, path)) ?? []), entry]);
		this.files.delete(this.key(run, path));
		this.heads.set(this.key(run, ""), (this.heads.get(this.key(run, "")) ?? 0) + 1);
	}
}

export class SyntheticKnowledgeGateway implements CompanyFileKnowledgeGateway {
	readonly database: SyntheticCompanyFile;
	readonly run: CompanyKnowledgeRun;
	readonly supportedKnowledgeScopes = Object.freeze(collections.map((collection) => collection.scope.kind));
	readonly roots: Set<string>;
	readonly denied = new Set<string>();
	readonly audienceDenied = new Set<string>();
	readonly protectedPaths = new Set<string>();
	readonly reads: { path: string; offset: number; limit: number }[] = [];
	readonly lists: { path: string; after: string | null; snapshotId: string | null; limit: number }[] = [];
	readonly mutations: Mutation[] = [];
	readonly remembered = new Set<string>();
	readonly sourceChecks: { sources: readonly { path: string; version: string }[]; retained: readonly string[] }[] = [];
	assertions = 0;
	/** Simulated gateway method latency, not an estimate of deployed HTTP/RPC fanout. */
	requestLatencyMs = 0;
	inFlight = 0;
	peakInFlight = 0;
	active = true;
	failAfterCommit = false;
	beforeRead?: (path: string, offset: number) => Promise<void>;
	afterRead?: (path: string, offset: number) => Promise<void>;
	beforeMutate?: (input: Mutation) => Promise<void>;
	beforeAssert?: () => Promise<void>;

	constructor(database: SyntheticCompanyFile, run: CompanyKnowledgeRun, roots: readonly string[]) {
		this.database = database;
		this.run = Object.freeze({ ...run });
		this.roots = new Set(roots);
	}

	get identity(): Readonly<CompanyKnowledgeRun> {
		return this.run;
	}

	canRead(path: string): boolean {
		return (
			this.active &&
			[...this.roots].some((root) => path === root || path.startsWith(`${root}/`)) &&
			![...this.denied, ...this.audienceDenied].some((root) => path === root || path.startsWith(`${root}/`))
		);
	}

	assertPath(path: string): void {
		if (!this.canRead(path)) throw new Error("Synthetic denied path; never echo this diagnostic or synthetic-secret");
	}

	#remember(paths: readonly string[], preparation?: Preparation): void {
		if (preparation) {
			if (preparation.closed || new Set([...preparation.paths, ...paths]).size > 64)
				throw new Error("Synthetic candidate window unavailable");
			for (const path of paths) preparation.paths.add(path);
			return;
		}
		if (new Set([...this.remembered, ...paths]).size > 128)
			throw new Error("Synthetic shared-gateway cumulative context limit");
		this.database.rememberReads(this.run, paths);
		for (const path of paths) this.remembered.add(path);
	}

	async #pause(requestSignal: AbortSignal): Promise<void> {
		if (this.requestLatencyMs === 0) return;
		requestSignal.throwIfAborted();
		this.inFlight++;
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
		try {
			await new Promise<void>((resolve, reject) => {
				const aborted = (): void => {
					clearTimeout(timer);
					reject(new Error("Synthetic cancelled request"));
				};
				const timer = setTimeout(() => {
					requestSignal.removeEventListener("abort", aborted);
					resolve();
				}, this.requestLatencyMs);
				requestSignal.addEventListener("abort", aborted, { once: true });
			});
		} finally {
			this.inFlight--;
		}
	}

	async assertReadableContext(requestSignal: AbortSignal): Promise<void> {
		this.assertions++;
		await this.#pause(requestSignal);
		await this.beforeAssert?.();
		requestSignal.throwIfAborted();
		if (!this.active) throw new Error("Synthetic run revoked");
		for (const path of this.database.readPaths(this.run)) this.assertPath(path);
	}

	async #checkSources(
		sources: readonly { path: string; version: string }[],
		requestSignal: AbortSignal,
		preparation?: Preparation,
		retain = true,
	): Promise<void> {
		this.sourceChecks.push({ sources, retained: retain ? sources.map((source) => source.path) : [] });
		await this.assertReadableContext(requestSignal);
		if (sources.length > 64) throw new Error("Synthetic candidate bound");
		for (const path of preparation?.paths ?? []) this.assertPath(path);
		const expected = new Map(preparation?.versions);
		for (const source of sources) {
			if (preparation && preparation.versions.get(source.path) !== source.version)
				throw new Error("Synthetic source was not prepared");
			expected.set(source.path, source.version);
		}
		for (const [path, version] of expected) {
			this.assertPath(path);
			if ((this.database.get(this.run, path)?.version ?? null) !== version)
				throw new Error("Synthetic stale source");
		}
		if (retain) this.#remember(sources.map((source) => source.path));
	}

	assertCurrent(sources: readonly { path: string; version: string }[], signal: AbortSignal): Promise<void> {
		return this.#checkSources(sources, signal);
	}

	beginPreparation(): CompanyFileKnowledgePreparation {
		const preparation: Preparation = {
			paths: new Set(),
			versions: new Map(),
			closed: false,
			abort: new AbortController(),
		};
		const current = (signal: AbortSignal): AbortSignal => {
			if (preparation.closed) throw new Error("Synthetic preparation closed");
			return AbortSignal.any([signal, preparation.abort.signal]);
		};
		return {
			read: (path, offset, limit, signal) => this.#read(path, offset, limit, current(signal), preparation),
			list: (path, after, snapshotId, limit, signal) =>
				this.#list(path, after, snapshotId, limit, current(signal), preparation),
			assertReadableContext: (signal) => this.#checkSources([], current(signal), preparation, false),
			assertCurrent: (sources, signal) => {
				const requestSignal = current(signal);
				// The real gateway prepares metadata-only references before fencing them.
				for (const source of sources) {
					this.#remember([source.path], preparation);
					if (preparation.versions.has(source.path) && preparation.versions.get(source.path) !== source.version)
						throw new Error("Synthetic source changed during preparation");
					preparation.versions.set(source.path, source.version);
				}
				return this.#checkSources(sources, requestSignal, preparation, false);
			},
			retainSources: async (sources, signal) => {
				const requestSignal = current(signal);
				preparation.closed = true;
				await this.#checkSources(sources, requestSignal, preparation);
			},
			close: () => {
				preparation.closed = true;
				preparation.abort.abort();
			},
		};
	}

	async read(path: string, offset: number, limit: number, requestSignal: AbortSignal): Promise<unknown> {
		return this.#read(path, offset, limit, requestSignal);
	}

	async #read(
		path: string,
		offset: number,
		limit: number,
		requestSignal: AbortSignal,
		preparation?: Preparation,
	): Promise<unknown> {
		await this.#pause(requestSignal);
		await this.beforeRead?.(path, offset);
		requestSignal.throwIfAborted();
		this.assertPath(path);
		this.reads.push({ path, offset, limit });
		this.#remember([path], preparation);
		const entry = this.database.get(this.run, path);
		if (preparation) {
			if (preparation.versions.has(path) && preparation.versions.get(path) !== (entry?.version ?? null))
				throw new Error("Synthetic source changed during preparation");
			preparation.versions.set(path, entry?.version ?? null);
		}
		if (!entry) return { path, kind: "absent", version: null };
		const bytes = Buffer.from(entry.text);
		let end = Math.min(bytes.length, offset + limit);
		while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		const result = {
			path,
			kind: "file",
			version: entry.version,
			offset,
			bytesRead: end - offset,
			totalBytes: bytes.length,
			text: bytes.subarray(offset, end).toString("utf8"),
			nextOffset: end < bytes.length ? end : null,
		};
		await this.afterRead?.(path, offset);
		return result;
	}

	async list(
		path: string,
		after: string | null,
		snapshotId: string | null,
		limit: number,
		requestSignal: AbortSignal,
	): Promise<unknown> {
		return this.#list(path, after, snapshotId, limit, requestSignal);
	}

	async #list(
		path: string,
		after: string | null,
		snapshotId: string | null,
		limit: number,
		requestSignal: AbortSignal,
		preparation?: Preparation,
	): Promise<unknown> {
		await this.#pause(requestSignal);
		requestSignal.throwIfAborted();
		this.assertPath(path);
		this.lists.push({ path, after, snapshotId, limit });
		const head = this.database.head(this.run);
		if (snapshotId !== null && snapshotId !== head) throw new Error("Synthetic stale page");
		const all = [...this.database.files]
			.flatMap(([key, entry]) => {
				const [companyId, environmentId, entryPath] = JSON.parse(key) as string[];
				if (
					companyId !== this.run.companyId ||
					environmentId !== this.run.environmentId ||
					entryPath.slice(0, entryPath.lastIndexOf("/")) !== path ||
					!this.canRead(entryPath) ||
					(after !== null && Buffer.compare(Buffer.from(entryPath), Buffer.from(after)) <= 0)
				)
					return [];
				return [{ path: entryPath, kind: "file", version: entry.version, bytes: Buffer.byteLength(entry.text) }];
			})
			.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
		const items = all.slice(0, limit);
		this.#remember([path, ...items.map((item) => item.path)], preparation);
		if (preparation) {
			for (const item of items) {
				if (preparation.versions.has(item.path) && preparation.versions.get(item.path) !== item.version)
					throw new Error("Synthetic source changed during preparation");
				preparation.versions.set(item.path, item.version);
			}
		}
		return {
			snapshotId: head,
			items,
			hasMore: all.length > items.length,
			nextAfter: all.length > items.length ? items.at(-1)!.path : null,
		};
	}

	async mutate(operation: "write", input: Mutation, requestSignal: AbortSignal): Promise<unknown> {
		if (operation !== "write") throw new Error("Unexpected synthetic operation");
		this.mutations.push({ ...input });
		await this.beforeMutate?.(input);
		requestSignal.throwIfAborted();
		this.assertPath(input.path);
		for (const path of this.database.readPaths(this.run)) this.assertPath(path);
		const key = this.database.key(this.run, `${this.run.runId}:${input.operationKey}`);
		const old = this.database.receipts.get(key);
		if (old) {
			if (old.input !== JSON.stringify(input)) throw new Error("Synthetic receipt plan conflict");
			return { ...old.result };
		}
		const current = this.database.get(this.run, input.path);
		if ((current?.version ?? null) !== input.expectedVersion) throw new Error("Synthetic stale version");
		const document = input.path.endsWith(".md")
			? parseCompanySkill(input.text).header
			: parseCompanyMemoryObject(JSON.parse(input.text));
		if (document.state === "forgotten") {
			const collectionPath = input.path.slice(0, input.path.lastIndexOf("/"));
			const approved = this.database.approvedRetentionPolicies.get(this.database.key(this.run, collectionPath));
			const requested = document.retentionPolicy;
			if (
				!approved ||
				approved.id !== requested.id ||
				approved.version !== requested.version ||
				approved.history !== requested.history
			)
				throw new Error("Synthetic retention policy approval is missing or changed");
		}
		const protectedPath = this.protectedPaths.has(input.path);
		const next = protectedPath ? current : this.database.put(this.run, input.path, input.text);
		if (protectedPath) this.database.proposals.push({ ...input });
		const result: CompanyKnowledgeMutationResult = {
			schema: "qorpera.company-path-result/v1",
			state: protectedPath ? "proposed" : "applied",
			operationKey: input.operationKey,
			path: input.path,
			version: next?.version ?? null,
			snapshotId: protectedPath ? null : this.database.head(this.run),
			receiptId: `receipt-${this.database.receipts.size + 1}`,
			proposalId: protectedPath ? `proposal-${this.database.proposals.length}` : null,
		};
		this.database.receipts.set(key, { input: JSON.stringify(input), result });
		this.database.provenance.push({
			actor: "agent-1",
			requester: "member-1",
			sponsor: "member-2",
			run: this.run,
			receiptId: result.receiptId,
		});
		if (this.failAfterCommit) {
			this.failAfterCommit = false;
			throw new Error("Synthetic response lost after durable success");
		}
		return { ...result };
	}
}

/** Fixture syntax guard only. Production must inject parseCloudCompanyPath from Step 2. */
export function parseSyntheticPath(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/.test(value))
		throw new Error("Invalid synthetic root");
	return value;
}

export function knowledgeFixture(
	options: {
		database?: SyntheticCompanyFile;
		companyId?: string;
		environmentId?: string;
		runId?: string;
		collections?: readonly CompanyKnowledgeCollection[];
		roots?: readonly string[];
		retentionPolicy?: CompanyKnowledgeRetentionPolicy | null;
		readConcurrency?: number;
	} = {},
) {
	const selected = options.collections ?? collections;
	const database = options.database ?? new SyntheticCompanyFile();
	const run: CompanyKnowledgeRun = {
		companyId: options.companyId ?? "company-1",
		environmentId: options.environmentId ?? "environment-1",
		runId: options.runId ?? "run-1",
		runtimeBundleVersion: "runtime-1",
	};
	// Seed explicit fixture approvals only for a new database. A host policy override
	// or a reconstructed gateway must never approve a policy or restore a revoked one.
	if (!options.database) {
		for (const collection of selected)
			database.approvedRetentionPolicies.set(
				database.key(run, collection.path),
				Object.freeze({ ...retentionPolicy }),
			);
	}
	const gateway = new SyntheticKnowledgeGateway(
		database,
		run,
		options.roots ?? selected.map((collection) => collection.path),
	);
	const session = new CompanyKnowledgeSession({
		run,
		gateway,
		parsePath: parseSyntheticPath,
		collections: selected,
		retentionPolicy: options.retentionPolicy === null ? undefined : (options.retentionPolicy ?? retentionPolicy),
		readConcurrency: options.readConcurrency,
	});
	const assertRecordedLoad = async (record: CompanySkillLoadRecord): Promise<void> => {
		if (JSON.stringify(database.skillLoads.get(record.loadKey)) !== JSON.stringify(record))
			throw new Error("Synthetic durable skill load is missing or changed");
	};
	return { database, run, gateway, session, assertRecordedLoad };
}
