import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { advanceTrailAuditState, createTrailAuditState } from "./agent-runtime.ts";
import { companyRootId } from "./company-host-state.ts";

export type ConnectionRequestStatus = "pending" | "connecting" | "connected" | "denied" | "failed" | "cancelled";

export const CONNECTION_INTENT_PHASES = Object.freeze([
	"suggested",
	"selected",
	"preparing",
	"awaiting_setup",
	"awaiting_auth",
	"verifying",
	"connected",
	"syncing",
	"ready",
	"failed",
	"denied",
	"cancelled",
] as const);
export type ConnectionIntentPhase = (typeof CONNECTION_INTENT_PHASES)[number];
export type ConnectionIntentActor = "agent" | "founder" | "host";
export type ConnectionIntentSelectionKind = "suggestion" | "custom";

export interface ConnectionIntentSelection {
	label: string;
	kind: ConnectionIntentSelectionKind;
	selectedAt: string;
}

export interface ConnectionIntentEvent {
	sequence: number;
	phase: ConnectionIntentPhase;
	actor: ConnectionIntentActor;
	at: string;
}

export interface ConnectionIntentSelectionInput {
	label: string;
	kind: ConnectionIntentSelectionKind;
}

export interface ConnectionRequestDestination {
	host: string;
	note?: string;
}

export interface ConnectionRequest {
	id: string;
	staffAgentId: string;
	sessionFile: string;
	displayName: string;
	purpose: string;
	destinations: ConnectionRequestDestination[];
	secretNames: string[];
	providerSuggestions?: string[];
	recipeId?: string;
	artifactId?: string;
	dataNeedId?: string;
	status: ConnectionRequestStatus;
	phase: ConnectionIntentPhase;
	selection?: ConnectionIntentSelection;
	events: ConnectionIntentEvent[];
	createdAt: string;
	updatedAt: string;
	failure?: string;
	grantId?: string;
}

export interface CreateConnectionRequestInput {
	staffAgentId: string;
	sessionFile: string;
	displayName: string;
	purpose: string;
	destinations: ConnectionRequestDestination[];
	secretNames: string[];
	providerSuggestions?: string[];
	recipeId?: string;
	artifactId?: string;
	dataNeedId?: string;
}

export interface RetriedConnectionRequest {
	request: ConnectionRequest;
	superseded: ConnectionRequest[];
}

export interface ConnectionRequestIdentity {
	id: string;
	staffAgentId: string;
	sessionFile: string;
}

/** Deliberately omits credential reference names. Connector recipes and OAuth
 * bodies are never stored in this module, so this is safe for the fixed shell read model. */
export interface RendererConnectionRequest {
	id: string;
	staffAgentId: string;
	sessionFile: string;
	displayName: string;
	purpose: string;
	destinations: ConnectionRequestDestination[];
	providerSuggestions?: string[];
	recipeId?: string;
	artifactId?: string;
	dataNeedId?: string;
	status: ConnectionRequestStatus;
	phase: ConnectionIntentPhase;
	/** Quiet, provider-specific next step derived from durable lifecycle state. */
	guidance?: string;
	selection?: ConnectionIntentSelection;
	createdAt: string;
	updatedAt: string;
	failure?: string;
	grantId?: string;
}

interface ConnectionRequestState {
	version: 1;
	root: string;
	rootIdentity: string;
	requests: Record<string, ConnectionRequest>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]*\.jsonl$/i;
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._:/-]{0,126}[a-z0-9])?$/i;
const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/i;
const DATA_NEED_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CONNECTION_REQUEST_STATUSES = new Set<ConnectionRequestStatus>([
	"pending",
	"connecting",
	"connected",
	"denied",
	"failed",
	"cancelled",
]);
const CONNECTION_INTENT_PHASE_SET = new Set<ConnectionIntentPhase>(CONNECTION_INTENT_PHASES);
const CONNECTION_INTENT_ACTORS = new Set<ConnectionIntentActor>(["agent", "founder", "host"]);
const CONNECTION_INTENT_SELECTION_KINDS = new Set<ConnectionIntentSelectionKind>(["suggestion", "custom"]);
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 1_000;
const MAX_REQUEST_EVENTS = 32;
const MAX_TRAIL_BYTES = 64 * 1024 * 1024;

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalRoot(root: string): string {
	const canonical = realpathSync(resolve(root));
	const entry = lstatSync(canonical, { bigint: true });
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error("Connection requests require a physical company root");
	}
	return canonical;
}

