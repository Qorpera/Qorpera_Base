import { createHash } from "node:crypto";
import {
	COMPANY_KNOWLEDGE_MAX_OBJECTS,
	COMPANY_KNOWLEDGE_SCAN_ENTRIES,
	type CompanyKnowledgeBudget,
	CompanyKnowledgeError,
	CompanyKnowledgeFingerprints,
	type CompanyKnowledgeMutationResult,
	type CompanyKnowledgeRetentionPolicy,
	type CompanyKnowledgeRun,
	type CompanyKnowledgeScanCursor,
	type CompanyKnowledgeSession,
	type CompanyKnowledgeSource,
	checkKnowledgeBudget,
	knowledgeDigest,
	knowledgeInteger,
	knowledgeJson,
	knowledgeObject,
	knowledgeRequest,
	knowledgeText,
	knowledgeVersion,
	parseKnowledgeRetentionPolicy,
	parseKnowledgeScanCursor,
	prepareKnowledge,
} from "./company-knowledge.ts";

/** Readable Markdown with bounded JSON front matter in the same versioned object. */
export const COMPANY_SKILL_SCHEMA = "qorpera.company-skill/v1";
export const COMPANY_SKILL_MAX_HEADER_BYTES = 4096;
const MAX_SKILL_BODY_BYTES = 24 * 1024;

export interface CompanySkillContent {
	name: string;
	useWhen: string;
	body: string;
}

export type CompanySkillHeader =
	| {
			schema: typeof COMPANY_SKILL_SCHEMA;
			state: "active";
			name: string;
			useWhen: string;
			bodySha256: string;
			bodyBytes: number;
	  }
	| {
			schema: typeof COMPANY_SKILL_SCHEMA;
			state: "forgotten";
			previousVersion: string;
			reason: string;
			retentionPolicy: CompanyKnowledgeRetentionPolicy;
	  };

function skillName(value: unknown): string {
	const name = knowledgeText(value, 128);
	if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new CompanyKnowledgeError("invalid_object");
	return name;
}

function serializeSkillHeader(header: CompanySkillHeader): string {
	const text = `---\n${JSON.stringify(header, null, 2)}\n---\n`;
	if (Buffer.byteLength(text) > COMPANY_SKILL_MAX_HEADER_BYTES) throw new CompanyKnowledgeError("budget_exceeded");
	return text;
}

/** Catalogs parse only front matter. A bounded prefix or storage chunk may also contain body bytes. */
export function serializeCompanySkill(content: CompanySkillContent): string {
	const input = knowledgeObject(content, ["name", "useWhen", "body"]);
	const body = knowledgeText(input.body, MAX_SKILL_BODY_BYTES);
	const header: CompanySkillHeader = {
		schema: COMPANY_SKILL_SCHEMA,
		state: "active",
		name: skillName(input.name),
		useWhen: knowledgeText(input.useWhen, 1024),
		bodySha256: createHash("sha256").update(body).digest("hex"),
		bodyBytes: Buffer.byteLength(body),
	};
	return `${serializeSkillHeader(header)}${body}`;
}

function skillFrontMatter(prefix: string): { json: string; end: number; bytes: number } {
	const bounded = prefix.slice(0, COMPANY_SKILL_MAX_HEADER_BYTES);
	const opening = /^---\r?\n/.exec(bounded);
	if (!opening) throw new CompanyKnowledgeError("invalid_object");
	const closing = /\r?\n---\r?\n/.exec(bounded.slice(opening[0].length));
	if (!closing) throw new CompanyKnowledgeError("invalid_object");
	const end = opening[0].length + closing.index + closing[0].length;
	const bytes = Buffer.byteLength(prefix.slice(0, end));
	if (bytes > COMPANY_SKILL_MAX_HEADER_BYTES) throw new CompanyKnowledgeError("invalid_object");
	return { json: prefix.slice(opening[0].length, opening[0].length + closing.index), end, bytes };
}

