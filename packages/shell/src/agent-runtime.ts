import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	classifyToolCall,
	discoverAuthority,
	readAuthorityConfig,
	requestHash,
} from "@qorpera/pi-coding-agent/authority";
import type { KernelIntentCapability, KernelModelIntentBudget, ModelIntentTerminalStatus } from "@qorpera/pi-protocol";

export type { KernelIntentCapability, KernelModelIntentBudget } from "@qorpera/pi-protocol";

function normalizedPhysicalPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertPhysicalCompanyTree(root: string, relativePath: string): string {
	const canonicalRoot = realpathSync(resolve(root));
	const target = resolve(canonicalRoot, relativePath);
	const rootRelative = relative(canonicalRoot, target);
	if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative)) {
		throw new Error(`Company storage escaped its root: ${relativePath}`);
	}
	const visit = (path: string): void => {
		const entry = lstatSync(path);
		if (
			entry.isSymbolicLink() ||
			normalizedPhysicalPath(realpathSync(path)) !== normalizedPhysicalPath(path) ||
			(entry.isFile() && entry.nlink !== 1)
		) {
			throw new Error(`Company kernel storage must be one physical entry: ${relativePath}`);
		}
		if (entry.isDirectory()) {
			for (const child of readdirSync(path)) visit(join(path, child));
		}
	};
	visit(target);
	return target;
}

interface QorperaSessionAuthority {
	actor: "controller" | "product-worker";
	attended: boolean;
	autonomous?: boolean;
	label?: string;
	department?: string;
	worktree?: string;
}

interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	qorpera?: QorperaSessionAuthority;
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	kernel?: {
		sequence: number;
		receivedAt: string;
		previousHash: string | null;
		hash: string;
	};
	provenance?: {
		source: "kernel" | "child";
		trust: "observed" | "assertion";
	};
	[key: string]: unknown;
}

export interface AgentScope {
	actor: "controller" | "product-worker";
	attended: boolean;
	autonomousLabel?: string;
	department?: string;
	worktree?: string;
}

export interface TrailBinding {
	path: string;
	file: string;
	sessionId: string;
	cwd: string;
	token: string;
	authority: QorperaSessionAuthority;
	audit: { ids: Set<string>; sequence: number; lastHash: string };
}

export interface TrailAppendFrame {
	type: "qorpera_trail_append";
	token: string;
	entry: SessionEntry;
}

interface KernelWriteFrame {
	type: "qorpera_kernel_write";
	token: string;
	operation: "create_gate" | "consume_gate" | "trust_gate" | "append_notice" | "create_message";
	gate?: {
		id: string;
		file: string;
		effectClass: string;
		toolName: string;
		hash: string;
		args: unknown;
	};
	file?: string;
	message?: string;
	content?: string;
	status?: string;
	requestId?: string;
	hash?: string;
}

export interface KernelGateResponseBody {
	requestId: string;
	file: string;
	hash: string;
	granted: boolean;
}

export interface SignedKernelGateResponse extends KernelGateResponseBody {
	type: "qorpera_kernel_response";
	signature: string;
}

export interface SignedKernelBindingResponse {
	type: "qorpera_kernel_binding";
	nonce: string;
	sessionId: string;
	signature: string;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_TRAIL_ENTRY_BYTES = 16 * 1024 * 1024;
const TRAIL_SESSION_VERSION = 5;
const TRAIL_ENTRY_TYPES = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

function readHeader(path: string): SessionHeader {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_HEADER_BYTES);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, size).indexOf(0x0a);
		if (end < 0) throw new Error(`trail session header is missing or too large: ${path}`);
		const header = JSON.parse(buffer.subarray(0, end).toString("utf-8")) as SessionHeader;
		if (header.type !== "session" || typeof header.id !== "string") {
			throw new Error(`trail session has an invalid header: ${path}`);
		}
		return header;
	} finally {
		closeSync(fd);
	}
}

function authorityForScope(scope: AgentScope): QorperaSessionAuthority {
	if (scope.actor === "product-worker" && (!scope.department || !scope.worktree)) {
		throw new Error("product-worker sessions require an exact department and worktree assignment");
	}
	return {
		actor: scope.actor,
		attended: scope.attended,
		autonomous: scope.autonomousLabel ? true : undefined,
		label: scope.autonomousLabel,
		department: scope.department,
		worktree: scope.worktree,
	};
}

function assertMatchingAuthority(actual: QorperaSessionAuthority | undefined, expected: QorperaSessionAuthority): void {
	if (!actual) throw new Error("legacy trail sessions have no kernel authority binding and cannot be resumed");
	for (const key of ["actor", "department", "worktree"] as const) {
		if (actual[key] !== expected[key]) {
			throw new Error(`trail session authority does not match the requested ${key}`);
		}
	}
}