function rootIdentity(root: string): string {
	const entry = lstatSync(root, { bigint: true });
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error("Connection requests require a physical company root");
	}
	return `${entry.dev.toString(16)}:${entry.ino.toString(16)}:${entry.birthtimeNs.toString(16)}`;
}

export function connectionRequestsStatePath(userData: string, root: string): string {
	return join(userData, "connection-requests", companyRootId(canonicalRoot(root)), "state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function validUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validText(value: unknown, maximumBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		!CONTROL_CHARACTER_PATTERN.test(value) &&
		Buffer.byteLength(value, "utf-8") <= maximumBytes
	);
}

function validSessionFile(value: unknown): value is string {
	return (
		typeof value === "string" &&
		basename(value) === value &&
		SESSION_FILE_PATTERN.test(value) &&
		Buffer.byteLength(value, "utf-8") <= 255
	);
}

function normalizedDestination(value: unknown): ConnectionRequestDestination | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(["host", "note"])) || typeof value.host !== "string") {
		return undefined;
	}
	const host = value.host.trim().toLowerCase();
	if (
		!host ||
		Buffer.byteLength(host, "utf-8") > 259 ||
		host.includes("://") ||
		host.includes("/") ||
		host.includes("@")
	) {
		return undefined;
	}
	const match = host.match(/^([^:]+)(?::([0-9]{1,5}))?$/);
	if (!match?.[1]) return undefined;
	const hostname = match[1];
	if (
		hostname.length > 253 ||
		hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		return undefined;
	}
	if (match[2] !== undefined) {
		const port = Number(match[2]);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	}
	if (value.note !== undefined && !validText(value.note, 240)) return undefined;
	return { host, ...(value.note !== undefined ? { note: value.note } : {}) };
}

function normalizedSecretNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > 32) return undefined;
	const names: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string") return undefined;
		const name = candidate.trim().toLowerCase();
		if (!SECRET_NAME_PATTERN.test(name) || seen.has(name)) return undefined;
		seen.add(name);
		names.push(name);
	}
	return names;
}

function normalizedProviderSuggestions(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length < 2 || value.length > 4) return undefined;
	const suggestions: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (!validText(candidate, 80) || candidate.toLowerCase().includes("secret://")) return undefined;
		const normalized = candidate.toLowerCase();
		if (seen.has(normalized)) return undefined;
		seen.add(normalized);
		suggestions.push(candidate);
	}
	return suggestions;
}

function normalizedDestinations(value: unknown): ConnectionRequestDestination[] | undefined {
	if (!Array.isArray(value) || value.length > 32) return undefined;
	const destinations: ConnectionRequestDestination[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		const destination = normalizedDestination(candidate);
		if (!destination || seen.has(destination.host)) return undefined;
		seen.add(destination.host);
		destinations.push(destination);
	}
	return destinations;
}

function validFailure(value: unknown): value is string {
	return (
		validText(value, 240) &&
		!value.includes("://") &&
		!/[{}<>="'&?]/.test(value) &&
		!value.toLowerCase().includes("secret://")
	);
}

function validSelection(value: unknown): value is ConnectionIntentSelection {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, new Set(["label", "kind", "selectedAt"])) &&
		validText(value.label, 240) &&
		typeof value.kind === "string" &&
		CONNECTION_INTENT_SELECTION_KINDS.has(value.kind as ConnectionIntentSelectionKind) &&
		validTimestamp(value.selectedAt)
	);
}

function validEvents(value: unknown): value is ConnectionIntentEvent[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUEST_EVENTS) return false;
	return value.every(
		(event, index) =>
			isRecord(event) &&
			hasOnlyKeys(event, new Set(["sequence", "phase", "actor", "at"])) &&
			event.sequence === index + 1 &&
			typeof event.phase === "string" &&
			CONNECTION_INTENT_PHASE_SET.has(event.phase as ConnectionIntentPhase) &&
			typeof event.actor === "string" &&
			CONNECTION_INTENT_ACTORS.has(event.actor as ConnectionIntentActor) &&
			validTimestamp(event.at),
	);
}