/** Registry/crawler parser. Validates declared body length even when only the header was fetched. */
export function parseCompanySkillHeader(prefix: string, totalBytes: number): CompanySkillHeader {
	const frontMatter = skillFrontMatter(prefix);
	const data = knowledgeObject(
		knowledgeJson(frontMatter.json),
		["schema", "state"],
		["name", "useWhen", "bodySha256", "bodyBytes", "previousVersion", "reason", "retentionPolicy"],
	);
	if (data.schema !== COMPANY_SKILL_SCHEMA) throw new CompanyKnowledgeError("invalid_object");
	const headerBytes = frontMatter.bytes;
	if (data.state === "forgotten") {
		knowledgeObject(data, ["schema", "state", "previousVersion", "reason", "retentionPolicy"]);
		if (totalBytes !== headerBytes) throw new CompanyKnowledgeError("invalid_object");
		return {
			schema: COMPANY_SKILL_SCHEMA,
			state: "forgotten",
			previousVersion: knowledgeVersion(data.previousVersion),
			reason: knowledgeText(data.reason, 512),
			retentionPolicy: parseKnowledgeRetentionPolicy(data.retentionPolicy),
		};
	}
	knowledgeObject(data, ["schema", "state", "name", "useWhen", "bodySha256", "bodyBytes"]);
	const bodyBytes = knowledgeInteger(data.bodyBytes, 1, MAX_SKILL_BODY_BYTES);
	if (data.state !== "active" || totalBytes !== headerBytes + bodyBytes)
		throw new CompanyKnowledgeError("invalid_object");
	return {
		schema: COMPANY_SKILL_SCHEMA,
		state: "active",
		name: skillName(data.name),
		useWhen: knowledgeText(data.useWhen, 1024),
		bodySha256: knowledgeDigest(data.bodySha256),
		bodyBytes,
	};
}

export function parseCompanySkill(text: string): { header: CompanySkillHeader; body: string | null } {
	const header = parseCompanySkillHeader(text, Buffer.byteLength(text));
	if (header.state === "forgotten") return { header, body: null };
	const body = knowledgeText(text.slice(skillFrontMatter(text).end), MAX_SKILL_BODY_BYTES);
	if (createHash("sha256").update(body).digest("hex") !== header.bodySha256)
		throw new CompanyKnowledgeError("invalid_object");
	return { header, body };
}

export type CompanySkillReference =
	| { kind: "company"; collectionId: string; id: string }
	| { kind: "platform"; id: string };

export interface PlatformSkillManifestEntry {
	id: string;
	version: string;
	name: string;
	useWhen: string;
	bodySha256: string;
	bodyBytes: number;
}

/** Host-verified, pinned bundle assets. Deliberately has no write or grant operation. */
export interface PlatformSkillBundle {
	runtimeBundleVersion: string;
	catalog: readonly PlatformSkillManifestEntry[];
	load(id: string, version: string, signal: AbortSignal): Promise<string>;
}

export interface PlatformSkillSource {
	kind: "runtime_bundle";
	runtimeBundleVersion: string;
	path: string;
	version: string;
	scope: { kind: "platform" };
	trust: "untrusted_data";
	authority: "none";
}

export interface CompanySkillCatalogEntry {
	reference: CompanySkillReference;
	name: string;
	useWhen: string;
	source: CompanyKnowledgeSource | PlatformSkillSource;
}

export interface CompanySkillCatalog {
	schema: "qorpera.skill-catalog/v1";
	run: CompanyKnowledgeRun;
	items: readonly CompanySkillCatalogEntry[];
	hasMore: boolean;
	scanned: number;
	/** Host-only control metadata; compose entries, never cursor paths or cursor hashes, into model context. */
	next: CompanySkillCatalogCursor | null;
}

export interface CompanySkillCatalogCursor {
	schema: "qorpera.skill-continuation/v1";
	scan: CompanyKnowledgeScanCursor;
	includePlatform: boolean;
	offset: number;
	windowSha256: string | null;
}

