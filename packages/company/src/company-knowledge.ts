import { createHash } from "node:crypto";

/** Company File service bindings for memory and playbooks, not a persistence or authority implementation. */
export const COMPANY_KNOWLEDGE_MAX_OBJECT_BYTES = 32 * 1024;
/** Contribution/load capacity, never a limit on the size of a Company File collection. */
export const COMPANY_KNOWLEDGE_MAX_OBJECTS = 64;
export const COMPANY_KNOWLEDGE_SCAN_ENTRIES = 32;

export type CompanyKnowledgeScope =
	| { kind: "company_shared" }
	| { kind: "project_scoped"; projectId: string }
	| { kind: "room_scoped"; roomId: string }
	| { kind: "agent_private"; agentId: string }
	| { kind: "member_private"; memberId: string };

export interface CompanyKnowledgeRun {
	companyId: string;
	environmentId: string;
	runId: string;
	runtimeBundleVersion: string;
}

export type CompanyKnowledgeIdentity = Pick<CompanyKnowledgeRun, "companyId" | "environmentId" | "runId">;

/** Supplied by the host from authorized Company File resources, never from file contents or tool arguments. */
export interface CompanyKnowledgeCollection {
	id: string;
	path: string;
	kind: "memory" | "skills";
	scope: CompanyKnowledgeScope;
}

/**
 * Structural subset of Step 2's CloudCompanyPathGateway. Pass the real, run-bound
 * gateway with the Step-6 preparation extension. SQL owns path/audience checks,
 * CAS, proposals and receipts. Only emitted preparation sources enter the
 * durable 128-path run read set; ordinary native reads keep their existing fence.
 * Unknown results are deliberately parsed here using the existing gateway wire shapes.
 */
export interface CompanyFileKnowledgeReader {
	read(path: string, offset: number, limit: number, signal: AbortSignal): Promise<unknown>;
	list(
		path: string,
		after: string | null,
		snapshotId: string | null,
		limit: number,
		signal: AbortSignal,
	): Promise<unknown>;
	assertReadableContext(signal: AbortSignal): Promise<void>;
	assertCurrent(
		sources: readonly { path: string; version: string }[],
		signal: AbortSignal,
		collections?: readonly CompanyKnowledgeCollection[],
	): Promise<void>;
}

/** Host-only candidate reader. No mutation, grant, native tool or durable read-set reset. */
export interface CompanyFileKnowledgePreparation extends CompanyFileKnowledgeReader {
	retainSources(
		sources: readonly { path: string; version: string }[],
		signal: AbortSignal,
		collections?: readonly CompanyKnowledgeCollection[],
	): Promise<void>;
	close(): void;
}