function phaseMatchesStatus(status: ConnectionRequestStatus, phase: ConnectionIntentPhase): boolean {
	if (status === "pending") return phase === "suggested" || phase === "selected" || phase === "preparing";
	if (status === "connecting") return phase === "awaiting_setup" || phase === "awaiting_auth" || phase === "verifying";
	if (status === "connected") return phase === "connected" || phase === "syncing" || phase === "ready";
	return status === phase;
}

function legacyPhase(status: unknown): ConnectionIntentPhase | undefined {
	if (status === "pending") return "suggested";
	if (status === "connecting") return "awaiting_auth";
	if (status === "connected") return "connected";
	if (status === "failed" || status === "denied" || status === "cancelled") return status;
	return undefined;
}

function migrateLegacyRequest(value: unknown): unknown {
	if (!isRecord(value)) return value;
	let migrated = value;
	if (value.phase === undefined && value.events === undefined) {
		const phase = legacyPhase(value.status);
		if (!phase || !validTimestamp(value.updatedAt)) return value;
		migrated = {
			...value,
			phase,
			events: [{ sequence: 1, phase, actor: "host", at: value.updatedAt }],
		};
	}
	if (
		!Array.isArray(migrated.events) ||
		!migrated.events.some((event) => isRecord(event) && event.actor === "kernel")
	) {
		return migrated;
	}
	return {
		...migrated,
		events: migrated.events.map((event) =>
			isRecord(event) && event.actor === "kernel" ? { ...event, actor: "host" } : event,
		),
	};
}

function validRequest(value: unknown): value is ConnectionRequest {
	if (!isRecord(value)) return false;
	const destinations = normalizedDestinations(value.destinations);
	const secretNames = normalizedSecretNames(value.secretNames);
	const providerSuggestions = normalizedProviderSuggestions(value.providerSuggestions);
	const events = value.events;
	if (
		!hasOnlyKeys(
			value,
			new Set([
				"id",
				"staffAgentId",
				"sessionFile",
				"displayName",
				"purpose",
				"destinations",
				"secretNames",
				"providerSuggestions",
				"recipeId",
				"artifactId",
				"dataNeedId",
				"status",
				"phase",
				"selection",
				"events",
				"createdAt",
				"updatedAt",
				"failure",
				"grantId",
			]),
		) ||
		!validUuid(value.id) ||
		value.id !== value.id.toLowerCase() ||
		!validUuid(value.staffAgentId) ||
		value.staffAgentId !== value.staffAgentId.toLowerCase() ||
		!validSessionFile(value.sessionFile) ||
		!validText(value.displayName, 120) ||
		!validText(value.purpose, 1_000) ||
		!destinations ||
		JSON.stringify(destinations) !== JSON.stringify(value.destinations) ||
		!secretNames ||
		JSON.stringify(secretNames) !== JSON.stringify(value.secretNames) ||
		(value.providerSuggestions !== undefined &&
			(!providerSuggestions || JSON.stringify(providerSuggestions) !== JSON.stringify(value.providerSuggestions))) ||
		(value.recipeId !== undefined && value.providerSuggestions !== undefined) ||
		(value.recipeId !== undefined && (typeof value.recipeId !== "string" || !SAFE_ID_PATTERN.test(value.recipeId))) ||
		(value.artifactId !== undefined &&
			(typeof value.artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(value.artifactId))) ||
		(value.dataNeedId !== undefined &&
			(typeof value.dataNeedId !== "string" || !DATA_NEED_ID_PATTERN.test(value.dataNeedId))) ||
		(value.artifactId === undefined) !== (value.dataNeedId === undefined) ||
		typeof value.status !== "string" ||
		!CONNECTION_REQUEST_STATUSES.has(value.status as ConnectionRequestStatus) ||
		typeof value.phase !== "string" ||
		!CONNECTION_INTENT_PHASE_SET.has(value.phase as ConnectionIntentPhase) ||
		!phaseMatchesStatus(value.status as ConnectionRequestStatus, value.phase as ConnectionIntentPhase) ||
		(value.selection !== undefined && !validSelection(value.selection)) ||
		!validEvents(events) ||
		!validTimestamp(value.createdAt) ||
		!validTimestamp(value.updatedAt) ||
		Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
		(value.failure !== undefined && !validFailure(value.failure)) ||
		(value.grantId !== undefined && (typeof value.grantId !== "string" || !SAFE_ID_PATTERN.test(value.grantId)))
	) {
		return false;
	}
	if (events.at(-1)?.phase !== value.phase || events.at(-1)?.at !== value.updatedAt) return false;
	if (events.some((event) => Date.parse(event.at) < Date.parse(value.createdAt as string))) return false;
	if (value.status === "connected") return value.grantId !== undefined && value.failure === undefined;
	if (value.status === "failed") return value.grantId === undefined;
	return value.failure === undefined && value.grantId === undefined;
}