/** Append to the existing durable run record, idempotently by loadKey; not a separate skill ledger. */
export interface CompanySkillLoadRecord {
	schema: "qorpera.skill-load/v1";
	loadKey: string;
	run: CompanyKnowledgeRun;
	reference: CompanySkillReference;
	source: CompanyKnowledgeSource | PlatformSkillSource;
	name: string;
	useWhen: string;
	bodySha256: string;
	bodyBytes: number;
}

export interface CompanySkillContext {
	schema: "qorpera.skill-context/v1";
	run: CompanyKnowledgeRun;
	loadKey: string;
	reference: CompanySkillReference;
	source: CompanyKnowledgeSource | PlatformSkillSource;
	name: string;
	useWhen: string;
	body: string;
	bodySha256: string;
}

/** Versioned, newline-delimited identity shared with the durable SQL recorder. Fields reject line breaks. */
export function companySkillLoadKey(
	run: CompanyKnowledgeRun,
	target: CompanySkillReference,
	version: string,
	bodySha256: string,
): string {
	const checked = reference(target);
	return createHash("sha256")
		.update(
			[
				"qorpera.skill-load/v1",
				knowledgeVersion(run.companyId),
				knowledgeVersion(run.environmentId),
				knowledgeVersion(run.runId),
				knowledgeVersion(run.runtimeBundleVersion),
				checked.kind,
				checked.kind === "company" ? checked.collectionId : "",
				checked.id,
				knowledgeVersion(version),
				knowledgeDigest(bodySha256),
			].join("\n"),
		)
		.digest("hex");
}

function reference(value: unknown): CompanySkillReference {
	const data = knowledgeObject(value, ["kind", "id"], ["collectionId"]);
	if (typeof data.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(data.id))
		throw new CompanyKnowledgeError("invalid_request");
	if (data.kind === "platform") {
		knowledgeObject(data, ["kind", "id"]);
		return Object.freeze({ kind: "platform", id: data.id });
	}
	if (data.kind !== "company") throw new CompanyKnowledgeError("invalid_request");
	knowledgeObject(data, ["kind", "id", "collectionId"]);
	return Object.freeze({ kind: "company", collectionId: knowledgeVersion(data.collectionId), id: data.id });
}

function catalogCursor(value: unknown): CompanySkillCatalogCursor {
	const data = knowledgeObject(value, ["schema", "scan", "includePlatform", "offset", "windowSha256"]);
	if (
		data.schema !== "qorpera.skill-continuation/v1" ||
		typeof data.includePlatform !== "boolean" ||
		(data.offset !== 0 && data.windowSha256 === null)
	)
		throw new CompanyKnowledgeError("invalid_request");
	return Object.freeze({
		schema: data.schema,
		scan: parseKnowledgeScanCursor(data.scan),
		includePlatform: data.includePlatform,
		offset: knowledgeInteger(data.offset, 0, COMPANY_KNOWLEDGE_MAX_OBJECTS + COMPANY_KNOWLEDGE_SCAN_ENTRIES),
		windowSha256: data.windowSha256 === null ? null : knowledgeDigest(data.windowSha256),
	});
}

export class CompanySkillService {
	readonly #session: CompanyKnowledgeSession;
	readonly #platform = new Map<string, Readonly<PlatformSkillManifestEntry>>();
	readonly #loadPlatform: PlatformSkillBundle["load"] | undefined;
	readonly #recordLoad: (record: CompanySkillLoadRecord, signal: AbortSignal) => Promise<void>;
	readonly #assertRecordedLoad: (record: CompanySkillLoadRecord, signal: AbortSignal) => Promise<void>;
	readonly #fitsContext: (context: Readonly<CompanySkillContext>) => boolean;
	readonly #loaded = new Map<string, CompanyKnowledgeSource | PlatformSkillSource>();
	readonly #validatedCatalog = new CompanyKnowledgeFingerprints();

