import { createHash } from "node:crypto";
import {
	COMPANY_KNOWLEDGE_SCAN_ENTRIES,
	type CompanyKnowledgeBudget,
	CompanyKnowledgeError,
	CompanyKnowledgeFingerprints,
	type CompanyKnowledgeMutationResult,
	type CompanyKnowledgeRetentionPolicy,
	type CompanyKnowledgeRun,
	type CompanyKnowledgeScanCursor,
	type CompanyKnowledgeScanOptions,
	type CompanyKnowledgeScanSpan,
	type CompanyKnowledgeSession,
	type CompanyKnowledgeSource,
	checkKnowledgeBudget,
	fitKnowledgeText,
	knowledgeDigest,
	knowledgeInteger,
	knowledgeJson,
	knowledgeObject,
	knowledgeText,
	knowledgeVersion,
	parseKnowledgeRetentionPolicy,
	parseKnowledgeScanCursor,
	prepareKnowledge,
} from "./company-knowledge.ts";

export const COMPANY_MEMORY_SCHEMA = "qorpera.company-memory/v1";

export type CompanyMemoryContent =
	| { kind: "fact" | "agent_profile"; title: string; text: string }
	| { kind: "agent_log"; title: string; text: string; date: string };

export type CompanyMemoryObject =
	| (CompanyMemoryContent & { schema: typeof COMPANY_MEMORY_SCHEMA; state: "active" })
	| {
			schema: typeof COMPANY_MEMORY_SCHEMA;
			state: "forgotten";
			previousVersion: string;
			reason: string;
			retentionPolicy: CompanyKnowledgeRetentionPolicy;
	  };

function memoryDate(value: unknown): string {
	const date = knowledgeText(value, 10);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		!Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
		new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
	)
		throw new CompanyKnowledgeError("invalid_object");
	return date;
}

/** Also available to the Company File schema-registry owner. */
export function parseCompanyMemoryObject(value: unknown): CompanyMemoryObject {
	const data = knowledgeObject(
		value,
		["schema", "state"],
		["kind", "title", "text", "date", "previousVersion", "reason", "retentionPolicy"],
	);
	if (data.schema !== COMPANY_MEMORY_SCHEMA) throw new CompanyKnowledgeError("invalid_object");
	if (data.state === "forgotten") {
		knowledgeObject(data, ["schema", "state", "previousVersion", "reason", "retentionPolicy"]);
		return {
			schema: COMPANY_MEMORY_SCHEMA,
			state: "forgotten",
			previousVersion: knowledgeVersion(data.previousVersion),
			reason: knowledgeText(data.reason, 512),
			retentionPolicy: parseKnowledgeRetentionPolicy(data.retentionPolicy),
		};
	}
	const kind = data.kind;
	if (data.state !== "active" || (kind !== "fact" && kind !== "agent_profile" && kind !== "agent_log"))
		throw new CompanyKnowledgeError("invalid_object");
	knowledgeObject(data, ["schema", "state", "kind", "title", "text", ...(kind === "agent_log" ? ["date"] : [])]);
	const common: { schema: typeof COMPANY_MEMORY_SCHEMA; state: "active"; title: string; text: string } = {
		schema: COMPANY_MEMORY_SCHEMA,
		state: "active" as const,
		title: knowledgeText(data.title, 256),
		text: knowledgeText(data.text, 16 * 1024),
	};
	if (kind === "agent_log") {
		return { ...common, kind: "agent_log", date: memoryDate(data.date) };
	}
	return { ...common, kind };
}

export interface CompanyMemoryChange {
	companyId: string;
	environmentId: string;
	path: string;
	/** Resulting opaque version; null for a removed path. Older events may evict, never resurrect. */
	version: string | null;
}

interface IndexEntry {
	source: CompanyKnowledgeSource;
	terms: ReadonlySet<string>;
}

function terms(text: string): Set<string> {
	return new Set(
		text
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? [],
	);
}

function matchScore(indexed: ReadonlySet<string>, query: ReadonlySet<string>): number {
	if (query.size === 0) return 1;
	let score = 0;
	for (const term of query) if (indexed.has(term)) score++;
	return score;
}

function partition(run: Pick<CompanyKnowledgeRun, "companyId" | "environmentId">): string {
	return JSON.stringify([run.companyId, run.environmentId]);
}