function copyRequest(request: ConnectionRequest): ConnectionRequest {
	return {
		...request,
		destinations: request.destinations.map((destination) => ({ ...destination })),
		secretNames: [...request.secretNames],
		...(request.providerSuggestions ? { providerSuggestions: [...request.providerSuggestions] } : {}),
		...(request.selection ? { selection: { ...request.selection } } : {}),
		events: request.events.map((event) => ({ ...event })),
	};
}

function emptyState(root: string): ConnectionRequestState {
	return { version: 1, root, rootIdentity: rootIdentity(root), requests: {} };
}

function readState(userData: string, root: string): ConnectionRequestState | undefined {
	const canonical = canonicalRoot(root);
	const path = connectionRequestsStatePath(userData, canonical);
	if (!existsSync(path)) return undefined;
	const entry = lstatSync(path);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.nlink !== 1 ||
		entry.size > MAX_STATE_BYTES ||
		(process.platform !== "win32" && (entry.mode & 0o077) !== 0)
	) {
		throw new Error("Connection request state must be one private physical file");
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (
		!isRecord(parsed) ||
		!hasOnlyKeys(parsed, new Set(["version", "root", "rootIdentity", "requests"])) ||
		parsed.version !== 1 ||
		typeof parsed.root !== "string" ||
		normalizedPath(parsed.root) !== normalizedPath(canonical) ||
		parsed.rootIdentity !== rootIdentity(canonical) ||
		!isRecord(parsed.requests) ||
		Object.keys(parsed.requests).length > MAX_REQUESTS
	) {
		throw new Error("Connection request state is invalid");
	}
	const requests = parsed.requests as Record<string, unknown>;
	for (const [id, requestValue] of Object.entries(requests)) {
		const request = migrateLegacyRequest(requestValue);
		if (id !== id.toLowerCase() || !validRequest(request) || request.id !== id) {
			throw new Error("Connection request state is invalid");
		}
		requests[id] = request;
	}
	return parsed as unknown as ConnectionRequestState;
}

function writeState(userData: string, state: ConnectionRequestState): void {
	const canonical = canonicalRoot(state.root);
	if (normalizedPath(canonical) !== normalizedPath(state.root) || state.rootIdentity !== rootIdentity(canonical)) {
		throw new Error("Connection request company identity changed before write");
	}
	const path = connectionRequestsStatePath(userData, canonical);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function reconstructedState(root: string): ConnectionRequestState | undefined {
	const canonical = canonicalRoot(root);
	const trailDirectory = join(canonical, "trail");
	if (!existsSync(trailDirectory)) return undefined;
	const directoryEntry = lstatSync(trailDirectory);
	if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) return undefined;
	const state = emptyState(canonical);
	for (const file of readdirSync(trailDirectory)) {
		if (!validSessionFile(file)) continue;
		const path = join(trailDirectory, file);
		try {
			const entry = lstatSync(path);
			if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > MAX_TRAIL_BYTES) continue;
			const lines = readFileSync(path, "utf-8")
				.split(/\r?\n/)
				.filter((line) => line.trim());
			const header = JSON.parse(lines[0] ?? "") as unknown;
			if (!isRecord(header) || header.type !== "session") continue;
			const audit = createTrailAuditState();
			for (const line of lines.slice(1)) advanceTrailAuditState(audit, JSON.parse(line), path);
			if (audit.sequence === 0) continue;
			for (const line of lines.slice(1)) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as unknown;
				if (!isRecord(record) || record.type !== "custom" || record.customType !== "qorpera_kernel_connection") {
					continue;
				}
				const provenance = isRecord(record.provenance) ? record.provenance : undefined;
				const data = isRecord(record.data) ? record.data : undefined;
				const request = migrateLegacyRequest(data?.request);
				if (
					provenance?.source !== "kernel" ||
					provenance.trust !== "observed" ||
					data?.version !== 1 ||
					!validRequest(request)
				) {
					continue;
				}
				const existing = state.requests[request.id];
				if (
					!existing ||
					Date.parse(request.updatedAt) > Date.parse(existing.updatedAt) ||
					(request.updatedAt === existing.updatedAt && request.events.length > existing.events.length)
				) {
					state.requests[request.id] = copyRequest(request);
				}
			}
		} catch {
			// One damaged or concurrently changing trail never blocks recovery from the others.
		}
	}
	return Object.keys(state.requests).length ? state : undefined;
}