function validTrailEntry(entry: SessionEntry, ids: Set<string>): boolean {
	if (
		!TRAIL_ENTRY_TYPES.has(entry.type) ||
		typeof entry.id !== "string" ||
		entry.id.length === 0 ||
		entry.id.length > 128 ||
		ids.has(entry.id) ||
		(entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
	)
		return false;
	switch (entry.type) {
		case "message":
			return Boolean(entry.message && typeof entry.message === "object");
		case "thinking_level_change":
			return typeof entry.thinkingLevel === "string";
		case "model_change":
			return typeof entry.provider === "string" && typeof entry.modelId === "string";
		case "branch_summary":
			return typeof entry.fromId === "string" && ids.has(entry.fromId) && typeof entry.summary === "string";
		case "custom":
			return typeof entry.customType === "string";
		case "custom_message":
			return (
				typeof entry.customType === "string" &&
				(typeof entry.content === "string" || Array.isArray(entry.content)) &&
				typeof entry.display === "boolean"
			);
		case "label":
			return typeof entry.targetId === "string" && ids.has(entry.targetId);
		case "session_info":
			return entry.name === undefined || typeof entry.name === "string";
		default:
			return false;
	}
}

function validProvenance(entry: SessionEntry): boolean {
	return (
		Boolean(entry.provenance) &&
		(entry.provenance?.source === "kernel" || entry.provenance?.source === "child") &&
		(entry.provenance?.trust === "observed" || entry.provenance?.trust === "assertion") &&
		(entry.provenance.source === "kernel"
			? entry.provenance.trust === "observed"
			: entry.provenance.trust === "assertion")
	);
}

function unsignedTrailEntry(entry: SessionEntry): SessionEntry {
	const copy = { ...entry };
	delete copy.kernel;
	return copy;
}

function auditHash(entry: SessionEntry, previousHash: string): string {
	return createHash("sha256")
		.update(`${previousHash}\n${JSON.stringify(unsignedTrailEntry(entry))}`)
		.digest("hex");
}

function loadTrailAudit(path: string): TrailBinding["audit"] {
	const lines = readFileSync(path, "utf-8").split(/\r?\n/).slice(1).filter(Boolean);
	const audit: TrailBinding["audit"] = { ids: new Set(), sequence: 0, lastHash: "" };
	for (const line of lines) {
		const entry = JSON.parse(line) as SessionEntry;
		if (!validTrailEntry(entry, audit.ids) || !validProvenance(entry)) {
			throw new Error(`trail session contains an invalid event graph or provenance: ${path}`);
		}
		const kernel = entry.kernel;
		const expectedSequence = audit.sequence + 1;
		const expectedPrevious = audit.lastHash || null;
		if (
			!kernel ||
			kernel.sequence !== expectedSequence ||
			kernel.previousHash !== expectedPrevious ||
			kernel.receivedAt !== entry.timestamp ||
			kernel.hash !== auditHash(entry, audit.lastHash)
		) {
			throw new Error(`trail session integrity metadata is invalid: ${path}`);
		}
		audit.ids.add(entry.id);
		audit.sequence = kernel.sequence;
		audit.lastHash = kernel.hash;
	}
	return audit;
}

export function bindTrailSession(root: string, cwd: string, scope: AgentScope, sessionFile?: string): TrailBinding {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	const authority = authorityForScope(scope);
	let path: string;
	let sessionId: string;
	let audit: TrailBinding["audit"] = { ids: new Set(), sequence: 0, lastHash: "" };
	if (sessionFile) {
		if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
			throw new Error("trail session must be a JSONL filename inside the company trail");
		}
		path = join(trailDir, sessionFile);
		if (!existsSync(path)) throw new Error(`trail session does not exist: ${sessionFile}`);
		assertPhysicalCompanyTree(root, join("trail", sessionFile));
		const header = readHeader(path);
		sessionId = header.id;
		if (header.version !== TRAIL_SESSION_VERSION) {
			throw new Error(`trail session schema ${header.version ?? 1} requires an explicit append-only migration`);
		}
		assertMatchingAuthority(header.qorpera, authority);
		audit = loadTrailAudit(path);
	} else {
		const timestamp = new Date().toISOString();
		const id = randomUUID();
		sessionId = id;
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		path = join(trailDir, `${fileTimestamp}_${id}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: TRAIL_SESSION_VERSION,
			id,
			timestamp,
			cwd: resolve(cwd),
			qorpera: authority,
		};
		writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
	}
	return { path, file: basename(path), sessionId, cwd: resolve(cwd), token: randomUUID(), authority, audit };
}

export function parseTrailAppendFrame(value: unknown, binding: TrailBinding): TrailAppendFrame | undefined {
	if (!value || typeof value !== "object") return undefined;
	const frame = value as Partial<TrailAppendFrame>;
	if (frame.type !== "qorpera_trail_append" || frame.token !== binding.token) return undefined;
	const entry = frame.entry as unknown;
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as SessionEntry;
	if (Buffer.byteLength(JSON.stringify(record), "utf-8") > MAX_TRAIL_ENTRY_BYTES) return undefined;
	if (!validTrailEntry(record, binding.audit.ids)) return undefined;
	const receivedAt = new Date().toISOString();
	const stamped: SessionEntry = {
		...unsignedTrailEntry(record),
		timestamp: receivedAt,
		provenance: { source: "child", trust: "assertion" },
	};
	stamped.kernel = {
		sequence: binding.audit.sequence + 1,
		receivedAt,
		previousHash: binding.audit.lastHash || null,
		hash: "",
	};
	stamped.kernel.hash = auditHash(stamped, binding.audit.lastHash);
	return { type: "qorpera_trail_append", token: binding.token, entry: stamped };
}

function stampKernelEntry(binding: TrailBinding, entry: SessionEntry): TrailAppendFrame {
	const receivedAt = new Date().toISOString();
	const stamped: SessionEntry = {
		...unsignedTrailEntry(entry),
		timestamp: receivedAt,
		provenance: { source: "kernel", trust: "observed" },
	};
	stamped.kernel = {
		sequence: binding.audit.sequence + 1,
		receivedAt,
		previousHash: binding.audit.lastHash || null,
		hash: "",
	};
	stamped.kernel.hash = auditHash(stamped, binding.audit.lastHash);
	return { type: "qorpera_trail_append", token: binding.token, entry: stamped };
}

export function appendKernelObservation(
	binding: TrailBinding,
	input: {
		frameType: "prompt" | "steer" | "follow_up";
		message: string;
		attended: boolean;
		origin: string;
		intent: KernelIntentCapability;
		images: Array<{ mimeType: string; sha256: string; bytes: number }>;
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_input",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

export function appendKernelModelObservation(
	binding: TrailBinding,
	input: {
		event: "request" | "intent";
		intentNonce: string;
		requestHash: string;
		provider?: string;
		model?: string;
		requestSha256?: string;
		status: "started" | "completed" | "failed" | "aborted" | ModelIntentTerminalStatus;
		reservation?: { inputTokens: number; outputTokens: number; costUsd: number };
		usage?: { inputTokens: number; outputTokens: number; costUsd: number; calls?: number };
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_model_request",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

export function appendKernelWakeObservation(
	binding: TrailBinding,
	input: {
		/** Kernel-issued causal identity for this wake. */
		wakeId: string;
		cause: "schedule" | "founder_response" | "inbound_event";
		intervalMinutes?: number;
		/** Whole missed intervals coalesced into this wake (missed-wake policy). */
		coalesced?: number;
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_wake",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

export function appendKernelHttpObservation(
	binding: TrailBinding,
	input: {
		requestId: string;
		method: string;
		host: string;
		/** The URL exactly as the child sent it — secret references unresolved. */
		url: string;
		requestSha256: string;
		behavior?: { path: string; contentHash: string };
		status: "started" | "completed" | "failed" | "denied";
		deniedReason?: string;
		httpStatus?: number;
		bodyBytes?: number;
		/** File mode: company-relative paths streamed into / out of. */
		savedTo?: string;
		sentFile?: string;
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_http_request",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

export function appendKernelMutationObservation(
	binding: TrailBinding,
	input: {
		operation: string;
		exactReview: string;
		approved: boolean;
		phase: "decision" | "result";
		resultStatus?: number;
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_founder_mutation",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

export function appendKernelProductStorageObservation(
	binding: TrailBinding,
	input: {
		status: "hydration-required";
		paths: Array<{ path: string; kind: "repository" | "worktree" }>;
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_product_storage",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

function appendKernelGateObservation(
	binding: TrailBinding,
	input: {
		requestId?: string;
		file: string;
		hash: string;
		transition: "created" | "creation-aborted" | "consumed" | "orphan-reset" | "trusted-use";
		phase: "started" | "completed";
	},
): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType: "qorpera_kernel_gate_transition",
		data: input,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

function trailHasGateTransition(
	root: string,
	trailFile: string,
	file: string,
	hash: string,
	transition: "created" | "creation-aborted",
	phase: "started" | "completed",
): boolean {
	const path = assertPhysicalCompanyTree(root, join("trail", trailFile));
	loadTrailAudit(path);
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/).slice(1)) {
		if (!line) continue;
		const entry = JSON.parse(line) as SessionEntry;
		if (entry.type !== "custom" || entry.customType !== "qorpera_kernel_gate_transition") continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (data?.file === file && data.hash === hash && data.transition === transition && data.phase === phase)
			return true;
	}
	return false;
}

export function reconcileKernelGateCreations(
	binding: TrailBinding,
	root: string,
	pending: Array<{
		file: string;
		hash: string;
		trailFile: string;
		phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted";
	}>,
	advance: (
		file: string,
		hash: string,
		trailFile: string,
		phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted",
	) => void,
	complete: (file: string, hash: string) => void,
): void {
	for (const creation of pending) {
		let phase = creation.phase;
		let trailFile = creation.trailFile;
		if (phase === "planned") {
			if (trailHasGateTransition(root, trailFile, creation.file, creation.hash, "created", "started")) {
				phase = "started";
				advance(creation.file, creation.hash, trailFile, phase);
			} else {
				trailFile = binding.file;
				advance(creation.file, creation.hash, trailFile, "planned");
				appendKernelGateObservation(binding, {
					file: creation.file,
					hash: creation.hash,
					transition: "created",
					phase: "started",
				});
				phase = "started";
				advance(creation.file, creation.hash, trailFile, phase);
			}
		}
		if (phase === "started") {
			const path = join(root, "inbox", creation.file);
			let transition: "created" | "creation-aborted" = "creation-aborted";
			if (existsSync(path)) {
				assertPhysicalCompanyTree(root, join("inbox", creation.file));
				const record = parseGateDocument(creation.file, readFileSync(path, "utf-8"));
				if (!record || record.hash !== creation.hash) {
					throw new Error(`Pending kernel gate creation is not canonical: ${creation.file}`);
				}
				transition = "created";
			}
			phase = transition === "created" ? "finalizing-created" : "finalizing-aborted";
			trailFile = binding.file;
			advance(creation.file, creation.hash, trailFile, phase);
		}
		const transition = phase === "finalizing-created" ? "created" : "creation-aborted";
		if (!trailHasGateTransition(root, trailFile, creation.file, creation.hash, transition, "completed")) {
			if (trailFile !== binding.file) {
				trailFile = binding.file;
				advance(creation.file, creation.hash, trailFile, phase);
			}
			appendKernelGateObservation(binding, {
				file: creation.file,
				hash: creation.hash,
				transition,
				phase: "completed",
			});
		}
		complete(creation.file, creation.hash);
	}
}

const GATE_EFFECT_CLASSES = new Set(["money", "identity", "irreversible", "authority", "product_code"]);
const GATE_FIELDS = ["id", "status", "class", "tool", "hash", "created"] as const;

interface ParsedGateDocument {
	id: string;
	status: "pending" | "approved" | "denied" | "consumed";
	hash: string;
	tool: string;
	content: string;
}

function parseGateDocument(file: string, content: string): ParsedGateDocument | undefined {
	const normalized = content.replace(/^\uFEFF/, "");
	const frontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!frontmatter) return undefined;
	const fields = new Map<string, string>();
	for (const line of frontmatter[1].split(/\r?\n/)) {
		const match = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
		if (!match || !GATE_FIELDS.includes(match[1] as (typeof GATE_FIELDS)[number]) || fields.has(match[1])) {
			return undefined;
		}
		fields.set(match[1], match[2].split("#")[0].trim());
	}
	if (fields.size !== GATE_FIELDS.length || GATE_FIELDS.some((field) => !fields.has(field))) return undefined;
	const id = fields.get("id")!;
	const status = fields.get("status")!;
	const hash = fields.get("hash")!;
	if (`${id}.md` !== file || !/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?$/.test(id)) return undefined;
	if (!/^(pending|approved|denied|consumed)$/.test(status) || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
	if (!GATE_EFFECT_CLASSES.has(fields.get("class")!) || !fields.get("tool") || !fields.get("created"))
		return undefined;
	return {
		id,
		status: status as ParsedGateDocument["status"],
		hash,
		tool: fields.get("tool")!,
		content: normalized,
	};
}

/** Exact canonical pending record the trusted kernel shows before a founder transition. */
export function kernelGateReviewDocument(
	root: string,
	file: string,
	action: "approved" | "denied" = "approved",
): string | undefined {
	if (!/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?\.md$/.test(file)) return undefined;
	try {
		const record = parseGateDocument(file, readFileSync(join(root, "inbox", file), "utf-8"));
		if (record?.status === "pending") return record.content;
		if (
			action === "denied" &&
			record?.status === "consumed" &&
			(record.tool === "behavior_signature" || record.tool === "extension_load")
		)
			return record.content;
		return undefined;
	} catch {
		return undefined;
	}
}

function canonicalGateEffectClass(
	root: string,
	binding: TrailBinding,
	gate: NonNullable<KernelWriteFrame["gate"]>,
): string | undefined {
	if (gate.toolName === "behavior_signature" || gate.toolName === "extension_load") return "authority";
	const authority = discoverAuthority(binding.cwd);
	if (!authority || resolve(authority.root) !== resolve(root)) return undefined;
	return classifyToolCall(authority, readAuthorityConfig(authority), gate.toolName, gate.args, binding.cwd);
}

function canonicalGateContent(
	root: string,
	binding: TrailBinding,
	gate: NonNullable<KernelWriteFrame["gate"]>,
): string | undefined {
	const effectClass = canonicalGateEffectClass(root, binding, gate);
	if (
		`${gate.id}.md` !== gate.file ||
		!/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?$/.test(gate.id) ||
		!gate.id.startsWith(`gate-${gate.hash.slice(0, 8)}`) ||
		!/^[a-f0-9]{64}$/.test(gate.hash) ||
		!effectClass ||
		!GATE_EFFECT_CLASSES.has(effectClass) ||
		effectClass !== gate.effectClass ||
		requestHash(gate.toolName, gate.args) !== gate.hash ||
		!gate.toolName ||
		gate.toolName.length > 128 ||
		/[\r\n]/.test(gate.toolName)
	)
		return undefined;
	let serializedArgs: string;
	try {
		serializedArgs = JSON.stringify(gate.args, null, 2) ?? "null";
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(serializedArgs, "utf-8") > 1024 * 1024) return undefined;
	return [
		"---",
		`id: ${gate.id}`,
		"status: pending   # resolved by Qorpera Base native review",
		`class: ${effectClass}`,
		`tool: ${gate.toolName}`,
		`hash: ${gate.hash}`,
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		`# Gate request: ${gate.toolName} (${effectClass})`,
		"",
		"**Exact tool:**",
		"",
		`    ${gate.toolName}`,
		"",
		"**Exact arguments:**",
		"",
		...serializedArgs.split("\n").map((line) => `    ${line}`),
		"",
		"**If denied:** the agent will not perform this action and will pursue another path.",
		"",
		"Resolve this request through Qorpera Base's native review UI.",
		"",
	].join("\n");
}

function transitionGate(
	path: string,
	file: string,
	record: ParsedGateDocument,
	status: ParsedGateDocument["status"],
): void {
	const lines = record.content.split(/\r?\n/);
	const statusLines = lines.flatMap((line, index) => (/^status:\s*/.test(line) ? [index] : []));
	if (statusLines.length !== 1) throw new Error("gate status transition requires exactly one canonical status field");
	lines[statusLines[0]] = `status: ${status}`;
	const next = `${lines.join("\n")}${record.content.endsWith("\n") ? "\n" : ""}`;
	if (!parseGateDocument(file, next)) throw new Error("gate status transition produced an invalid record");
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, next, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, path);
}