export interface CompanyFileKnowledgeGateway extends CompanyFileKnowledgeReader {
	/** Immutable identity of the admitted gateway, not caller-provided attribution. */
	readonly identity: Readonly<CompanyKnowledgeIdentity>;
	/** Implemented scope kinds only. This is a capability declaration, never a read grant. */
	readonly supportedKnowledgeScopes: readonly CompanyKnowledgeScope["kind"][];
	beginPreparation(): CompanyFileKnowledgePreparation;
	/** The shared mutation/approval transaction must verify tombstone policy references against live canonical approval. */
	mutate(
		operation: "write",
		input: { path: string; operationKey: string; expectedVersion: string | null; text: string },
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface CompanyKnowledgeSource {
	kind: "company_file";
	companyId: string;
	environmentId: string;
	collectionId: string;
	objectId: string;
	path: string;
	version: string;
	scope: CompanyKnowledgeScope;
	trust: "untrusted_data";
	authority: "none";
}

/** Existing qorpera.company-path-result/v1 receipt, not a new effect ledger. */
export interface CompanyKnowledgeMutationResult {
	schema: "qorpera.company-path-result/v1";
	state: "applied" | "proposed";
	operationKey: string;
	path: string;
	version: string | null;
	snapshotId: string | null;
	receiptId: string;
	proposalId: string | null;
}

/**
 * Reference to a human-approved Company File preservation policy, not an approval or retention mechanism.
 * The shared mutation/approval transaction must match it to the collection's current canonical binding
 * and preserve committed history through Company File retention roots. No implicit expiry or purge.
 */
export interface CompanyKnowledgeRetentionPolicy {
	id: string;
	version: string;
	history: "preserve";
}

export interface CompanyKnowledgeBudget {
	/** UTF-8 bytes of the entire JSON contribution, including attribution and escaping. */
	maxBytes: number;
	maxItems: number;
}

/** A position, not a grant. Resume with the same run/collections and reauthorize every page. */
export interface CompanyKnowledgeScanCursor {
	schema: "qorpera.knowledge-scan/v1";
	binding: string;
	collection: number;
	after: string | null;
	snapshotId: string | null;
	limit: number;
}

export interface CompanyKnowledgeScanOptions {
	collectionIds?: readonly string[];
	cursor?: CompanyKnowledgeScanCursor;
	/** Raw directory entries, including tombstones/unrecognized files. Each call advances past them. */
	maxScanEntries?: number;
}

/** Only this visited interval may be reconciled; an unfinished scan says nothing about later paths. */
export interface CompanyKnowledgeScanSpan {
	path: string;
	after: string | null;
	through: string | null;
}

export interface CompanyKnowledgeScanPage {
	items: (CompanyKnowledgeListedObject & { collectionId: string })[];
	spans: CompanyKnowledgeScanSpan[];
	scanned: number;
	start: CompanyKnowledgeScanCursor;
	next: CompanyKnowledgeScanCursor | null;
}

export type CompanyKnowledgeErrorCode =
	| "invalid_request"
	| "invalid_object"
	| "source_changed"
	| "budget_exceeded"
	| "access_unavailable"
	| "operation_unconfirmed"
	| "retention_policy_required"
	| "platform_read_only"
	| "record_unavailable"
	| "scope_unsupported"
	| "cancelled";

export class CompanyKnowledgeError extends Error {
	readonly code: CompanyKnowledgeErrorCode;

	constructor(code: CompanyKnowledgeErrorCode) {
		super(`Company knowledge: ${code}`);
		this.code = code;
	}
}

/** Bounds host adapters even when they ignore cancellation. A timed-out mutation remains unconfirmed. */
export async function knowledgeRequest<T>(
	action: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal,
	failure: CompanyKnowledgeErrorCode = "access_unavailable",
): Promise<T> {
	if (signal.aborted) throw new CompanyKnowledgeError("cancelled");
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, 30_000);
	let rejectAbort: () => void = () => undefined;
	const cancellation = new Promise<never>((_resolve, reject) => {
		rejectAbort = () => reject(new CompanyKnowledgeError(signal.aborted ? "cancelled" : failure));
		controller.signal.addEventListener("abort", rejectAbort, { once: true });
	});
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => {
				if (controller.signal.aborted) throw new CompanyKnowledgeError("cancelled");
				return action(controller.signal);
			}),
			cancellation,
		]);
		if (controller.signal.aborted) throw new CompanyKnowledgeError("cancelled");
		return result;
	} catch {
		throw new CompanyKnowledgeError(signal.aborted ? "cancelled" : failure);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", rejectAbort);
	}
}

/** Aggregate preparation deadline, in addition to the individual adapter-call ceiling. */
export async function prepareKnowledge<T>(
	maxMilliseconds: number,
	signal: AbortSignal,
	action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	knowledgeInteger(maxMilliseconds, 1, 30_000);
	if (signal.aborted) throw new CompanyKnowledgeError("cancelled");
	const deadline = new AbortController();
	const started = performance.now();
	const timer = setTimeout(() => deadline.abort(), maxMilliseconds);
	try {
		const result = await action(AbortSignal.any([signal, deadline.signal]));
		if (signal.aborted) throw new CompanyKnowledgeError("cancelled");
		if (deadline.signal.aborted || performance.now() - started >= maxMilliseconds)
			throw new CompanyKnowledgeError("budget_exceeded");
		return result;
	} catch (error) {
		if (signal.aborted) throw new CompanyKnowledgeError("cancelled");
		if (deadline.signal.aborted) throw new CompanyKnowledgeError("budget_exceeded");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export function knowledgeObject(
	value: unknown,
	keys: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
	)
		throw new CompanyKnowledgeError("invalid_object");
	return value as Record<string, unknown>;
}

export function knowledgeText(value: unknown, maxBytes: number, allowEmpty = false): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && !value.trim()) ||
		Buffer.byteLength(value) > maxBytes ||
		Buffer.from(value).toString("utf8") !== value
	)
		throw new CompanyKnowledgeError("invalid_object");
	return value;
}

export function knowledgeVersion(value: unknown): string {
	const text = knowledgeText(value, 256);
	if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new CompanyKnowledgeError("invalid_object");
	return text;
}

export function knowledgeDigest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new CompanyKnowledgeError("invalid_object");
	return value;
}