function readOrReconstructState(userData: string, root: string): ConnectionRequestState | undefined {
	const state = readState(userData, root);
	if (state) return state;
	const recovered = reconstructedState(root);
	if (recovered) writeState(userData, recovered);
	return recovered;
}

function normalizedCreateInput(value: unknown): CreateConnectionRequestInput {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(
			value,
			new Set([
				"staffAgentId",
				"sessionFile",
				"displayName",
				"purpose",
				"destinations",
				"secretNames",
				"providerSuggestions",
				"recipeId",
				"artifactId",
				"dataNeedId",
			]),
		) ||
		!validUuid(value.staffAgentId) ||
		!validSessionFile(value.sessionFile) ||
		!validText(value.displayName, 120) ||
		!validText(value.purpose, 1_000) ||
		(value.recipeId !== undefined && (typeof value.recipeId !== "string" || !SAFE_ID_PATTERN.test(value.recipeId))) ||
		(value.artifactId !== undefined &&
			(typeof value.artifactId !== "string" || !ARTIFACT_ID_PATTERN.test(value.artifactId))) ||
		(value.dataNeedId !== undefined &&
			(typeof value.dataNeedId !== "string" || !DATA_NEED_ID_PATTERN.test(value.dataNeedId))) ||
		(value.artifactId === undefined) !== (value.dataNeedId === undefined)
	) {
		throw new Error("Connection request input is invalid");
	}
	const destinations = normalizedDestinations(value.destinations);
	const secretNames = normalizedSecretNames(value.secretNames);
	const providerSuggestions = normalizedProviderSuggestions(value.providerSuggestions);
	if (
		!destinations ||
		!secretNames ||
		(value.providerSuggestions !== undefined && !providerSuggestions) ||
		(value.recipeId !== undefined && providerSuggestions !== undefined)
	) {
		throw new Error("Connection request input is invalid");
	}
	return {
		staffAgentId: value.staffAgentId.toLowerCase(),
		sessionFile: value.sessionFile,
		displayName: value.displayName,
		purpose: value.purpose,
		destinations,
		secretNames,
		...(providerSuggestions ? { providerSuggestions } : {}),
		...(value.recipeId !== undefined ? { recipeId: value.recipeId } : {}),
		...(value.artifactId !== undefined ? { artifactId: value.artifactId } : {}),
		...(value.dataNeedId !== undefined ? { dataNeedId: value.dataNeedId } : {}),
	};
}

function normalizedIdentity(value: unknown): ConnectionRequestIdentity {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["id", "staffAgentId", "sessionFile"])) ||
		!validUuid(value.id) ||
		!validUuid(value.staffAgentId) ||
		!validSessionFile(value.sessionFile)
	) {
		throw new Error("Connection request identity is invalid");
	}
	return {
		id: value.id.toLowerCase(),
		staffAgentId: value.staffAgentId.toLowerCase(),
		sessionFile: value.sessionFile,
	};
}

function ownedRequest(state: ConnectionRequestState, identity: ConnectionRequestIdentity): ConnectionRequest {
	const request = state.requests[identity.id];
	if (!request) throw new Error("Connection request was not found");
	if (request.staffAgentId !== identity.staffAgentId || request.sessionFile !== identity.sessionFile) {
		throw new Error("Connection request ownership does not match");
	}
	return request;
}

function transitionConnectionRequest(
	userData: string,
	root: string,
	identityValue: ConnectionRequestIdentity,
	transition: (request: ConnectionRequest, now: string) => boolean,
): ConnectionRequest {
	const identity = normalizedIdentity(identityValue);
	const state = readOrReconstructState(userData, root);
	if (!state) throw new Error("Connection request was not found");
	const request = ownedRequest(state, identity);
	const now = new Date().toISOString();
	if (transition(request, now)) {
		request.updatedAt = now;
		writeState(userData, state);
	}
	return copyRequest(request);
}