export function commitTrailAppend(binding: TrailBinding, append: TrailAppendFrame): void {
	const kernel = append.entry.kernel;
	if (
		!kernel ||
		kernel.sequence !== binding.audit.sequence + 1 ||
		kernel.previousHash !== (binding.audit.lastHash || null)
	) {
		throw new Error("trail append integrity state changed before commit");
	}
	binding.audit.ids.add(append.entry.id);
	binding.audit.sequence = kernel.sequence;
	binding.audit.lastHash = kernel.hash;
}

export function applyKernelWriteFrame(
	value: unknown,
	binding: TrailBinding,
	root: string,
	onGateResponse?: (response: KernelGateResponseBody) => void,
	consumeGateCapability?: (file: string, hash: string) => boolean,
	durableGateTrust?: {
		has: (file: string, hash: string) => boolean;
		remember: (file: string, hash: string) => void;
	},
	gateCreation?: {
		begin: (file: string, hash: string, trailFile: string) => void;
		advance: (
			file: string,
			hash: string,
			trailFile: string,
			phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted",
		) => void;
		complete: (file: string, hash: string) => void;
	},
): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as Partial<KernelWriteFrame>;
	if (frame.type !== "qorpera_kernel_write") return false;
	if (frame.token !== binding.token) return true;
	const inbox = assertPhysicalCompanyTree(root, "inbox");
	if (frame.operation === "create_gate") {
		if (!frame.gate) return true;
		const content = canonicalGateContent(root, binding, frame.gate);
		if (!content) return true;
		const path = join(inbox, frame.gate.file);
		if (existsSync(path)) return true;
		gateCreation?.begin(frame.gate.file, frame.gate.hash, binding.file);
		appendKernelGateObservation(binding, {
			file: frame.gate.file,
			hash: frame.gate.hash,
			transition: "created",
			phase: "started",
		});
		gateCreation?.advance(frame.gate.file, frame.gate.hash, binding.file, "started");
		let created = false;
		try {
			writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		gateCreation?.advance(
			frame.gate.file,
			frame.gate.hash,
			binding.file,
			created ? "finalizing-created" : "finalizing-aborted",
		);
		if (created) {
			appendKernelGateObservation(binding, {
				file: frame.gate.file,
				hash: frame.gate.hash,
				transition: "created",
				phase: "completed",
			});
		} else {
			appendKernelGateObservation(binding, {
				file: frame.gate.file,
				hash: frame.gate.hash,
				transition: "creation-aborted",
				phase: "completed",
			});
		}
		gateCreation?.complete(frame.gate.file, frame.gate.hash);
		return true;
	}
	if (frame.operation === "create_message") {
		if (
			typeof frame.requestId !== "string" ||
			typeof frame.file !== "string" ||
			!/^msg-[a-z0-9][a-z0-9-]{0,119}\.md$/i.test(frame.file) ||
			typeof frame.content !== "string" ||
			Buffer.byteLength(frame.content, "utf-8") > 64 * 1024 ||
			typeof frame.hash !== "string" ||
			createHash("sha256").update(frame.content).digest("hex") !== frame.hash
		) {
			return true;
		}
		let granted = false;
		try {
			writeFileSync(join(inbox, "messages", frame.file), frame.content, { encoding: "utf-8", flag: "wx" });
			granted = true;
			const append = stampKernelEntry(binding, {
				type: "custom",
				id: randomUUID(),
				parentId: null,
				timestamp: "",
				customType: "qorpera_kernel_inbox_message",
				data: { file: frame.file, hash: frame.hash, content: frame.content },
			});
			appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
			commitTrailAppend(binding, append);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted });
		return true;
	}
	if (frame.operation === "consume_gate" || frame.operation === "trust_gate") {
		if (
			frame.status !== "consumed" ||
			!frame.file ||
			!/^gate-[a-z0-9-]+\.md$/i.test(frame.file) ||
			typeof frame.requestId !== "string" ||
			typeof frame.hash !== "string"
		)
			return true;
		const path = join(inbox, frame.file);
		let record: ParsedGateDocument | undefined;
		try {
			record = parseGateDocument(frame.file, readFileSync(path, "utf-8"));
		} catch {
			onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted: false });
			return true;
		}
		const matchesHash = Boolean(record && record.hash === frame.hash);
		const durableTool = Boolean(record && (record.tool === "behavior_signature" || record.tool === "extension_load"));
		if (
			frame.operation === "trust_gate" &&
			matchesHash &&
			durableTool &&
			record?.status === "consumed" &&
			durableGateTrust?.has(frame.file, frame.hash)
		) {
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "trusted-use",
				phase: "completed",
			});
			onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted: true });
			return true;
		}
		const matchesApprovedRecord = Boolean(matchesHash && record?.status === "approved");
		const capabilityGranted = Boolean(matchesApprovedRecord && consumeGateCapability?.(frame.file, frame.hash));
		const granted = Boolean(
			capabilityGranted && (frame.operation === "consume_gate" || (durableTool && durableGateTrust)),
		);
		if (granted && record) {
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "consumed",
				phase: "started",
			});
			transitionGate(path, frame.file, record, "consumed");
			if (frame.operation === "trust_gate") durableGateTrust?.remember(frame.file, frame.hash);
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "consumed",
				phase: "completed",
			});
		} else if (
			matchesHash &&
			record &&
			(record.status === "approved" || (frame.operation === "trust_gate" && record.status === "consumed"))
		) {
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "orphan-reset",
				phase: "started",
			});
			transitionGate(path, frame.file, record, "pending");
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "orphan-reset",
				phase: "completed",
			});
		}
		onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted });
		return true;
	}
	if (frame.operation === "append_notice") {
		if (typeof frame.message !== "string" || Buffer.byteLength(frame.message) > 4096) return true;
		const path = join(inbox, "notices.md");
		const prefix = existsSync(path) ? "" : "# Notices\n\n";
		appendFileSync(path, `${prefix}- ${new Date().toISOString()} ${frame.message.replace(/[\r\n]+/g, " ")}\n`);
	}
	return true;
}