	constructor(options: {
		session: CompanyKnowledgeSession;
		platform?: PlatformSkillBundle;
		recordLoad: (record: CompanySkillLoadRecord, signal: AbortSignal) => Promise<void>;
		/** Verify an existing durable record during replay. This must never create a missing record. */
		assertRecordedLoad: (record: CompanySkillLoadRecord, signal: AbortSignal) => Promise<void>;
		/** Host checks the exact serialized envelope/token allocation; skill text cannot choose this policy. */
		fitsContext: (context: Readonly<CompanySkillContext>) => boolean;
	}) {
		this.#session = options.session;
		if (
			typeof options.recordLoad !== "function" ||
			typeof options.assertRecordedLoad !== "function" ||
			typeof options.fitsContext !== "function"
		)
			throw new CompanyKnowledgeError("invalid_request");
		this.#recordLoad = options.recordLoad;
		this.#assertRecordedLoad = options.assertRecordedLoad;
		this.#fitsContext = options.fitsContext;
		if (options.platform) {
			if (options.platform.runtimeBundleVersion !== options.session.run.runtimeBundleVersion)
				throw new CompanyKnowledgeError("invalid_request");
			knowledgeInteger(options.platform.catalog.length, 0, COMPANY_KNOWLEDGE_MAX_OBJECTS);
			for (const item of options.platform.catalog) {
				knowledgeObject(item, ["id", "version", "name", "useWhen", "bodySha256", "bodyBytes"]);
				const id = reference({ kind: "platform", id: item.id }).id;
				if (this.#platform.has(id)) throw new CompanyKnowledgeError("invalid_request");
				this.#platform.set(
					id,
					Object.freeze({
						id,
						version: knowledgeVersion(item.version),
						name: skillName(item.name),
						useWhen: knowledgeText(item.useWhen, 1024),
						bodySha256: knowledgeDigest(item.bodySha256),
						bodyBytes: knowledgeInteger(item.bodyBytes, 1, MAX_SKILL_BODY_BYTES),
					}),
				);
			}
			this.#loadPlatform = options.platform.load.bind(options.platform);
		}
	}