function advancePhase(
	request: ConnectionRequest,
	phase: ConnectionIntentPhase,
	actor: ConnectionIntentActor,
	at: string,
): void {
	request.phase = phase;
	request.events.push({ sequence: request.events.length + 1, phase, actor, at });
	if (request.events.length > MAX_REQUEST_EVENTS) {
		request.events = request.events.slice(-MAX_REQUEST_EVENTS).map((event, index) => ({
			...event,
			sequence: index + 1,
		}));
	}
}

function normalizedSelectionInput(value: unknown): ConnectionIntentSelectionInput {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["label", "kind"])) ||
		!validText(value.label, 240) ||
		typeof value.kind !== "string" ||
		!CONNECTION_INTENT_SELECTION_KINDS.has(value.kind as ConnectionIntentSelectionKind)
	) {
		throw new Error("Connection intent selection is invalid");
	}
	return { label: value.label, kind: value.kind as ConnectionIntentSelectionKind };
}

export function createConnectionRequest(
	userData: string,
	root: string,
	inputValue: CreateConnectionRequestInput,
): ConnectionRequest {
	const input = normalizedCreateInput(inputValue);
	const canonical = canonicalRoot(root);
	const state = readOrReconstructState(userData, canonical) ?? emptyState(canonical);
	if (Object.keys(state.requests).length >= MAX_REQUESTS) throw new Error("Connection request limit reached");
	let id = randomUUID();
	while (state.requests[id]) id = randomUUID();
	const now = new Date().toISOString();
	const request: ConnectionRequest = {
		id,
		...input,
		status: "pending",
		phase: "suggested",
		events: [{ sequence: 1, phase: "suggested", actor: "agent", at: now }],
		createdAt: now,
		updatedAt: now,
	};
	state.requests[id] = request;
	writeState(userData, state);
	return copyRequest(request);
}

/** Reuses a founder's durable selection only when a new request exactly
 * matches the failed connector contract. Any unselected duplicate proposal
 * for the same retry is terminalized so it cannot reappear as another form. */
export function retryFailedConnectionRequest(
	userData: string,
	root: string,
	inputValue: CreateConnectionRequestInput,
): RetriedConnectionRequest | undefined {
	const input = normalizedCreateInput(inputValue);
	if (!input.recipeId) return undefined;
	const state = readOrReconstructState(userData, root);
	if (!state) return undefined;
	const matchesInput = (request: ConnectionRequest): boolean =>
		request.staffAgentId === input.staffAgentId &&
		request.sessionFile === input.sessionFile &&
		request.displayName === input.displayName &&
		request.purpose === input.purpose &&
		request.recipeId === input.recipeId &&
		request.artifactId === input.artifactId &&
		request.dataNeedId === input.dataNeedId &&
		JSON.stringify(request.destinations) === JSON.stringify(input.destinations) &&
		JSON.stringify(request.secretNames) === JSON.stringify(input.secretNames);
	const failed = Object.values(state.requests)
		.filter((request) => request.status === "failed" && request.selection && matchesInput(request))
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
	if (!failed) return undefined;
	const now = new Date().toISOString();
	const superseded = Object.values(state.requests).filter(
		(request) =>
			request.id !== failed.id &&
			request.status === "pending" &&
			request.phase === "suggested" &&
			request.selection === undefined &&
			matchesInput(request),
	);
	for (const request of superseded) {
		request.status = "cancelled";
		advancePhase(request, "cancelled", "host", now);
		request.updatedAt = now;
	}
	failed.status = "pending";
	delete failed.failure;
	advancePhase(failed, "preparing", "agent", now);
	failed.updatedAt = now;
	writeState(userData, state);
	return {
		request: copyRequest(failed),
		superseded: superseded.map(copyRequest),
	};
}

export function installPreparedConnectionRequestRecipe(
	userData: string,
	root: string,
	identityValue: ConnectionRequestIdentity,
	inputValue: CreateConnectionRequestInput,
): ConnectionRequest {
	const input = normalizedCreateInput(inputValue);
	if (!input.recipeId?.startsWith("company:")) {
		throw new Error("Prepared connection request recipe is invalid");
	}
	return transitionConnectionRequest(userData, root, identityValue, (request, now) => {
		if (
			request.status !== "pending" ||
			request.phase !== "preparing" ||
			request.recipeId !== undefined ||
			request.staffAgentId !== input.staffAgentId ||
			request.sessionFile !== input.sessionFile ||
			request.artifactId !== input.artifactId ||
			request.dataNeedId !== input.dataNeedId
		) {
			throw new Error("Connection request cannot install a recipe from its current phase");
		}
		request.displayName = input.displayName;
		request.purpose = input.purpose;
		request.destinations = input.destinations.map((destination) => ({ ...destination }));
		request.secretNames = [...input.secretNames];
		delete request.providerSuggestions;
		request.recipeId = input.recipeId;
		advancePhase(request, "preparing", "agent", now);
		return true;
	});
}