function kernelResponsePayload(response: KernelGateResponseBody): string {
	return JSON.stringify({
		requestId: response.requestId,
		file: response.file,
		hash: response.hash,
		granted: response.granted,
	});
}

function kernelBindingPayload(response: { nonce: string; sessionId: string }): string {
	return JSON.stringify({ nonce: response.nonce, sessionId: response.sessionId });
}

function kernelIntentPayload(intent: Omit<KernelIntentCapability, "signature">): string {
	return JSON.stringify({
		nonce: intent.nonce,
		sessionId: intent.sessionId,
		requestHash: intent.requestHash,
		attended: intent.attended,
		issuedAt: intent.issuedAt,
		expiresAt: intent.expiresAt,
		budget: {
			maxCalls: intent.budget.maxCalls,
			maxInputTokens: intent.budget.maxInputTokens,
			maxOutputTokens: intent.budget.maxOutputTokens,
			maxCostUsd: intent.budget.maxCostUsd,
		},
	});
}

function intentRequestHash(frame: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(frame)).digest("hex");
}

export const DEFAULT_MODEL_INTENT_BUDGET: Readonly<KernelModelIntentBudget> = Object.freeze({
	maxCalls: 64,
	maxInputTokens: 16_000_000,
	maxOutputTokens: 1_000_000,
	maxCostUsd: 100,
});