function sourceKey(source: Pick<CompanyKnowledgeSource, "companyId" | "environmentId" | "path">): string {
	return JSON.stringify([source.companyId, source.environmentId, source.path]);
}

function visited(path: string, spans: readonly CompanyKnowledgeScanSpan[]): boolean {
	return spans.some(
		(span) =>
			path.slice(0, path.lastIndexOf("/")) === span.path &&
			(span.after === null || Buffer.compare(Buffer.from(path), Buffer.from(span.after)) > 0) &&
			(span.through === null || Buffer.compare(Buffer.from(path), Buffer.from(span.through)) <= 0),
	);
}

/** Disposable lexical postings only. No canonical body, history, grants or durable writes. */
export class CompanyMemoryIndex {
	readonly #entries = new Map<string, IndexEntry>();
	readonly #epochs = new Map<string, number>();
	readonly #maxEntries: number;

	constructor(maxEntries = 512) {
		this.#maxEntries = knowledgeInteger(maxEntries, 1, 4096);
	}

	epoch(run: Pick<CompanyKnowledgeRun, "companyId" | "environmentId">): number {
		return this.#epochs.get(partition(run)) ?? 0;
	}

	/** Never serves text. Callers must read current Company File objects before releasing matches. */
	score(
		source: Pick<CompanyKnowledgeSource, "companyId" | "environmentId" | "path" | "version">,
		query: ReadonlySet<string>,
	): number | undefined {
		const entry = this.#entries.get(sourceKey(source));
		return entry?.source.version === source.version ? matchScore(entry.terms, query) : undefined;
	}

	observe(source: CompanyKnowledgeSource, memory: CompanyMemoryContent, epoch: number): void {
		if (this.epoch(source) !== epoch) return;
		this.#entries.set(sourceKey(source), { source, terms: terms(`${memory.title}\n${memory.text}`) });
		while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
	}