export function readConnectionRequests(userData: string, root: string): ConnectionRequest[] {
	return Object.values(readOrReconstructState(userData, root)?.requests ?? {})
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
		.map(copyRequest);
}

export function getConnectionRequest(userData: string, root: string, id: string): ConnectionRequest | undefined {
	if (!validUuid(id)) throw new Error("Connection request id is invalid");
	const request = readOrReconstructState(userData, root)?.requests[id.toLowerCase()];
	return request ? copyRequest(request) : undefined;
}

export function getRecoverableConnectionSetup(
	userData: string,
	root: string,
	staffAgentId: string,
	sessionFile: string,
): ConnectionRequest | undefined {
	if (!validUuid(staffAgentId) || !validSessionFile(sessionFile)) {
		throw new Error("Connection setup ownership is invalid");
	}
	const request = [...readConnectionRequests(userData, root)]
		.reverse()
		.find(
			(candidate) =>
				candidate.staffAgentId === staffAgentId.toLowerCase() &&
				candidate.sessionFile === sessionFile &&
				candidate.status === "connecting" &&
				candidate.phase === "awaiting_setup" &&
				candidate.recipeId?.startsWith("company:"),
		);
	return request ? copyRequest(request) : undefined;
}

export function projectConnectionRequest(request: ConnectionRequest): RendererConnectionRequest {
	if (!validRequest(request)) throw new Error("Connection request input is invalid");
	const guidance = (() => {
		switch (request.phase) {
			case "preparing":
				return `Preparing ${request.displayName}…`;
			case "awaiting_setup":
				return `${request.displayName} is ready at the first private sign-in step. Complete it in Qorpera Chrome, then return here.`;
			case "awaiting_auth":
				return `${request.displayName} is open in your browser. Sign in and approve access.`;
			case "verifying":
				return `Qorpera is checking that ${request.displayName} completed the connection.`;
			case "connected":
				return `${request.displayName} is connected.`;
			case "syncing":
				return `${request.displayName} is connected. The agent is checking the first data before marking it ready.`;
			case "ready":
				return `${request.displayName} is ready.`;
			default:
				return undefined;
		}
	})();
	return {
		id: request.id,
		staffAgentId: request.staffAgentId,
		sessionFile: request.sessionFile,
		displayName: request.displayName,
		purpose: request.purpose,
		destinations: request.destinations.map((destination) => ({ ...destination })),
		...(request.providerSuggestions ? { providerSuggestions: [...request.providerSuggestions] } : {}),
		...(request.recipeId !== undefined ? { recipeId: request.recipeId } : {}),
		...(request.artifactId !== undefined ? { artifactId: request.artifactId } : {}),
		...(request.dataNeedId !== undefined ? { dataNeedId: request.dataNeedId } : {}),
		status: request.status,
		phase: request.phase,
		...(guidance !== undefined ? { guidance } : {}),
		...(request.selection ? { selection: { ...request.selection } } : {}),
		createdAt: request.createdAt,
		updatedAt: request.updatedAt,
		...(request.failure !== undefined ? { failure: request.failure } : {}),
		...(request.grantId !== undefined ? { grantId: request.grantId } : {}),
	};
}

export function selectConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
	selectionValue: ConnectionIntentSelectionInput,
): ConnectionRequest {
	const selection = normalizedSelectionInput(selectionValue);
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (
			request.phase === "selected" &&
			request.selection?.label === selection.label &&
			request.selection.kind === selection.kind
		) {
			return false;
		}
		if (request.status === "failed") {
			request.status = "pending";
			delete request.failure;
		}
		if (request.status !== "pending" || request.phase === "preparing") {
			throw new Error("Connection intent cannot be selected from its current phase");
		}
		request.selection = { ...selection, selectedAt: now };
		advancePhase(request, "selected", "founder", now);
		return true;
	});
}