const DEFAULT_MODEL_INTENT_LIFETIME_MS = 30 * 60 * 1000;
const MAX_MODEL_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;

function checkedModelIntentBudget(budget: KernelModelIntentBudget): KernelModelIntentBudget {
	if (
		!Number.isInteger(budget.maxCalls) ||
		budget.maxCalls < 1 ||
		!Number.isInteger(budget.maxInputTokens) ||
		budget.maxInputTokens < 1 ||
		!Number.isInteger(budget.maxOutputTokens) ||
		budget.maxOutputTokens < 1 ||
		!Number.isFinite(budget.maxCostUsd) ||
		budget.maxCostUsd < 0
	) {
		throw new Error("kernel model intent budget is invalid");
	}
	return { ...budget };
}

export function createKernelResponseSigner(options: {
	sessionId: string;
	modelBudget?: KernelModelIntentBudget;
	intentLifetimeMs?: number;
}): {
	publicKey: string;
	signResponse: (response: KernelGateResponseBody) => SignedKernelGateResponse;
	signBinding: (response: { nonce: string; sessionId: string }) => SignedKernelBindingResponse;
	signIntent: (frame: Record<string, unknown>, attended: boolean) => KernelIntentCapability;
} {
	if (!options.sessionId) throw new Error("kernel intent signer requires a session id");
	const budget = checkedModelIntentBudget(options.modelBudget ?? DEFAULT_MODEL_INTENT_BUDGET);
	const lifetimeMs = options.intentLifetimeMs ?? DEFAULT_MODEL_INTENT_LIFETIME_MS;
	if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_MODEL_INTENT_LIFETIME_MS) {
		throw new Error("kernel model intent lifetime is invalid");
	}
	const pair = generateKeyPairSync("ed25519");
	const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
	return {
		publicKey,
		signResponse: (response) => ({
			type: "qorpera_kernel_response",
			...response,
			signature: sign(null, Buffer.from(kernelResponsePayload(response)), pair.privateKey).toString("base64"),
		}),
		signBinding: (response) => ({
			type: "qorpera_kernel_binding",
			...response,
			signature: sign(null, Buffer.from(kernelBindingPayload(response)), pair.privateKey).toString("base64"),
		}),
		signIntent: (frame, attended) => {
			const issuedAtMs = Date.now();
			const intent = {
				nonce: randomUUID(),
				sessionId: options.sessionId,
				requestHash: intentRequestHash(frame),
				attended,
				issuedAt: new Date(issuedAtMs).toISOString(),
				expiresAt: new Date(issuedAtMs + lifetimeMs).toISOString(),
				budget: { ...budget },
			};
			return {
				...intent,
				signature: sign(null, Buffer.from(kernelIntentPayload(intent)), pair.privateKey).toString("base64"),
			};
		},
	};
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