	#platformEntry(id: string): CompanySkillCatalogEntry {
		const item = this.#platform.get(id);
		if (!item) throw new CompanyKnowledgeError("invalid_request");
		return {
			reference: { kind: "platform", id },
			name: item.name,
			useWhen: item.useWhen,
			source: Object.freeze({
				kind: "runtime_bundle",
				runtimeBundleVersion: this.#session.run.runtimeBundleVersion,
				path: `skills/${id}`,
				version: item.version,
				scope: Object.freeze({ kind: "platform" }),
				trust: "untrusted_data",
				authority: "none",
			}),
		};
	}

	#catalogEntry(value: unknown): CompanySkillCatalogEntry {
		const data = knowledgeObject(value, ["reference", "source", "name", "useWhen"]);
		const target = reference(data.reference);
		const name = skillName(data.name);
		const useWhen = knowledgeText(data.useWhen, 1024);
		let source: CompanyKnowledgeSource | PlatformSkillSource;
		if (target.kind === "company") {
			source = this.#session.source(data.source, "skills");
			if (source.collectionId !== target.collectionId || source.objectId !== target.id)
				throw new CompanyKnowledgeError("invalid_request");
		} else {
			const input = knowledgeObject(data.source, [
				"kind",
				"runtimeBundleVersion",
				"path",
				"version",
				"scope",
				"trust",
				"authority",
			]);
			const expected = this.#platformEntry(target.id);
			const scope = knowledgeObject(input.scope, ["kind"]);
			if (
				input.kind !== "runtime_bundle" ||
				input.runtimeBundleVersion !== this.#session.run.runtimeBundleVersion ||
				input.path !== expected.source.path ||
				input.version !== expected.source.version ||
				scope.kind !== "platform" ||
				input.trust !== "untrusted_data" ||
				input.authority !== "none"
			)
				throw new CompanyKnowledgeError("source_changed");
			if (name !== expected.name || useWhen !== expected.useWhen) throw new CompanyKnowledgeError("invalid_object");
			source = expected.source;
		}
		return Object.freeze({ reference: target, name, useWhen, source });
	}

	#catalogSnapshot(value: unknown, budget: CompanyKnowledgeBudget): CompanySkillCatalog {
		checkKnowledgeBudget(budget);
		const data = knowledgeObject(value, ["schema", "run", "items", "hasMore", "scanned", "next"]);
		const run = this.#session.checkRun(data.run);
		if (data.schema !== "qorpera.skill-catalog/v1" || typeof data.hasMore !== "boolean" || !Array.isArray(data.items))
			throw new CompanyKnowledgeError("invalid_object");
		if (data.items.length > budget.maxItems) throw new CompanyKnowledgeError("budget_exceeded");
		const output: CompanySkillCatalog = Object.freeze({
			schema: data.schema,
			run,
			items: Object.freeze(data.items.map((item) => this.#catalogEntry(item))),
			hasMore: data.hasMore,
			scanned: knowledgeInteger(data.scanned, 0, COMPANY_KNOWLEDGE_SCAN_ENTRIES),
			next: data.next === null ? null : catalogCursor(data.next),
		});
		if (Buffer.byteLength(JSON.stringify(output)) > budget.maxBytes)
			throw new CompanyKnowledgeError("budget_exceeded");
		return output;
	}

	#checkContextBudget(context: CompanySkillContext): void {
		try {
			if (
				Buffer.byteLength(JSON.stringify(context)) > 64 * 1024 ||
				this.#fitsContext(Object.freeze(context)) !== true
			)
				throw new CompanyKnowledgeError("budget_exceeded");
		} catch {
			throw new CompanyKnowledgeError("budget_exceeded");
		}
	}

	async catalog(
		input: CompanyKnowledgeBudget & {
			cursor?: CompanySkillCatalogCursor;
			maxScanEntries?: number;
			maxPreparationMs?: number;
		},
		signal: AbortSignal,
	): Promise<CompanySkillCatalog> {
		const budget = { maxBytes: input.maxBytes, maxItems: input.maxItems };
		checkKnowledgeBudget(budget);
		const prepared = await prepareKnowledge(input.maxPreparationMs ?? 5000, signal, (requestSignal) =>
			this.#session.prepare(async (session) => {
				const cursor = input.cursor ? catalogCursor(input.cursor) : undefined;
				const maxScanEntries = input.maxScanEntries;
				let output: CompanySkillCatalog = {
					schema: "qorpera.skill-catalog/v1",
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
				const includePlatform = cursor?.includePlatform ?? true;
				const entries = includePlatform
					? [...this.#platform.keys()].sort().map((id) => this.#platformEntry(id))
					: [];
				const page = await session.scan("skills", { cursor: cursor?.scan, maxScanEntries }, requestSignal);
				const windowSha256 = createHash("sha256")
					.update(JSON.stringify([page.items, page.spans, entries]))
					.digest("hex");
				if (cursor?.windowSha256 && cursor.windowSha256 !== windowSha256)
					throw new CompanyKnowledgeError("source_changed");
				const continuation = (scan: CompanyKnowledgeScanCursor, offset = 0): CompanySkillCatalogCursor => ({
					schema: "qorpera.skill-continuation/v1",
					scan,
					includePlatform: offset > 0 && includePlatform,
					offset,
					windowSha256: offset > 0 ? windowSha256 : null,
				});
				const nextWindow = page.next === null ? null : continuation(page.next);
				output = { ...output, scanned: page.scanned, next: nextWindow, hasMore: nextWindow !== null };
				const reads = page.items.length > 0 ? await session.readMany(page.items, requestSignal, true) : [];
				for (let index = 0; index < page.items.length; index++) {
					const item = page.items[index];
					const read = reads[index];
					if (read.kind !== "file" || read.source.version !== item.version)
						throw new CompanyKnowledgeError("source_changed");
					const header = parseCompanySkillHeader(read.text, read.totalBytes);
					if (header.state === "forgotten") continue;
					entries.push({
						reference: { kind: "company", collectionId: item.collectionId, id: item.id },
						name: header.name,
						useWhen: header.useWhen,
						source: read.source,
					});
				}
				entries.sort((a, b) =>
					Buffer.compare(Buffer.from(JSON.stringify(a.reference)), Buffer.from(JSON.stringify(b.reference))),
				);
				const offset = cursor?.offset ?? 0;
				if (offset > entries.length) throw new CompanyKnowledgeError("source_changed");
				for (let index = offset; index < entries.length; index++) {
					const next: CompanySkillCatalog = {
						...output,
						items: [...output.items, entries[index]],
						next: index + 1 < entries.length ? continuation(page.start, index + 1) : nextWindow,
						hasMore: nextWindow !== null || index + 1 < entries.length,
					};
					if (next.items.length > budget.maxItems || Buffer.byteLength(JSON.stringify(next)) > budget.maxBytes) {
						if (output.items.length === 0) throw new CompanyKnowledgeError("budget_exceeded");
						break;
					}
					output = next;
				}
				if (Buffer.byteLength(JSON.stringify(output)) > budget.maxBytes)
					throw new CompanyKnowledgeError("budget_exceeded");
				return {
					value: output,
					sources: output.items.flatMap((item) => (item.source.kind === "company_file" ? [item.source] : [])),
				};
			}, requestSignal),
		);
		const output = this.#catalogSnapshot(prepared, budget);
		for (const item of output.items) this.#validatedCatalog.add(item);
		return output;
	}

	async #store(
		input: {
			reference: CompanySkillReference;
			skill: CompanySkillContent;
			expectedVersion: string | null;
			operationKey: string;
		},
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		const target = reference(input.reference);
		if (target.kind === "platform") throw new CompanyKnowledgeError("platform_read_only");
		this.#session.collection(target.collectionId, "skills");
		return this.#session.write(
			{
				collectionId: target.collectionId,
				id: target.id,
				expectedVersion: input.expectedVersion,
				operationKey: input.operationKey,
				text: serializeCompanySkill(input.skill),
			},
			signal,
		);
	}

	write(
		input: { reference: CompanySkillReference; skill: CompanySkillContent; operationKey: string },
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		return this.#store({ ...input, expectedVersion: null }, signal);
	}

	revise(
		input: {
			reference: CompanySkillReference;
			skill: CompanySkillContent;
			expectedVersion: string;
			operationKey: string;
		},
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		return this.#store({ ...input, expectedVersion: knowledgeVersion(input.expectedVersion) }, signal);
	}

	async forget(
		input: { reference: CompanySkillReference; expectedVersion: string; operationKey: string; reason: string },
		signal: AbortSignal,
	): Promise<CompanyKnowledgeMutationResult> {
		const target = reference(input.reference);
		if (target.kind === "platform") throw new CompanyKnowledgeError("platform_read_only");
		this.#session.collection(target.collectionId, "skills");
		const header: CompanySkillHeader = {
			schema: COMPANY_SKILL_SCHEMA,
			state: "forgotten",
			previousVersion: knowledgeVersion(input.expectedVersion),
			reason: knowledgeText(input.reason, 512),
			retentionPolicy: this.#session.retentionPolicy(),
		};
		return this.#session.write(
			{
				collectionId: target.collectionId,
				id: target.id,
				expectedVersion: input.expectedVersion,
				operationKey: input.operationKey,
				text: serializeSkillHeader(header),
			},
			signal,
		);
	}

	/** Exact version required. Never silently loads a newer company playbook or truncates its instructions. */
	async load(
		input: { reference: CompanySkillReference; expectedVersion: string; maxBytes: number },
		signal: AbortSignal,
	): Promise<CompanySkillContext> {
		const target = reference(input.reference);
		const expectedVersion = knowledgeVersion(input.expectedVersion);
		const maxBytes = knowledgeInteger(input.maxBytes, 0, 64 * 1024);
		await this.#session.assertAccess(signal);
		let entry: CompanySkillCatalogEntry;
		let body: string;
		let bodySha256: string;
		if (target.kind === "platform") {
			entry = this.#platformEntry(target.id);
			const manifest = this.#platform.get(target.id)!;
			if (manifest.version !== expectedVersion) throw new CompanyKnowledgeError("source_changed");
			body = knowledgeText(
				await knowledgeRequest(
					(requestSignal) => this.#loadPlatform!(target.id, manifest.version, requestSignal),
					signal,
				),
				MAX_SKILL_BODY_BYTES,
			);
			bodySha256 = createHash("sha256").update(body).digest("hex");
			if (bodySha256 !== manifest.bodySha256 || Buffer.byteLength(body) !== manifest.bodyBytes)
				throw new CompanyKnowledgeError("invalid_object");
		} else {
			this.#session.collection(target.collectionId, "skills");
			const read = await this.#session.read(target.collectionId, target.id, signal);
			if (read.kind !== "file" || read.source.version !== expectedVersion)
				throw new CompanyKnowledgeError("source_changed");
			const parsed = parseCompanySkill(read.text);
			if (parsed.header.state !== "active" || parsed.body === null)
				throw new CompanyKnowledgeError("source_changed");
			entry = { reference: target, name: parsed.header.name, useWhen: parsed.header.useWhen, source: read.source };
			body = parsed.body;
			bodySha256 = parsed.header.bodySha256;
		}
		const loadKey = companySkillLoadKey(this.#session.run, target, entry.source.version, bodySha256);
		if (!this.#loaded.has(loadKey) && this.#loaded.size >= COMPANY_KNOWLEDGE_MAX_OBJECTS)
			throw new CompanyKnowledgeError("budget_exceeded");
		const output: CompanySkillContext = {
			schema: "qorpera.skill-context/v1",
			run: this.#session.run,
			loadKey,
			reference: target,
			source: entry.source,
			name: entry.name,
			useWhen: entry.useWhen,
			body,
			bodySha256,
		};
		if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw new CompanyKnowledgeError("budget_exceeded");
		this.#checkContextBudget(output);
		await this.#assertSources([entry.source], signal);
		try {
			await knowledgeRequest(
				(requestSignal) =>
					this.#recordLoad(
						{
							schema: "qorpera.skill-load/v1",
							loadKey,
							run: this.#session.run,
							reference: target,
							source: entry.source,
							name: entry.name,
							useWhen: entry.useWhen,
							bodySha256,
							bodyBytes: Buffer.byteLength(body),
						},
						requestSignal,
					),
				signal,
				"record_unavailable",
			);
		} catch {
			throw new CompanyKnowledgeError("record_unavailable");
		}
		await this.#assertSources([entry.source], signal);
		this.#loaded.set(loadKey, entry.source);
		return output;
	}

	async #assertSources(
		sources: readonly (CompanyKnowledgeSource | PlatformSkillSource)[],
		signal: AbortSignal,
	): Promise<void> {
		const company: CompanyKnowledgeSource[] = [];
		for (const source of sources) {
			if (source.kind === "company_file") company.push(source);
			else {
				const manifest = this.#platform.get(source.path.slice("skills/".length));
				if (
					!manifest ||
					source.path !== `skills/${manifest.id}` ||
					source.version !== manifest.version ||
					source.runtimeBundleVersion !== this.#session.run.runtimeBundleVersion ||
					source.trust !== "untrusted_data" ||
					source.authority !== "none" ||
					source.scope.kind !== "platform"
				)
					throw new CompanyKnowledgeError("source_changed");
			}
		}
		await this.#session.assertCurrent(company, signal);
	}

	/** Recheck metadata without loading instructions. Compose only the returned snapshot. */
	async assertCatalog(
		catalog: CompanySkillCatalog,
		input: { budget: CompanyKnowledgeBudget; maxPreparationMs?: number },
		signal: AbortSignal,
	): Promise<CompanySkillCatalog> {
		const output = this.#catalogSnapshot(catalog, { ...input.budget });
		const missing = output.items.filter(
			(item) => item.source.kind === "company_file" && !this.#validatedCatalog.has(item),
		);
		const sources = output.items.flatMap((item) => (item.source.kind === "company_file" ? [item.source] : []));
		await prepareKnowledge(input.maxPreparationMs ?? 5000, signal, async (requestSignal) => {
			if (missing.length === 0) {
				await this.#session.assertCurrent(sources, requestSignal);
				return;
			}
			await this.#session.prepare(async (session) => {
				await session.assertCurrent(sources, requestSignal);
				const reads = await session.readMany(
					missing.map((item) => {
						if (item.reference.kind !== "company") throw new CompanyKnowledgeError("invalid_object");
						return { collectionId: item.reference.collectionId, id: item.reference.id };
					}),
					requestSignal,
					true,
				);
				for (let index = 0; index < missing.length; index++) {
					const item = missing[index];
					const read = reads[index];
					if (read.kind !== "file" || read.source.version !== item.source.version)
						throw new CompanyKnowledgeError("source_changed");
					const header = parseCompanySkillHeader(read.text, read.totalBytes);
					if (header.state !== "active") throw new CompanyKnowledgeError("source_changed");
					if (item.name !== header.name || item.useWhen !== header.useWhen)
						throw new CompanyKnowledgeError("invalid_object");
				}
				return { value: undefined, sources };
			}, requestSignal);
		});
		for (const item of output.items) this.#validatedCatalog.add(item);
		return output;
	}

	/** Verify the complete recorded content, current allocation and access; compose only the returned snapshot. */
	async assertContext(context: CompanySkillContext, signal: AbortSignal): Promise<CompanySkillContext> {
		const data = knowledgeObject(context, [
			"schema",
			"run",
			"loadKey",
			"reference",
			"source",
			"name",
			"useWhen",
			"body",
			"bodySha256",
		]);
		const run = this.#session.checkRun(data.run);
		if (data.schema !== "qorpera.skill-context/v1") throw new CompanyKnowledgeError("invalid_request");
		const entry = this.#catalogEntry({
			reference: data.reference,
			source: data.source,
			name: data.name,
			useWhen: data.useWhen,
		});
		const body = knowledgeText(data.body, MAX_SKILL_BODY_BYTES);
		const hash = createHash("sha256").update(body).digest("hex");
		const loadKey = companySkillLoadKey(run, entry.reference, entry.source.version, hash);
		if (data.bodySha256 !== hash || data.loadKey !== loadKey) throw new CompanyKnowledgeError("invalid_object");
		if (entry.reference.kind === "platform") {
			const manifest = this.#platform.get(entry.reference.id)!;
			if (hash !== manifest.bodySha256 || Buffer.byteLength(body) !== manifest.bodyBytes)
				throw new CompanyKnowledgeError("invalid_object");
		}
		const output: CompanySkillContext = Object.freeze({
			schema: data.schema,
			run,
			loadKey,
			reference: entry.reference,
			source: entry.source,
			name: entry.name,
			useWhen: entry.useWhen,
			body,
			bodySha256: hash,
		});
		this.#checkContextBudget(output);
		await this.#assertSources([output.source], signal);
		await knowledgeRequest(
			(requestSignal) =>
				this.#assertRecordedLoad(
					{
						schema: "qorpera.skill-load/v1",
						loadKey,
						run: this.#session.run,
						reference: output.reference,
						source: output.source,
						name: output.name,
						useWhen: output.useWhen,
						bodySha256: hash,
						bodyBytes: Buffer.byteLength(body),
					},
					requestSignal,
				),
			signal,
			"record_unavailable",
		);
		await this.#assertSources([output.source], signal);
		return output;
	}

	/** Required before reuse/compaction of loaded procedures, not just before the first load. */
	async assertLoaded(signal: AbortSignal): Promise<void> {
		await this.#assertSources([...this.#loaded.values()], signal);
	}
}