	invalidate(change: CompanyMemoryChange): void {
		const key = sourceKey(change);
		if (this.#entries.get(key)?.source.version !== change.version) this.#entries.delete(key);
		this.#epochs.set(partition(change), this.epoch(change) + 1);
	}

	clear(run: Pick<CompanyKnowledgeRun, "companyId" | "environmentId">): void {
		for (const [key, entry] of this.#entries)
			if (partition(entry.source) === partition(run)) this.#entries.delete(key);
		this.#epochs.set(partition(run), this.epoch(run) + 1);
	}

	/** A live authorized page repairs missed events only inside its visited intervals. */
	reconcile(
		run: CompanyKnowledgeRun,
		spans: readonly CompanyKnowledgeScanSpan[],
		live: ReadonlyMap<string, string>,
	): void {
		let changed = false;
		for (const [key, entry] of this.#entries) {
			if (
				partition(entry.source) === partition(run) &&
				visited(entry.source.path, spans) &&
				live.get(entry.source.path) !== entry.source.version
			) {
				this.#entries.delete(key);
				changed = true;
			}
		}
		if (changed) this.#epochs.set(partition(run), this.epoch(run) + 1);
	}

	/** Atomic replacement of one verified window, not a claim that an unfinished crawl is complete. */
	replace(
		run: CompanyKnowledgeRun,
		spans: readonly CompanyKnowledgeScanSpan[],
		entries: readonly { source: CompanyKnowledgeSource; memory: CompanyMemoryContent }[],
		epoch: number,
	): void {
		if (this.epoch(run) !== epoch) throw new CompanyKnowledgeError("source_changed");
		for (const [key, entry] of this.#entries) {
			if (partition(entry.source) === partition(run) && visited(entry.source.path, spans)) this.#entries.delete(key);
		}
		for (const entry of entries) this.observe(entry.source, entry.memory, epoch);
		this.#epochs.set(partition(run), epoch + 1);
	}
}

export type CompanyMemoryRead =
	| { state: "absent"; version: string | null }
	| { state: "active"; source: CompanyKnowledgeSource; memory: CompanyMemoryContent }
	| {
			state: "forgotten";
			source: CompanyKnowledgeSource;
			tombstone: Extract<CompanyMemoryObject, { state: "forgotten" }>;
	  };

export interface CompanyMemoryContextItem {
	source: CompanyKnowledgeSource;
	kind: CompanyMemoryContent["kind"];
	title: string;
	text: string;
	date: string | null;
	textSha256: string;
	originalBytes: number;
	truncated: boolean;
}

export interface CompanyMemoryContext {
	schema: "qorpera.memory-context/v1";
	run: CompanyKnowledgeRun;
	items: readonly CompanyMemoryContextItem[];
	hasMore: boolean;
	/** Work performed in this window, including tombstones; not the number of matches. */
	scanned: number;
	/** Host-only control metadata; compose items, never cursor paths or cursor hashes, into model context. */
	next: CompanyMemoryContextCursor | null;
}

export interface CompanyMemoryContextCursor {
	schema: "qorpera.memory-continuation/v1";
	querySha256: string;
	scan: CompanyKnowledgeScanCursor;
	/** Revisit a ranked window to deliver matches that did not fit the previous contribution. */
	offset: number;
	windowSha256: string | null;
}

function memoryCursor(value: unknown): CompanyMemoryContextCursor {
	const data = knowledgeObject(value, ["schema", "querySha256", "scan", "offset", "windowSha256"]);
	if (data.schema !== "qorpera.memory-continuation/v1" || (data.offset !== 0 && data.windowSha256 === null))
		throw new CompanyKnowledgeError("invalid_request");
	return Object.freeze({
		schema: data.schema,
		querySha256: knowledgeDigest(data.querySha256),
		scan: parseKnowledgeScanCursor(data.scan),
		offset: knowledgeInteger(data.offset, 0, COMPANY_KNOWLEDGE_SCAN_ENTRIES),
		windowSha256: data.windowSha256 === null ? null : knowledgeDigest(data.windowSha256),
	});
}

export class CompanyMemoryService {
	readonly #session: CompanyKnowledgeSession;
	readonly #index: CompanyMemoryIndex;
	readonly #validated = new CompanyKnowledgeFingerprints();

	constructor(session: CompanyKnowledgeSession, index = new CompanyMemoryIndex()) {
		this.#session = session;
		this.#index = index;
	}

	#checkKind(collectionId: string, memory: Pick<CompanyMemoryContent, "kind">): void {
		const collection = this.#session.collection(collectionId, "memory");
		if (memory.kind !== "fact" && collection.scope.kind !== "agent_private")
			throw new CompanyKnowledgeError("invalid_object");
	}

	#contextSnapshot(value: unknown, budget: CompanyKnowledgeBudget): CompanyMemoryContext {
		checkKnowledgeBudget(budget);
		const data = knowledgeObject(value, ["schema", "run", "items", "hasMore", "scanned", "next"]);
		const run = this.#session.checkRun(data.run);
		if (
			data.schema !== "qorpera.memory-context/v1" ||
			typeof data.hasMore !== "boolean" ||
			!Array.isArray(data.items)
		)
			throw new CompanyKnowledgeError("invalid_object");
		if (data.items.length > budget.maxItems) throw new CompanyKnowledgeError("budget_exceeded");
		const items = data.items.map((value): CompanyMemoryContextItem => {
			const item = knowledgeObject(value, [
				"source",
				"kind",
				"title",
				"text",
				"date",
				"textSha256",
				"originalBytes",
				"truncated",
			]);
			const source = this.#session.source(item.source, "memory");
			const kind = item.kind;
			if (
				(kind !== "fact" && kind !== "agent_profile" && kind !== "agent_log") ||
				typeof item.truncated !== "boolean" ||
				(kind !== "agent_log" && item.date !== null)
			)
				throw new CompanyKnowledgeError("invalid_object");
			this.#checkKind(source.collectionId, { kind });
			const text = knowledgeText(item.text, 16 * 1024, true);
			if (text.length === 0) throw new CompanyKnowledgeError("invalid_object");
			return Object.freeze({
				source,
				kind,
				title: knowledgeText(item.title, 256),
				text,
				date: kind === "agent_log" ? memoryDate(item.date) : null,
				textSha256: knowledgeDigest(item.textSha256),
				originalBytes: knowledgeInteger(item.originalBytes, Buffer.byteLength(text), 16 * 1024),
				truncated: item.truncated,
			});
		});
		const output: CompanyMemoryContext = Object.freeze({
			schema: data.schema,
			run,
			items: Object.freeze(items),
			hasMore: data.hasMore,
			scanned: knowledgeInteger(data.scanned, 0, COMPANY_KNOWLEDGE_SCAN_ENTRIES),
			next: data.next === null ? null : memoryCursor(data.next),
		});
		if (Buffer.byteLength(JSON.stringify(output)) > budget.maxBytes)
			throw new CompanyKnowledgeError("budget_exceeded");
		return output;
	}