export function prepareConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.phase === "preparing") return false;
		if (request.status !== "pending" || request.phase !== "selected") {
			throw new Error("Connection intent cannot prepare from its current phase");
		}
		advancePhase(request, "preparing", "host", now);
		return true;
	});
}

export function readRendererConnectionRequests(userData: string, root: string): RendererConnectionRequest[] {
	return readConnectionRequests(userData, root).map(projectConnectionRequest);
}

export function beginConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "connecting" && request.phase === "awaiting_auth") return false;
		if (request.status !== "pending") throw new Error("Connection request cannot begin from its current status");
		request.status = "connecting";
		advancePhase(request, "awaiting_auth", "host", now);
		return true;
	});
}

export function beginConnectionRequestSetup(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "connecting" && request.phase === "awaiting_setup") return false;
		if (request.status !== "pending")
			throw new Error("Connection request cannot begin setup from its current status");
		request.status = "connecting";
		advancePhase(request, "awaiting_setup", "host", now);
		return true;
	});
}

export function resumeConnectionRequestAuthorization(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "connecting" && request.phase === "awaiting_auth") return false;
		if (request.status !== "connecting" || request.phase !== "awaiting_setup") {
			throw new Error("Connection request cannot resume authorization from its current phase");
		}
		advancePhase(request, "awaiting_auth", "host", now);
		return true;
	});
}

export function verifyConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.phase === "verifying") return false;
		if (request.status !== "connecting" || request.phase !== "awaiting_auth") {
			throw new Error("Connection request cannot verify from its current phase");
		}
		advancePhase(request, "verifying", "host", now);
		return true;
	});
}

export function completeConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
	grantId: string,
): ConnectionRequest {
	if (!SAFE_ID_PATTERN.test(grantId)) throw new Error("Connection request grant id is invalid");
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "connected" && request.grantId === grantId) return false;
		if (request.status !== "connecting" || request.phase !== "verifying")
			throw new Error("Connection request cannot complete from its current status");
		request.status = "connected";
		request.grantId = grantId;
		advancePhase(request, "connected", "host", now);
		return true;
	});
}

export function beginConnectionRequestSync(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.phase === "syncing") return false;
		if (request.status !== "connected" || request.phase !== "connected") {
			throw new Error("Connection request cannot sync from its current phase");
		}
		advancePhase(request, "syncing", "host", now);
		return true;
	});
}

export function completeConnectionRequestSync(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.phase === "ready") return false;
		if (request.status !== "connected" || request.phase !== "syncing") {
			throw new Error("Connection request cannot finish syncing from its current phase");
		}
		advancePhase(request, "ready", "agent", now);
		return true;
	});
}

export function failConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
	failure?: string,
): ConnectionRequest {
	if (failure !== undefined && !validFailure(failure))
		throw new Error("Connection request failure is not renderer-safe");
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "failed" && request.failure === failure) return false;
		if (request.status !== "connecting") throw new Error("Connection request cannot fail from its current status");
		request.status = "failed";
		if (failure !== undefined) request.failure = failure;
		advancePhase(request, "failed", "host", now);
		return true;
	});
}

export function denyConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "denied") return false;
		if (request.status !== "pending" && request.status !== "connecting") {
			throw new Error("Connection request cannot be denied from its current status");
		}
		request.status = "denied";
		advancePhase(request, "denied", "founder", now);
		return true;
	});
}

export function cancelConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request, now) => {
		if (request.status === "cancelled") return false;
		if (request.status !== "pending" && request.status !== "connecting") {
			throw new Error("Connection request cannot be cancelled from its current status");
		}
		request.status = "cancelled";
		advancePhase(request, "cancelled", "founder", now);
		return true;
	});
}

/** Cancel every unresolved proposal owned by an agent whose lifecycle ended.
 * Terminal requests remain immutable and are retained for reconstruction. */
export function cancelPendingConnectionRequestsForStaff(
	userData: string,
	root: string,
	staffAgentId: string,
): ConnectionRequest[] {
	if (!validUuid(staffAgentId)) throw new Error("Connection request staff identity is invalid");
	return readConnectionRequests(userData, root)
		.filter(
			(request) =>
				request.staffAgentId === staffAgentId.toLowerCase() &&
				(request.status === "pending" || request.status === "connecting"),
		)
		.map((request) =>
			cancelConnectionRequest(userData, root, {
				id: request.id,
				staffAgentId: request.staffAgentId,
				sessionFile: request.sessionFile,
			}),
		);
}