export function writeSandboxProfile(
	configDir: string,
	runtimeDir: string,
	companyRoot: string,
	scope: AgentScope,
	protectedPaths: string[],
	foundationReadPaths: string[],
): string {
	mkdirSync(configDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	const permissions = new Map<string, "read" | "write">([
		[":minimal", "read"],
		[":tmpdir", "write"],
		[":slash_tmp", "write"],
		[resolve(runtimeDir), "write"],
		[resolve(companyRoot), scope.actor === "controller" ? "write" : "read"],
	]);
	for (const path of foundationReadPaths) permissions.set(resolve(path), "read");
	for (const path of protectedPaths) permissions.set(resolve(path), "read");
	if (scope.actor === "controller") {
		// The one sanctioned agent-writable inbox lane (authority.ts
		// isProtectedPath): the controller authors inbox/messages/msg-*.md
		// items. The OS grant is directory-level; which FILES inside are
		// legitimate stays enforced at the tool boundary. Gate records and
		// notices live at inbox/ root and remain read-only here.
		permissions.set(join(resolve(companyRoot), "inbox", "messages"), "write");
	}
	if (scope.actor === "product-worker") {
		const worktree = resolve(companyRoot, scope.worktree!);
		permissions.set(worktree, "write");
		permissions.set(join(worktree, ".git"), "read");
	}

	const filesystem = [...permissions]
		.map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`)
		.join("\n");
	const windows = process.platform === "win32" ? '\n[windows]\nsandbox = "elevated"\n' : "";
	const config = `default_permissions = "qorpera-agent"\n${windows}\n[features]\nnetwork_proxy = false\n\n[network]\nenabled = false\n\n[permissions.qorpera-agent.filesystem]\n${filesystem}\n\n[permissions.qorpera-agent.network]\nenabled = false\n`;
	const configPath = join(configDir, "config.toml");
	writeFileSync(configPath, config, "utf-8");
	return configPath;
}

export function sandboxCommandArgs(codexEntry: string, runtimeDir: string, program: string, args: string[]): string[] {
	return [
		codexEntry,
		"sandbox",
		"--permission-profile",
		"qorpera-agent",
		"-C",
		resolve(runtimeDir),
		"--",
		program,
		...args,
	];
}

/**
 * Spawn shape for a sandboxCommandArgs() invocation. A native codex.exe entry
 * is executed directly (spawning it through the npm wrapper script would
 * re-spawn the binary without windowsHide and flash a console window on
 * Windows); a wrapper-script entry runs under the given node executable.
 */
export function codexSpawn(
	codexEntry: string,
	nodeExecutable: string,
	sandboxArgs: string[],
): { command: string; args: string[] } {
	if (codexEntry.toLowerCase().endsWith(".exe")) return { command: codexEntry, args: sandboxArgs.slice(1) };
	return { command: nodeExecutable, args: sandboxArgs };
}

/**
 * Exercise the bundled Codex sandbox before an agent is started. On a clean
 * Windows profile this invokes Codex's supported elevated setup path; on an
 * existing profile Codex validates and refreshes its own ACL/firewall state.
 * No sandbox marker, DPAPI secret, or ACL record is copied by Qorpera.
 */
export function provisionWindowsSandbox(options: {
	codexEntry: string;
	configDir: string;
	runtimeDir: string;
	nodeExecutable: string;
	env: NodeJS.ProcessEnv;
}): void {
	if (process.platform !== "win32") return;
	const env = {
		...options.env,
		CODEX_HOME: options.configDir,
		ELECTRON_RUN_AS_NODE: "1",
	};
	const systemRoot = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? options.env.WINDIR;
	if (!systemRoot) {
		throw new Error("Bundled Codex Windows sandbox provisioning failed: Windows system root is unavailable.");
	}
	const whoami = join(systemRoot, "System32", "whoami.exe");
	const identityInvocation = codexSpawn(
		options.codexEntry,
		options.nodeExecutable,
		sandboxCommandArgs(options.codexEntry, options.runtimeDir, whoami, []),
	);
	const identity = spawnSync(identityInvocation.command, identityInvocation.args, {
		cwd: options.runtimeDir,
		env,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
		timeout: 10 * 60 * 1000,
		windowsHide: true,
	});
	if (
		identity.error ||
		identity.status !== 0 ||
		!identity.stdout.trim().toLowerCase().includes("codexsandboxoffline")
	) {
		const detail = [identity.error?.message, identity.stderr, identity.stdout]
			.filter((value): value is string => Boolean(value?.trim()))
			.join("\n")
			.trim()
			.slice(0, 4096);
		throw new Error(
			`Bundled Codex Windows sandbox provisioning failed; Qorpera will not start the controller.${detail ? `\n${detail}` : ""}`,
		);
	}

	assertSandboxNetworkIsolation({ ...options, env });
}

/**
 * Exercise the effective offline identity, not only the sandbox's setup
 * marker. Any successful direct HTTPS request means network isolation is
 * absent or stale, so the controller must not start.
 */
function assertSandboxNetworkIsolation(options: {
	codexEntry: string;
	runtimeDir: string;
	nodeExecutable: string;
	env: NodeJS.ProcessEnv;
}): void {
	const networkInvocation = codexSpawn(
		options.codexEntry,
		options.nodeExecutable,
		sandboxCommandArgs(options.codexEntry, options.runtimeDir, options.nodeExecutable, [
			"-e",
			'Promise.any([fetch("https://example.com/"),fetch("https://api.openai.com/")]).then(()=>process.exit(42),()=>process.exit(0))',
		]),
	);
	const network = spawnSync(networkInvocation.command, networkInvocation.args, {
		cwd: options.runtimeDir,
		env: options.env,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
		windowsHide: true,
	});
	if (network.error || network.status !== 0) {
		const detail = [network.error?.message, network.stderr, network.stdout]
			.filter((value): value is string => Boolean(value?.trim()))
			.join("\n")
			.trim()
			.slice(0, 4096);
		throw new Error(
			`Bundled Codex sandbox network isolation failed; Qorpera will not start the controller.${detail ? `\n${detail}` : ""}`,
		);
	}
}

/**
 * Fail-closed sandbox verification on every platform (manifesto §7.2 —
 * isolation strength is stated honestly or the controller does not start).
 * Windows adds the Codex offline-identity check; every platform must prove
 * network isolation is actually enforced before an agent runs. If the
 * bundled sandbox no-ops on a platform, the probe's fetch succeeds and the
 * kernel refuses to start rather than running an agent with an unenforced
 * profile.
 */
export function provisionSandbox(options: {
	codexEntry: string;
	configDir: string;
	runtimeDir: string;
	nodeExecutable: string;
	env: NodeJS.ProcessEnv;
}): void {
	if (process.platform === "win32") {
		provisionWindowsSandbox(options);
		return;
	}
	assertSandboxNetworkIsolation({
		...options,
		env: { ...options.env, CODEX_HOME: options.configDir, ELECTRON_RUN_AS_NODE: "1" },
	});
}

export function protectedControllerPaths(
	root: string,
	productPaths: Array<{ repository: string; worktrees: string }>,
): string[] {
	return [
		join(root, ".git"),
		join(root, "trail"),
		join(root, "authority.toml"),
		join(root, "AGENTS.md"),
		join(root, "CLAUDE.md"),
		join(root, ".qorpera"),
		join(root, "inbox"),
		...productPaths.flatMap((product) => [join(root, product.repository), join(root, product.worktrees)]),
	];
}

export function inboxMessagesPath(root: string): string {
	return assertPhysicalCompanyTree(root, join("inbox", "messages"));
}

export function sandboxConfigDir(userData: string, root: string, actor: AgentScope["actor"]): string {
	return join(userData, "agent-sandbox", sandboxRootId(root), actor);
}

export function sandboxRuntimeDir(
	userData: string,
	root: string,
	actor: AgentScope["actor"],
	capabilityId: string,
): string {
	if (!/^[0-9a-f-]{36}$/i.test(capabilityId)) throw new Error("sandbox runtime requires a capability identifier");
	if (process.platform === "win32") {
		const programData = process.env.ProgramData ?? process.env.PROGRAMDATA;
		if (!programData) throw new Error("Qorpera sandbox runtime requires the Windows ProgramData directory");
		return join(programData, "Qorpera", "agent-sandbox-runtime", sandboxRootId(root), actor, capabilityId);
	}
	return join(dirname(sandboxConfigDir(userData, root, actor)), "runtime", actor, capabilityId);
}

function sandboxRootId(root: string): string {
	const resolvedRoot = resolve(root);
	return createHash("sha256")
		.update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
		.digest("hex");
}