/** Bounded validation fingerprints only: no content, grants, retention or source of truth. */
export class CompanyKnowledgeFingerprints {
	readonly #entries = new Set<string>();

	has(value: unknown): boolean {
		return this.#entries.has(createHash("sha256").update(JSON.stringify(value)).digest("hex"));
	}

	add(value: unknown): void {
		this.#entries.add(createHash("sha256").update(JSON.stringify(value)).digest("hex"));
		while (this.#entries.size > COMPANY_KNOWLEDGE_MAX_OBJECTS)
			this.#entries.delete(this.#entries.values().next().value!);
	}
}

export function knowledgeInteger(value: unknown, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new CompanyKnowledgeError("invalid_request");
	return value as number;
}

export function knowledgeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new CompanyKnowledgeError("invalid_object");
	}
}

/** Shape validation only; file contents and session options cannot approve a preservation policy. */
export function parseKnowledgeRetentionPolicy(value: unknown): CompanyKnowledgeRetentionPolicy {
	const policy = knowledgeObject(value, ["id", "version", "history"]);
	if (policy.history !== "preserve") throw new CompanyKnowledgeError("retention_policy_required");
	return Object.freeze({
		id: knowledgeVersion(policy.id),
		version: knowledgeVersion(policy.version),
		history: "preserve",
	});
}

/** Deterministic byte budget, with no provider-token estimate disguised as a tokenizer. */
export function checkKnowledgeBudget(budget: CompanyKnowledgeBudget): void {
	knowledgeInteger(budget.maxBytes, 0, 64 * 1024);
	knowledgeInteger(budget.maxItems, 0, COMPANY_KNOWLEDGE_MAX_OBJECTS);
}

/** Shape only. Scan binds this host-only position to its run, collections and live snapshot. */
export function parseKnowledgeScanCursor(value: unknown): CompanyKnowledgeScanCursor {
	const data = knowledgeObject(value, ["schema", "binding", "collection", "after", "snapshotId", "limit"]);
	if (data.schema !== "qorpera.knowledge-scan/v1" || (data.after !== null && data.snapshotId === null))
		throw new CompanyKnowledgeError("invalid_request");
	return Object.freeze({
		schema: data.schema,
		binding: knowledgeDigest(data.binding),
		collection: knowledgeInteger(data.collection, 0, 15),
		after: data.after === null ? null : knowledgeText(data.after, 4096),
		snapshotId: data.snapshotId === null ? null : knowledgeVersion(data.snapshotId),
		limit: knowledgeInteger(data.limit, 1, COMPANY_KNOWLEDGE_SCAN_ENTRIES),
	});
}

/** Includes the enclosing contribution in the measurement and never splits a Unicode code point. */
export function fitKnowledgeText<T>(
	text: string,
	maxBytes: number,
	build: (text: string, truncated: boolean) => T,
): T | undefined {
	const full = build(text, false);
	if (Buffer.byteLength(JSON.stringify(full)) <= maxBytes) return full;
	const points = Array.from(text);
	let low = 0;
	let high = points.length - 1;
	let best: T | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = build(points.slice(0, middle).join(""), true);
		if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
			best = candidate;
			low = middle + 1;
		} else high = middle - 1;
	}
	return best;
}

function scope(value: unknown): CompanyKnowledgeScope {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanyKnowledgeError("invalid_request");
	const input = value as Record<string, unknown>;
	switch (input.kind) {
		case "company_shared":
			knowledgeObject(input, ["kind"]);
			return Object.freeze({ kind: input.kind });
		case "project_scoped":
			knowledgeObject(input, ["kind", "projectId"]);
			return Object.freeze({ kind: input.kind, projectId: knowledgeVersion(input.projectId) });
		case "room_scoped":
			knowledgeObject(input, ["kind", "roomId"]);
			return Object.freeze({ kind: input.kind, roomId: knowledgeVersion(input.roomId) });
		case "agent_private":
			knowledgeObject(input, ["kind", "agentId"]);
			return Object.freeze({ kind: input.kind, agentId: knowledgeVersion(input.agentId) });
		case "member_private":
			knowledgeObject(input, ["kind", "memberId"]);
			return Object.freeze({ kind: input.kind, memberId: knowledgeVersion(input.memberId) });
		default:
			throw new CompanyKnowledgeError("invalid_request");
	}
}

export interface CompanyKnowledgeListedObject {
	id: string;
	path: string;
	version: string;
	bytes: number;
}