	async read(collectionId: string, id: string, signal: AbortSignal): Promise<CompanyMemoryRead> {
		this.#session.collection(collectionId, "memory");
		const epoch = this.#index.epoch(this.#session.run);
		const read = await this.#session.read(collectionId, id, signal);
		if (read.kind === "absent") {
			this.#index.invalidate({ ...this.#session.run, path: this.#session.path(collectionId, id), version: null });
			return { state: "absent", version: read.version };
		}
		const memory = parseCompanyMemoryObject(knowledgeJson(read.text));
		if (memory.state === "forgotten") {
			this.#index.invalidate({ ...read.source, version: null });
			return { state: "forgotten", source: read.source, tombstone: memory };
		}
		this.#checkKind(collectionId, memory);
		this.#index.observe(read.source, memory, epoch);
		return { state: "active", source: read.source, memory };
	}

	async #store(
		input: {
			collectionId: string;
			id: string;
			memory: CompanyMemoryContent;
			operationKey: string;
			expectedVersion: string | null;
		},
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		const memory = parseCompanyMemoryObject({ ...input.memory, schema: COMPANY_MEMORY_SCHEMA, state: "active" });
		if (memory.state !== "active") throw new CompanyKnowledgeError("invalid_object");
		this.#checkKind(input.collectionId, memory);
		const result = await this.#session.write(
			{
				collectionId: input.collectionId,
				id: input.id,
				operationKey: input.operationKey,
				expectedVersion: input.expectedVersion,
				text: JSON.stringify(memory),
			},
			signal,
		);
		if (result.state === "applied")
			this.#index.invalidate({ ...this.#session.run, path: result.path, version: result.version });
		return result;
	}

	write(
		input: { collectionId: string; id: string; memory: CompanyMemoryContent; operationKey: string },
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		return this.#store({ ...input, expectedVersion: null }, signal);
	}

	revise(
		input: {
			collectionId: string;
			id: string;
			memory: CompanyMemoryContent;
			operationKey: string;
			expectedVersion: string;
		},
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		return this.#store({ ...input, expectedVersion: knowledgeVersion(input.expectedVersion) }, signal);
	}

	async forget(
		input: { collectionId: string; id: string; operationKey: string; expectedVersion: string; reason: string },
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		this.#session.collection(input.collectionId, "memory");
		const memory = parseCompanyMemoryObject({
			schema: COMPANY_MEMORY_SCHEMA,
			state: "forgotten",
			previousVersion: knowledgeVersion(input.expectedVersion),
			reason: input.reason,
			retentionPolicy: this.#session.retentionPolicy(),
		});
		const result = await this.#session.write({ ...input, text: JSON.stringify(memory) }, signal);
		if (result.state === "applied")
			this.#index.invalidate({ ...this.#session.run, path: result.path, version: null });
		return result;
	}

	/** Rebuild one live window. Persist only the cursor if needed; indexes remain disposable. */
	async rebuild(
		input: CompanyKnowledgeScanOptions & { maxPreparationMs?: number },
		signal: AbortSignal,
	): Promise<{ indexed: number; scanned: number; next: CompanyKnowledgeScanCursor | null }> {
		return prepareKnowledge(input.maxPreparationMs ?? 5000, signal, async (requestSignal) => {
			const epoch = this.#index.epoch(this.#session.run);
			const prepared = await this.#session.prepare(async (session) => {
				const page = await session.scan("memory", input, requestSignal);
				const reads = await session.readMany(page.items, requestSignal);
				const entries: { source: CompanyKnowledgeSource; memory: CompanyMemoryContent }[] = [];
				for (let index = 0; index < page.items.length; index++) {
					const read = reads[index];
					if (read.kind !== "file" || read.source.version !== page.items[index].version)
						throw new CompanyKnowledgeError("source_changed");
					const memory = parseCompanyMemoryObject(knowledgeJson(read.text));
					if (memory.state === "active") {
						this.#checkKind(read.source.collectionId, memory);
						entries.push({ source: read.source, memory });
					}
				}
				return { value: { page, entries }, sources: [] };
			}, requestSignal);
			this.#index.replace(this.#session.run, prepared.page.spans, prepared.entries, epoch);
			return { indexed: prepared.entries.length, scanned: prepared.page.scanned, next: prepared.page.next };
		});
	}

	async context(
		input: {
			query: string;
			collectionIds?: readonly string[];
			budget: CompanyKnowledgeBudget;
			cursor?: CompanyMemoryContextCursor;
			maxScanEntries?: number;
			maxPreparationMs?: number;
		},
		signal: AbortSignal,
	): Promise<CompanyMemoryContext> {
		const budget = { ...input.budget };
		checkKnowledgeBudget(budget);
		const prepared = await prepareKnowledge(input.maxPreparationMs ?? 5000, signal, (requestSignal) =>
			this.#session.prepare(async (session) => {
				const collections = [
					...(input.collectionIds ?? session.collections("memory").map((collection) => collection.id)),
				];
				const queryText = knowledgeText(input.query, 1024, true);
				const query = terms(queryText);
				if (query.size > 32) throw new CompanyKnowledgeError("budget_exceeded");
				const querySha256 = createHash("sha256").update(queryText).digest("hex");
				let cursor: CompanyMemoryContextCursor | undefined;
				if (input.cursor) {
					cursor = memoryCursor(input.cursor);
					if (cursor.querySha256 !== querySha256) throw new CompanyKnowledgeError("invalid_request");
				}
				const maxScanEntries = input.maxScanEntries;
				let output: CompanyMemoryContext = {
					schema: "qorpera.memory-context/v1",
					run: this.#session.run,
					items: [],
					hasMore: false,
					scanned: 0,
					next: null,
				};
				if (Buffer.byteLength(JSON.stringify(output)) > budget.maxBytes)
					throw new CompanyKnowledgeError("budget_exceeded");
				await session.assertAccess(requestSignal);
				if (budget.maxItems === 0) return { value: { ...output, hasMore: true }, sources: [] };
				const candidates: { collectionId: string; id: string; path: string; version: string; score: number }[] = [];
				const reads = new Map<string, Extract<CompanyMemoryRead, { state: "active" }>>();
				const page = await session.scan(
					"memory",
					{ collectionIds: collections, cursor: cursor?.scan, maxScanEntries },
					requestSignal,
				);
				const windowSha256 = createHash("sha256")
					.update(JSON.stringify([page.items, page.spans]))
					.digest("hex");
				if (cursor?.windowSha256 && cursor.windowSha256 !== windowSha256)
					throw new CompanyKnowledgeError("source_changed");
				const continuation = (scan: CompanyKnowledgeScanCursor, offset = 0): CompanyMemoryContextCursor => ({
					schema: "qorpera.memory-continuation/v1",
					querySha256,
					scan,
					offset,
					windowSha256: offset > 0 ? windowSha256 : null,
				});
				const nextWindow = page.next === null ? null : continuation(page.next);
				output = { ...output, scanned: page.scanned, next: nextWindow, hasMore: nextWindow !== null };
				this.#index.reconcile(
					this.#session.run,
					page.spans,
					new Map(page.items.map((item) => [item.path, item.version])),
				);
				const epoch = this.#index.epoch(this.#session.run);
				// Hold this authorized window's scores across cache eviction/invalidation.
				// Selected bodies still require fresh canonical reads and the final source fence.
				const scores = new Map(
					page.items.map((item) => [item.path, this.#index.score({ ...this.#session.run, ...item }, query)]),
				);
				const missing = page.items.filter((item) => scores.get(item.path) === undefined);
				const fresh = missing.length > 0 ? await session.readMany(missing, requestSignal) : [];
				for (let index = 0; index < missing.length; index++) {
					const read = fresh[index];
					if (read.kind !== "file" || read.source.version !== missing[index].version)
						throw new CompanyKnowledgeError("source_changed");
					const memory = parseCompanyMemoryObject(knowledgeJson(read.text));
					if (memory.state === "forgotten") continue;
					this.#checkKind(read.source.collectionId, memory);
					this.#index.observe(read.source, memory, epoch);
					reads.set(read.source.path, { state: "active", source: read.source, memory });
				}
				for (const item of page.items) {
					let score = scores.get(item.path);
					const read = reads.get(item.path);
					if (read) score = matchScore(terms(`${read.memory.title}\n${read.memory.text}`), query);
					if (score !== undefined && score > 0) candidates.push({ ...item, score });
				}
				candidates.sort((a, b) => b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
				const offset = cursor?.offset ?? 0;
				if (offset > candidates.length) throw new CompanyKnowledgeError("source_changed");
				// Warm windows fetch only selected candidates; cold windows reuse their already fenced reads.
				const selected = candidates.slice(offset, offset + budget.maxItems).filter((item) => !reads.has(item.path));
				if (selected.length > 0) {
					const fetched = await session.readMany(selected, requestSignal);
					for (let index = 0; index < selected.length; index++) {
						const read = fetched[index];
						if (read.kind !== "file" || read.source.version !== selected[index].version)
							throw new CompanyKnowledgeError("source_changed");
						const memory = parseCompanyMemoryObject(knowledgeJson(read.text));
						if (memory.state !== "active") throw new CompanyKnowledgeError("source_changed");
						this.#checkKind(read.source.collectionId, memory);
						reads.set(read.source.path, { state: "active", source: read.source, memory });
					}
				}
				for (let index = offset; index < candidates.length; index++) {
					if (output.items.length >= budget.maxItems) {
						break;
					}
					const candidate = candidates[index];
					const read = reads.get(candidate.path)!;
					const item = {
						source: read.source,
						kind: read.memory.kind,
						title: read.memory.title,
						date: read.memory.kind === "agent_log" ? read.memory.date : null,
						textSha256: createHash("sha256").update(read.memory.text).digest("hex"),
						originalBytes: Buffer.byteLength(read.memory.text),
					};
					const fitted = fitKnowledgeText(
						read.memory.text,
						budget.maxBytes,
						(text, truncated): CompanyMemoryContext => ({
							...output,
							items: [...output.items, { ...item, text, truncated }],
							next: index + 1 < candidates.length ? continuation(page.start, index + 1) : nextWindow,
							hasMore:
								nextWindow !== null ||
								output.items.some((entry) => entry.truncated) ||
								truncated ||
								index + 1 < candidates.length,
						}),
					);
					if (!fitted || (fitted.items.at(-1)?.text.length === 0 && read.memory.text.length > 0)) {
						if (output.items.length === 0) throw new CompanyKnowledgeError("budget_exceeded");
						break;
					}
					output = fitted;
				}
				if (Buffer.byteLength(JSON.stringify(output)) > budget.maxBytes)
					throw new CompanyKnowledgeError("budget_exceeded");
				return { value: output, sources: output.items.map((item) => item.source) };
			}, requestSignal),
		);
		const output = this.#contextSnapshot(prepared, budget);
		for (const item of output.items) this.#validated.add(item);
		return output;
	}

	/** Recheck current allocation, canonical content and live access. Compose only the returned snapshot. */
	async assertContext(
		context: CompanyMemoryContext,
		input: { budget: CompanyKnowledgeBudget; maxPreparationMs?: number },
		signal: AbortSignal,
	): Promise<CompanyMemoryContext> {
		const output = this.#contextSnapshot(context, { ...input.budget });
		const missing = output.items.filter((item) => !this.#validated.has(item));
		const sources = output.items.map((item) => item.source);
		await prepareKnowledge(input.maxPreparationMs ?? 5000, signal, async (requestSignal) => {
			if (missing.length === 0) {
				await this.#session.assertCurrent(sources, requestSignal);
				return;
			}
			await this.#session.prepare(async (session) => {
				await session.assertCurrent(sources, requestSignal);
				const reads = await session.readMany(
					missing.map((item) => ({
						collectionId: item.source.collectionId,
						id: item.source.objectId,
					})),
					requestSignal,
				);
				for (let index = 0; index < missing.length; index++) {
					const item = missing[index];
					const read = reads[index];
					if (read.kind !== "file" || read.source.version !== item.source.version)
						throw new CompanyKnowledgeError("source_changed");
					const memory = parseCompanyMemoryObject(knowledgeJson(read.text));
					if (memory.state !== "active") throw new CompanyKnowledgeError("source_changed");
					if (
						item.kind !== memory.kind ||
						item.title !== memory.title ||
						item.date !== (memory.kind === "agent_log" ? memory.date : null) ||
						item.originalBytes !== Buffer.byteLength(memory.text) ||
						item.textSha256 !== createHash("sha256").update(memory.text).digest("hex") ||
						(item.truncated
							? item.text.length >= memory.text.length || !memory.text.startsWith(item.text)
							: item.text !== memory.text)
					)
						throw new CompanyKnowledgeError("invalid_object");
				}
				return { value: undefined, sources };
			}, requestSignal);
		});
		for (const item of output.items) this.#validated.add(item);
		return output;
	}
}
