import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type ConnectionRequestStatus = "pending" | "connecting" | "connected" | "denied" | "failed" | "cancelled";

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
	recipeId?: string;
	status: ConnectionRequestStatus;
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
	recipeId?: string;
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
	recipeId?: string;
	status: ConnectionRequestStatus;
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
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CONNECTION_REQUEST_STATUSES = new Set<ConnectionRequestStatus>([
	"pending",
	"connecting",
	"connected",
	"denied",
	"failed",
	"cancelled",
]);
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 1_000;

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

function rootId(root: string): string {
	return createHash("sha256").update(normalizedPath(root)).digest("hex");
}

export function connectionRequestsStatePath(userData: string, root: string): string {
	return join(userData, "connection-requests", rootId(canonicalRoot(root)), "state.json");
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

function validRequest(value: unknown): value is ConnectionRequest {
	if (!isRecord(value)) return false;
	const destinations = normalizedDestinations(value.destinations);
	const secretNames = normalizedSecretNames(value.secretNames);
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
				"recipeId",
				"status",
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
		(value.recipeId !== undefined && (typeof value.recipeId !== "string" || !SAFE_ID_PATTERN.test(value.recipeId))) ||
		typeof value.status !== "string" ||
		!CONNECTION_REQUEST_STATUSES.has(value.status as ConnectionRequestStatus) ||
		!validTimestamp(value.createdAt) ||
		!validTimestamp(value.updatedAt) ||
		Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
		(value.failure !== undefined && !validFailure(value.failure)) ||
		(value.grantId !== undefined && (typeof value.grantId !== "string" || !SAFE_ID_PATTERN.test(value.grantId)))
	) {
		return false;
	}
	if (value.status === "connected") return value.grantId !== undefined && value.failure === undefined;
	if (value.status === "failed") return value.grantId === undefined;
	return value.failure === undefined && value.grantId === undefined;
}

function copyRequest(request: ConnectionRequest): ConnectionRequest {
	return {
		...request,
		destinations: request.destinations.map((destination) => ({ ...destination })),
		secretNames: [...request.secretNames],
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
	for (const [id, request] of Object.entries(parsed.requests)) {
		if (id !== id.toLowerCase() || !validRequest(request) || request.id !== id) {
			throw new Error("Connection request state is invalid");
		}
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

function normalizedCreateInput(value: unknown): CreateConnectionRequestInput {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(
			value,
			new Set(["staffAgentId", "sessionFile", "displayName", "purpose", "destinations", "secretNames", "recipeId"]),
		) ||
		!validUuid(value.staffAgentId) ||
		!validSessionFile(value.sessionFile) ||
		!validText(value.displayName, 120) ||
		!validText(value.purpose, 1_000) ||
		(value.recipeId !== undefined && (typeof value.recipeId !== "string" || !SAFE_ID_PATTERN.test(value.recipeId)))
	) {
		throw new Error("Connection request input is invalid");
	}
	const destinations = normalizedDestinations(value.destinations);
	const secretNames = normalizedSecretNames(value.secretNames);
	if (!destinations || !secretNames) throw new Error("Connection request input is invalid");
	return {
		staffAgentId: value.staffAgentId.toLowerCase(),
		sessionFile: value.sessionFile,
		displayName: value.displayName,
		purpose: value.purpose,
		destinations,
		secretNames,
		...(value.recipeId !== undefined ? { recipeId: value.recipeId } : {}),
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
	transition: (request: ConnectionRequest) => boolean,
): ConnectionRequest {
	const identity = normalizedIdentity(identityValue);
	const state = readState(userData, root);
	if (!state) throw new Error("Connection request was not found");
	const request = ownedRequest(state, identity);
	if (transition(request)) {
		request.updatedAt = new Date().toISOString();
		writeState(userData, state);
	}
	return copyRequest(request);
}

export function createConnectionRequest(
	userData: string,
	root: string,
	inputValue: CreateConnectionRequestInput,
): ConnectionRequest {
	const input = normalizedCreateInput(inputValue);
	const canonical = canonicalRoot(root);
	const state = readState(userData, canonical) ?? emptyState(canonical);
	if (Object.keys(state.requests).length >= MAX_REQUESTS) throw new Error("Connection request limit reached");
	let id = randomUUID();
	while (state.requests[id]) id = randomUUID();
	const now = new Date().toISOString();
	const request: ConnectionRequest = {
		id,
		...input,
		status: "pending",
		createdAt: now,
		updatedAt: now,
	};
	state.requests[id] = request;
	writeState(userData, state);
	return copyRequest(request);
}

export function readConnectionRequests(userData: string, root: string): ConnectionRequest[] {
	return Object.values(readState(userData, root)?.requests ?? {})
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
		.map(copyRequest);
}

export function getConnectionRequest(userData: string, root: string, id: string): ConnectionRequest | undefined {
	if (!validUuid(id)) throw new Error("Connection request id is invalid");
	const request = readState(userData, root)?.requests[id.toLowerCase()];
	return request ? copyRequest(request) : undefined;
}

export function projectConnectionRequest(request: ConnectionRequest): RendererConnectionRequest {
	if (!validRequest(request)) throw new Error("Connection request projection input is invalid");
	return {
		id: request.id,
		staffAgentId: request.staffAgentId,
		sessionFile: request.sessionFile,
		displayName: request.displayName,
		purpose: request.purpose,
		destinations: request.destinations.map((destination) => ({ ...destination })),
		...(request.recipeId !== undefined ? { recipeId: request.recipeId } : {}),
		status: request.status,
		createdAt: request.createdAt,
		updatedAt: request.updatedAt,
		...(request.failure !== undefined ? { failure: request.failure } : {}),
		...(request.grantId !== undefined ? { grantId: request.grantId } : {}),
	};
}

export function readRendererConnectionRequests(userData: string, root: string): RendererConnectionRequest[] {
	return readConnectionRequests(userData, root).map(projectConnectionRequest);
}

export function beginConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request) => {
		if (request.status === "connecting") return false;
		if (request.status !== "pending") throw new Error("Connection request cannot begin from its current status");
		request.status = "connecting";
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
	return transitionConnectionRequest(userData, root, identity, (request) => {
		if (request.status === "connected" && request.grantId === grantId) return false;
		if (request.status !== "connecting")
			throw new Error("Connection request cannot complete from its current status");
		request.status = "connected";
		request.grantId = grantId;
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
	return transitionConnectionRequest(userData, root, identity, (request) => {
		if (request.status === "failed" && request.failure === failure) return false;
		if (request.status !== "connecting") throw new Error("Connection request cannot fail from its current status");
		request.status = "failed";
		if (failure !== undefined) request.failure = failure;
		return true;
	});
}

export function denyConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request) => {
		if (request.status === "denied") return false;
		if (request.status !== "pending" && request.status !== "connecting") {
			throw new Error("Connection request cannot be denied from its current status");
		}
		request.status = "denied";
		return true;
	});
}

export function cancelConnectionRequest(
	userData: string,
	root: string,
	identity: ConnectionRequestIdentity,
): ConnectionRequest {
	return transitionConnectionRequest(userData, root, identity, (request) => {
		if (request.status === "cancelled") return false;
		if (request.status !== "pending" && request.status !== "connecting") {
			throw new Error("Connection request cannot be cancelled from its current status");
		}
		request.status = "cancelled";
		return true;
	});
}