type KnowledgeRange =
	| { kind: "absent" | "directory"; version: string | null }
	| { kind: "file"; version: string; text: string; totalBytes: number; nextOffset: number | null };

export type CompanyKnowledgeRead =
	| { kind: "absent"; version: string | null }
	| { kind: "file"; source: CompanyKnowledgeSource; text: string; totalBytes: number };

/** One admitted run. No filesystem, credentials, model API, background executor or default allow rule. */
export class CompanyKnowledgeSession {
	readonly #run: Readonly<CompanyKnowledgeRun>;
	readonly #gateway: CompanyFileKnowledgeGateway;
	#reader: CompanyFileKnowledgeReader;
	#preparing = false;
	readonly #parsePath: (value: unknown) => string;
	readonly #collections = new Map<string, Readonly<CompanyKnowledgeCollection>>();
	readonly #retentionPolicy: CompanyKnowledgeRetentionPolicy | undefined;
	readonly #readConcurrency: number;

	constructor(options: {
		run: CompanyKnowledgeRun;
		gateway: CompanyFileKnowledgeGateway;
		/** Inject Step 2's parseCloudCompanyPath; this package does not clone its path normalization rules. */
		parsePath: (value: unknown) => string;
		collections: readonly CompanyKnowledgeCollection[];
		/** Host-selected reference only. Forget remains subject to current canonical approval at commit. */
		retentionPolicy?: CompanyKnowledgeRetentionPolicy;
		/** Independent read/fence calls only; writes and ranges within one object stay ordered. */
		readConcurrency?: number;
	}) {
		const identity = options.gateway.identity;
		if (
			!identity ||
			["companyId", "environmentId", "runId"].some(
				(key) =>
					identity[key as keyof CompanyKnowledgeIdentity] !== options.run[key as keyof CompanyKnowledgeIdentity],
			)
		)
			throw new CompanyKnowledgeError("invalid_request");
		this.#run = Object.freeze({
			companyId: knowledgeVersion(identity.companyId),
			environmentId: knowledgeVersion(identity.environmentId),
			runId: knowledgeVersion(identity.runId),
			runtimeBundleVersion: knowledgeVersion(options.run.runtimeBundleVersion),
		});
		this.#gateway = options.gateway;
		this.#reader = options.gateway;
		this.#parsePath = options.parsePath;
		this.#readConcurrency = knowledgeInteger(options.readConcurrency ?? 4, 1, 8);
		knowledgeInteger(options.collections.length, 0, 16);
		for (const collection of options.collections) {
			if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(collection.id) || this.#collections.has(collection.id))
				throw new CompanyKnowledgeError("invalid_request");
			let path: string;
			try {
				path = options.parsePath(collection.path);
			} catch {
				throw new CompanyKnowledgeError("invalid_request");
			}
			if (!path || path !== collection.path || (collection.kind !== "memory" && collection.kind !== "skills"))
				throw new CompanyKnowledgeError("invalid_request");
			for (const existing of this.#collections.values()) {
				if (existing.path === path || existing.path.startsWith(`${path}/`) || path.startsWith(`${existing.path}/`))
					throw new CompanyKnowledgeError("invalid_request");
			}
			const collectionScope = scope(collection.scope);
			if (!options.gateway.supportedKnowledgeScopes.includes(collectionScope.kind))
				throw new CompanyKnowledgeError("scope_unsupported");
			if (collection.kind === "skills" && !["company_shared", "agent_private"].includes(collectionScope.kind))
				throw new CompanyKnowledgeError("invalid_request");
			this.#collections.set(collection.id, Object.freeze({ ...collection, path, scope: collectionScope }));
		}
		this.#retentionPolicy = options.retentionPolicy
			? parseKnowledgeRetentionPolicy(options.retentionPolicy)
			: undefined;
	}

	get run(): Readonly<CompanyKnowledgeRun> {
		return this.#run;
	}

	/** Bind restored attribution to this admitted run without accepting extra instruction fields. */
	checkRun(value: unknown): Readonly<CompanyKnowledgeRun> {
		const data = knowledgeObject(value, ["companyId", "environmentId", "runId", "runtimeBundleVersion"]);
		if (Object.entries(this.run).some(([key, expected]) => data[key] !== expected))
			throw new CompanyKnowledgeError("invalid_request");
		return this.run;
	}

	collections(kind: CompanyKnowledgeCollection["kind"]): readonly Readonly<CompanyKnowledgeCollection>[] {
		return [...this.#collections.values()].filter((collection) => collection.kind === kind);
	}

	collection(id: string, kind?: CompanyKnowledgeCollection["kind"]): Readonly<CompanyKnowledgeCollection> {
		const collection = this.#collections.get(id);
		if (!collection || (kind && collection.kind !== kind)) throw new CompanyKnowledgeError("invalid_request");
		return collection;
	}

	path(collectionId: string, id: string): string {
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new CompanyKnowledgeError("invalid_request");
		const collection = this.collection(collectionId);
		return `${collection.path}/${id}.${collection.kind === "memory" ? "json" : "md"}`;
	}

	/** Parse attribution, not authorization. Every use still needs a live source fence. */
	source(value: unknown, kind?: CompanyKnowledgeCollection["kind"]): CompanyKnowledgeSource {
		const data = knowledgeObject(value, [
			"kind",
			"companyId",
			"environmentId",
			"collectionId",
			"objectId",
			"path",
			"version",
			"scope",
			"trust",
			"authority",
		]);
		const collection = this.collection(knowledgeVersion(data.collectionId), kind);
		const objectId = knowledgeVersion(data.objectId);
		const path = this.path(collection.id, objectId);
		if (
			data.companyId !== this.run.companyId ||
			data.environmentId !== this.run.environmentId ||
			data.path !== path ||
			JSON.stringify(scope(data.scope)) !== JSON.stringify(collection.scope) ||
			data.kind !== "company_file" ||
			data.trust !== "untrusted_data" ||
			data.authority !== "none"
		)
			throw new CompanyKnowledgeError("invalid_request");
		return Object.freeze({
			kind: "company_file",
			companyId: this.run.companyId,
			environmentId: this.run.environmentId,
			collectionId: collection.id,
			objectId,
			path,
			version: knowledgeVersion(data.version),
			scope: collection.scope,
			trust: "untrusted_data",
			authority: "none",
		});
	}

	/** Returns the requested policy reference; the gateway must independently verify current approval. */
	retentionPolicy(): CompanyKnowledgeRetentionPolicy {
		if (!this.#retentionPolicy) throw new CompanyKnowledgeError("retention_policy_required");
		return this.#retentionPolicy;
	}

	async assertAccess(signal: AbortSignal): Promise<void> {
		await knowledgeRequest(
			(requestSignal) => this.#reader.assertCurrent([], requestSignal, [...this.#collections.values()]),
			signal,
		);
	}

	/** Retain an exact bounded contribution before releasing it; always dispose candidate access. */
	async prepare<T>(
		action: (session: CompanyKnowledgeSession) => Promise<{ value: T; sources: readonly CompanyKnowledgeSource[] }>,
		signal: AbortSignal,
	): Promise<T> {
		if (this.#preparing) throw new CompanyKnowledgeError("invalid_request");
		if (signal.aborted) throw new CompanyKnowledgeError("cancelled");
		const reader = this.#gateway.beginPreparation();
		try {
			const session = new CompanyKnowledgeSession({
				run: this.run,
				gateway: this.#gateway,
				parsePath: this.#parsePath,
				collections: [...this.#collections.values()],
				retentionPolicy: this.#retentionPolicy,
				readConcurrency: this.#readConcurrency,
			});
			session.#reader = reader;
			session.#preparing = true;
			const result = await action(session);
			const sources = session.#sourceReferences(result.sources);
			await knowledgeRequest(
				(requestSignal) => reader.retainSources(sources, requestSignal, [...this.#collections.values()]),
				signal,
			);
			return result.value;
		} finally {
			reader.close();
		}
	}

	/** One bounded gateway page; preparation does not retain discarded candidates. */
	async list(
		collectionId: string,
		input: { after: string | null; snapshotId: string | null; limit: number },
		signal: AbortSignal,
	): Promise<{
		items: CompanyKnowledgeListedObject[];
		scanned: number;
		snapshotId: string;
		nextAfter: string | null;
	}> {
		const collection = this.collection(collectionId);
		let after = input.after === null ? null : knowledgeText(input.after, 4096);
		const snapshotId = input.snapshotId === null ? null : knowledgeVersion(input.snapshotId);
		const limit = knowledgeInteger(input.limit, 1, COMPANY_KNOWLEDGE_SCAN_ENTRIES);
		if (after !== null && (snapshotId === null || after.slice(0, after.lastIndexOf("/")) !== collection.path))
			throw new CompanyKnowledgeError("invalid_request");
		const output: CompanyKnowledgeListedObject[] = [];
		const page = knowledgeObject(
			await knowledgeRequest(
				(requestSignal) => this.#reader.list(collection.path, after, snapshotId, limit, requestSignal),
				signal,
			),
			["snapshotId", "items", "hasMore", "nextAfter"],
		);
		const nextSnapshot = knowledgeVersion(page.snapshotId);
		if (snapshotId !== null && snapshotId !== nextSnapshot) throw new CompanyKnowledgeError("source_changed");
		if (!Array.isArray(page.items) || page.items.length > limit || typeof page.hasMore !== "boolean")
			throw new CompanyKnowledgeError("invalid_object");
		for (const value of page.items) {
			const item = knowledgeObject(value, ["path", "version", "kind", "bytes"]);
			const path = knowledgeText(item.path, 4096);
			if (
				path.slice(0, path.lastIndexOf("/")) !== collection.path ||
				(after !== null && Buffer.compare(Buffer.from(path), Buffer.from(after)) <= 0) ||
				(item.kind !== "file" && item.kind !== "directory")
			)
				throw new CompanyKnowledgeError("invalid_object");
			after = path;
			const version = knowledgeVersion(item.version);
			if (item.kind === "directory") {
				if (item.bytes !== null) throw new CompanyKnowledgeError("invalid_object");
				continue;
			}
			const bytes = knowledgeInteger(item.bytes, 0, 1024 ** 4);
			const suffix = collection.kind === "memory" ? ".json" : ".md";
			const name = path.slice(collection.path.length + 1);
			const id = name.slice(0, -suffix.length);
			if (!name.endsWith(suffix) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) continue;
			if (bytes > COMPANY_KNOWLEDGE_MAX_OBJECT_BYTES) throw new CompanyKnowledgeError("budget_exceeded");
			output.push({ id, path, version, bytes });
		}
		if (page.nextAfter !== (page.hasMore ? after : null) || (page.hasMore && page.items.length === 0))
			throw new CompanyKnowledgeError("invalid_object");
		await this.assertAccess(signal);
		return {
			items: output,
			scanned: page.items.length,
			snapshotId: nextSnapshot,
			nextAfter: page.nextAfter as string | null,
		};
	}

	/** Bounded window across explicit collections, resumable even when every visited item is a tombstone. */
	async scan(
		kind: CompanyKnowledgeCollection["kind"],
		input: CompanyKnowledgeScanOptions,
		signal: AbortSignal,
	): Promise<CompanyKnowledgeScanPage> {
		const ids = [...(input.collectionIds ?? this.collections(kind).map((collection) => collection.id))];
		knowledgeInteger(ids.length, 0, 16);
		if (new Set(ids).size !== ids.length) throw new CompanyKnowledgeError("invalid_request");
		const collections = ids.map((id) => this.collection(id, kind));
		const limit = knowledgeInteger(
			input.maxScanEntries ?? input.cursor?.limit ?? COMPANY_KNOWLEDGE_SCAN_ENTRIES,
			1,
			COMPANY_KNOWLEDGE_SCAN_ENTRIES,
		);
		const binding = createHash("sha256")
			.update(
				JSON.stringify([
					this.run,
					kind,
					collections.map((collection) => [collection.id, collection.path, collection.kind, collection.scope]),
					limit,
				]),
			)
			.digest("hex");
		let start: CompanyKnowledgeScanCursor = {
			schema: "qorpera.knowledge-scan/v1",
			binding,
			collection: 0,
			after: null,
			snapshotId: null,
			limit,
		};
		if (input.cursor) {
			const cursor = parseKnowledgeScanCursor(input.cursor);
			if (cursor.schema !== start.schema || cursor.binding !== binding || cursor.limit !== limit)
				throw new CompanyKnowledgeError("invalid_request");
			start = {
				...start,
				collection: knowledgeInteger(cursor.collection, 0, Math.max(0, collections.length - 1)),
				after: cursor.after === null ? null : knowledgeText(cursor.after, 4096),
				snapshotId: cursor.snapshotId === null ? null : knowledgeVersion(cursor.snapshotId),
			};
			if (start.after !== null && start.snapshotId === null) throw new CompanyKnowledgeError("invalid_request");
		}
		let position = { ...start };
		const items: CompanyKnowledgeScanPage["items"] = [];
		const spans: CompanyKnowledgeScanSpan[] = [];
		let scanned = 0;
		while (position.collection < collections.length && scanned < limit) {
			const collection = collections[position.collection];
			const page = await this.list(
				collection.id,
				{ after: position.after, snapshotId: position.snapshotId, limit: limit - scanned },
				signal,
			);
			start = { ...start, snapshotId: page.snapshotId };
			items.push(...page.items.map((item) => ({ collectionId: collection.id, ...item })));
			spans.push({ path: collection.path, after: position.after, through: page.nextAfter });
			scanned += page.scanned;
			position = {
				...position,
				snapshotId: page.snapshotId,
				collection: position.collection + (page.nextAfter === null ? 1 : 0),
				after: page.nextAfter,
			};
		}
		await this.assertAccess(signal);
		return { items, spans, scanned, start, next: position.collection < collections.length ? position : null };
	}

	async #range(path: string, offset: number, limit: number, signal: AbortSignal): Promise<KnowledgeRange> {
		const raw = await knowledgeRequest(
			(requestSignal) => this.#reader.read(path, offset, limit, requestSignal),
			signal,
		);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CompanyKnowledgeError("invalid_object");
		const input = raw as Record<string, unknown>;
		if (input.path !== path) throw new CompanyKnowledgeError("invalid_object");
		if (input.kind === "absent" || input.kind === "directory") {
			knowledgeObject(input, ["path", "version", "kind"]);
			return { kind: input.kind, version: input.version === null ? null : knowledgeVersion(input.version) };
		}
		knowledgeObject(input, ["path", "version", "kind", "offset", "bytesRead", "totalBytes", "text", "nextOffset"]);
		if (input.kind !== "file" || input.offset !== offset) throw new CompanyKnowledgeError("invalid_object");
		const text = knowledgeText(input.text, limit, true);
		const totalBytes = knowledgeInteger(input.totalBytes, 0, COMPANY_KNOWLEDGE_MAX_OBJECT_BYTES);
		const bytesRead = knowledgeInteger(input.bytesRead, 0, limit);
		const end = offset + bytesRead;
		if (
			bytesRead !== Buffer.byteLength(text) ||
			bytesRead < Math.min(limit, totalBytes - offset) - 3 ||
			end > totalBytes ||
			(bytesRead === 0 && end < totalBytes) ||
			input.nextOffset !== (end < totalBytes ? end : null)
		)
			throw new CompanyKnowledgeError("invalid_object");
		return {
			kind: "file",
			version: knowledgeVersion(input.version),
			text,
			totalBytes,
			nextOffset: input.nextOffset as number | null,
		};
	}

	async #mapReads<T, R>(
		items: readonly T[],
		signal: AbortSignal,
		action: (item: T, signal: AbortSignal) => Promise<R>,
	): Promise<R[]> {
		const stopped = new AbortController();
		const requestSignal = AbortSignal.any([signal, stopped.signal]);
		const output = new Array<R>(items.length);
		let next = 0;
		try {
			await Promise.all(
				Array.from({ length: Math.min(items.length, this.#readConcurrency) }, async () => {
					for (;;) {
						if (requestSignal.aborted) throw new CompanyKnowledgeError("cancelled");
						const index = next++;
						if (index >= items.length) return;
						output[index] = await action(items[index], requestSignal);
					}
				}),
			);
			return output;
		} catch (error) {
			stopped.abort();
			throw error;
		}
	}

	/** Internal read only: public read/readMany fence the complete group before returning any bytes. */
	async #readObject(
		collectionId: string,
		id: string,
		signal: AbortSignal,
		headerOnly: boolean,
	): Promise<CompanyKnowledgeRead> {
		const collection = this.collection(collectionId);
		const path = this.path(collectionId, id);
		const first = await this.#range(path, 0, 4096, signal);
		if (first.kind === "absent") {
			return { kind: "absent", version: first.version };
		}
		if (first.kind !== "file") throw new CompanyKnowledgeError("invalid_object");
		let text = first.text;
		let nextOffset = first.nextOffset;
		while (!headerOnly && nextOffset !== null) {
			const next = await this.#range(path, nextOffset, 4096, signal);
			if (next.kind !== "file" || next.version !== first.version || next.totalBytes !== first.totalBytes)
				throw new CompanyKnowledgeError("source_changed");
			text += next.text;
			nextOffset = next.nextOffset;
		}
		const source: CompanyKnowledgeSource = Object.freeze({
			kind: "company_file",
			companyId: this.run.companyId,
			environmentId: this.run.environmentId,
			collectionId,
			objectId: id,
			path,
			version: first.version,
			scope: collection.scope,
			trust: "untrusted_data",
			authority: "none",
		});
		return { kind: "file", source, text, totalBytes: first.totalBytes };
	}

	/** Prefix-only reads never request later skill-body ranges; the prefix may include body bytes. */
	async read(
		collectionId: string,
		id: string,
		signal: AbortSignal,
		headerOnly = false,
	): Promise<CompanyKnowledgeRead> {
		return (await this.readMany([{ collectionId, id }], signal, headerOnly))[0];
	}

	/** Independent objects in bounded parallelism, followed by one group version/access fence. */
	async readMany(
		targets: readonly { collectionId: string; id: string }[],
		signal: AbortSignal,
		headerOnly = false,
	): Promise<CompanyKnowledgeRead[]> {
		knowledgeInteger(targets.length, 0, COMPANY_KNOWLEDGE_MAX_OBJECTS);
		const requested = targets.map(({ collectionId, id }) => {
			this.path(collectionId, id);
			return { collectionId, id };
		});
		const reads = await this.#mapReads(requested, signal, (target, requestSignal) =>
			this.#readObject(target.collectionId, target.id, requestSignal, headerOnly),
		);
		await this.assertCurrent(
			reads.flatMap((read) => (read.kind === "file" ? [read.source] : [])),
			signal,
		);
		return reads;
	}

	#sourceReferences(sources: readonly CompanyKnowledgeSource[]): { path: string; version: string }[] {
		knowledgeInteger(sources.length, 0, COMPANY_KNOWLEDGE_MAX_OBJECTS);
		const checked = new Map<string, string>();
		for (const value of sources) {
			const source = this.source(value);
			if (checked.has(source.path)) {
				if (checked.get(source.path) !== source.version) throw new CompanyKnowledgeError("source_changed");
				continue;
			}
			checked.set(source.path, knowledgeVersion(source.version));
		}
		return [...checked].map(([path, version]) => ({ path, version }));
	}

	/** Register with the runtime's pre-request/compaction fence; cached text is never a read grant. */
	async assertCurrent(sources: readonly CompanyKnowledgeSource[], signal: AbortSignal): Promise<void> {
		const references = this.#sourceReferences(sources);
		await knowledgeRequest(
			(requestSignal) => this.#reader.assertCurrent(references, requestSignal, [...this.#collections.values()]),
			signal,
		);
	}

	async write(
		options: {
			collectionId: string;
			id: string;
			expectedVersion: string | null;
			operationKey: string;
			text: string;
		},
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		if (this.#preparing) throw new CompanyKnowledgeError("invalid_request");
		const path = this.path(options.collectionId, options.id);
		const expectedVersion = options.expectedVersion === null ? null : knowledgeVersion(options.expectedVersion);
		const operationKey = options.operationKey;
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(operationKey)) throw new CompanyKnowledgeError("invalid_request");
		const text = knowledgeText(options.text, COMPANY_KNOWLEDGE_MAX_OBJECT_BYTES);
		await this.assertAccess(signal);
		// Do not preempt the gateway's receipt lookup with a stale-version precheck:
		// a retry after a lost successful response must retain its original plan.
		try {
			const output = knowledgeObject(
				await knowledgeRequest(
					(requestSignal) =>
						this.#gateway.mutate("write", { path, expectedVersion, operationKey, text }, requestSignal),
					signal,
					"operation_unconfirmed",
				),
				["schema", "state", "operationKey", "path", "version", "snapshotId", "receiptId", "proposalId"],
			);
			if (
				output.schema !== "qorpera.company-path-result/v1" ||
				(output.state !== "applied" && output.state !== "proposed") ||
				output.operationKey !== operationKey ||
				output.path !== path ||
				(output.state === "applied" &&
					(output.version === null || output.snapshotId === null || output.proposalId !== null)) ||
				(output.state === "proposed" &&
					(output.version !== expectedVersion || output.snapshotId !== null || output.proposalId === null))
			)
				throw new CompanyKnowledgeError("operation_unconfirmed");
			const result: CompanyKnowledgeMutationResult = {
				schema: "qorpera.company-path-result/v1",
				state: output.state,
				operationKey,
				path,
				version: output.version === null ? null : knowledgeVersion(output.version),
				snapshotId: output.snapshotId === null ? null : knowledgeVersion(output.snapshotId),
				receiptId: knowledgeVersion(output.receiptId),
				proposalId: output.proposalId === null ? null : knowledgeVersion(output.proposalId),
			};
			await this.assertAccess(signal);
			return result;
		} catch {
			// Neither a stale write nor an uncertain network outcome may be silently retried.
			// Only the shared gateway can distinguish them durably.
			throw new CompanyKnowledgeError("operation_unconfirmed");
		}
	}
}
