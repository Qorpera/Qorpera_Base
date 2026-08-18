/**
 * Company connections state (Build 3 — generic connectivity).
 *
 * Kernel-side, machine-local, per-company: founder-bound outbound network
 * destinations and named secrets. Lives under the foundation's agent
 * directory — never inside the company folder — so exports, forks, and
 * clones carry no credentials or standing external capability (manifesto
 * §7.1, §10). Secrets are referenced from company content as opaque
 * `secret://<name>` tokens; only the kernel dereferences them, at the
 * trusted boundary (http-request-broker). Raw values never enter model
 * context, the sandbox, company files, or the trail.
 *
 * The OAuth2 shape is RFC 6749's refresh-token grant — generic protocol,
 * not provider ontology. Refresh happens kernel-side at dereference time
 * and writes the rotated tokens back here; sandboxed code never touches
 * the vault (build plan §5).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";

export const SECRET_REFERENCE_PATTERN = /secret:\/\/([a-z0-9][a-z0-9_-]{0,63})/gi;
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DESTINATION_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const FORBIDDEN_CLIENT_AUTH_HEADERS = new Set(["authorization", "content-type", "cookie", "host"]);
const FORBIDDEN_TEMPLATE_HEADERS = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"host",
	"proxy-authorization",
	"transfer-encoding",
]);
const OAUTH_HEADER_TEMPLATE_NAMES = new Set(["body_sha256_digest", "http_date", "url_host"]);
const OAUTH_HTTP_DATE_PLACEHOLDER = "$" + "{http_date}";
const OAUTH_URL_HOST_PLACEHOLDER = "$" + "{url_host}";
const OAUTH_BODY_DIGEST_PLACEHOLDER = "$" + "{body_sha256_digest}";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface StaticSecret {
	kind: "static";
	value: string;
}

export type OAuth2ClientAuthentication =
	| { kind: "body" }
	| {
			kind: "headers";
			clientIdHeader: string;
			clientSecretHeader: string;
	  };

export type OAuthRequestHeaderTemplates = Readonly<Record<string, string>>;

export interface OAuth2Secret {
	kind: "oauth2";
	accessToken: string;
	refreshToken: string;
	tokenUrl: string;
	clientId?: string;
	clientSecret?: string;
	clientAuthentication?: OAuth2ClientAuthentication;
	/** Public header templates required by the token and refresh endpoint.
	 * Values may use ${http_date}, ${url_host}, and
	 * ${body_sha256_digest}; credentials remain separate vault fields. */
	tokenHeaders?: OAuthRequestHeaderTemplates;
	scope?: string;
	/** ISO timestamp after which the access token needs a refresh. */
	expiresAt?: string;
}

export type CompanySecret = StaticSecret | OAuth2Secret;

/** Optional trusted secret storage installed by the desktop host. The coding
 * agent never receives this object; only host-side connection operations do. */
export interface CompanySecretStore {
	list(root: string): string[];
	get(root: string, name: string): CompanySecret | undefined;
	put(root: string, name: string, secret: CompanySecret): void;
	remove(root: string, name: string): boolean;
}

let companySecretStore: CompanySecretStore | undefined;

export function setCompanySecretStore(store: CompanySecretStore | undefined): void {
	companySecretStore = store;
}

export interface NetworkDestination {
	/** Lowercase host, optionally with an explicit :port. HTTPS only. */
	host: string;
	note?: string;
	boundAt: string;
}

/** Legacy company-wide schedule, accepted only to migrate old local state into
 * a named routine. New schedules are created and owned by individual agents. */
export interface WakeSchedule {
	intervalMinutes: number;
	enabled: boolean;
	/** Set by the kernel (e.g. repeated wake failures); cleared by re-binding. */
	suspendedReason?: string;
}

export const MIN_WAKE_INTERVAL_MINUTES = 5;
const MAX_WAKE_INTERVAL_MINUTES = 7 * 24 * 60;

export const ROUTINE_WEEKDAYS = Object.freeze([
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
] as const);
export type RoutineWeekday = (typeof ROUTINE_WEEKDAYS)[number];

export const GITHUB_ROUTINE_EVENT_TYPES = [
	"pull_request.opened",
	"pull_request.updated",
	"pull_request.merged",
	"pull_request.review_requested",
	"review.approved",
	"review.changes_requested",
	"pull_request.comment",
	"pull_request.review_comment",
	"check_run.succeeded",
	"check_run.failed",
	"issue.assigned",
] as const;

export type GitHubRoutineEventType = (typeof GITHUB_ROUTINE_EVENT_TYPES)[number];

export type RoutineTrigger =
	| {
			id: string;
			kind: "schedule";
			intervalMinutes: number;
			/** Optional absolute anchor for the first and subsequent interval slots. */
			startAt?: string;
			/** Calendar fields are present together for wall-clock weekly schedules. */
			weekdays?: RoutineWeekday[];
			localTime?: string;
			/** `auto` follows the current computer; otherwise an IANA timezone. */
			timeZone?: string;
	  }
	| {
			id: string;
			kind: "github";
			repository: string;
			events: GitHubRoutineEventType[];
			/** Empty means any GitHub actor. */
			actors: string[];
	  }
	| {
			id: string;
			kind: "custom";
			/** Agent-built adapters emit this stable source and event pair. */
			adapterId: string;
			event: string;
			label: string;
			/** Optional agent-built polling monitor. Custom triggers without this
			 * field remain webhook/event-bus adapters. */
			monitor?: {
				instructions: string;
				intervalMinutes: number;
				connectorIds: string[];
			};
	  };

export type RoutineTriggerInput = RoutineTrigger extends infer Trigger
	? Trigger extends { id: string }
		? Omit<Trigger, "id"> & { id?: string }
		: never
	: never;

export const SCHEDULED_JOB_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
export type ScheduledJobEffort = (typeof SCHEDULED_JOB_EFFORTS)[number];

/**
 * Where a routine is allowed to execute. "local" runs on this machine,
 * "cloud" declares hosted-runner execution and is fail-closed (the local
 * kernel never runs it, and it stays parked until a hosted lane exists),
 * and "requires-local" asserts host-only needs (filesystem, connectors,
 * computer use) so the job must never be enqueued to a runner.
 */
export const ROUTINE_PLACEMENTS = Object.freeze(["local", "cloud", "requires-local"] as const);
export type RoutinePlacement = (typeof ROUTINE_PLACEMENTS)[number];

/**
 * A founder-bound unit of recurring agent work. Definitions stay in the
 * machine-local connection store because enabling unattended work is standing
 * authority; the resulting runs and artifacts still land in the company trail.
 */
export interface ScheduledJob {
	id: string;
	/** Stable idempotency key for a routine managed by its owning agent. This is
	 * machine-local implementation state and is not projected into the UI. */
	agentKey?: string;
	title: string;
	prompt: string;
	triggers: RoutineTrigger[];
	enabled: boolean;
	/** Reasoning effort for each autonomous run. Scheduled work defaults high. */
	effort: ScheduledJobEffort;
	/** Explicit execution placement. Missing legacy values migrate to local. */
	placement: RoutinePlacement;
	/** Explicit staff ownership. Absence means Unassigned. */
	staffAgentId?: string;
	createdAt: string;
	updatedAt: string;
	/** Set by the host after repeated failures; cleared when the job is re-enabled. */
	suspendedReason?: string;
}

export interface ScheduledJobInput {
	title: string;
	prompt: string;
	triggers: RoutineTriggerInput[];
	enabled?: boolean;
	effort?: ScheduledJobEffort;
	placement?: RoutinePlacement;
	staffAgentId?: string;
	agentKey?: string;
}

export interface ScheduledJobUpdate {
	title?: string;
	prompt?: string;
	triggers?: RoutineTriggerInput[];
	enabled?: boolean;
	effort?: ScheduledJobEffort;
	placement?: RoutinePlacement;
	/** A string assigns the job; null explicitly returns it to Unassigned. */
	staffAgentId?: string | null;
}

export const DEFAULT_SCHEDULED_JOB_ID = "company-orchestration";
export const DEFAULT_SCHEDULED_JOB_TITLE = "Company orchestration";
export const DEFAULT_SCHEDULED_JOB_PROMPT =
	"Review your charter, owned artifacts, granted connectors, recent trail, and relevant inbox items. Advance the responsibility and measures you own. Ask the founder only for a specific missing decision or authorization; when nothing needs doing, settle without inventing work.";

interface CompanyConnectionsState {
	version: 1;
	root: string;
	destinations: NetworkDestination[];
	secrets: Record<string, CompanySecret>;
	scheduledJobs?: ScheduledJob[];
	/** Pre-named-job schedule, migrated on first scheduled-job read. */
	wake?: WakeSchedule;
	webhook?: WebhookBinding;
}

interface LegacyScheduledJob extends Omit<ScheduledJob, "triggers" | "effort" | "placement"> {
	intervalMinutes: number;
	triggers?: RoutineTrigger[];
	effort?: ScheduledJobEffort;
	placement?: RoutinePlacement;
}

const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const STAFF_AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AGENT_ROUTINE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function normalizedRoot(root: string): string {
	const resolved = resolve(root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function companyConnectionStorageIdentity(root: string): string {
	try {
		const manifest = JSON.parse(readFileSync(join(resolve(root), ".qorpera", "company.json"), "utf-8")) as {
			id?: unknown;
		};
		if (
			typeof manifest.id === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.id)
		) {
			return `company:${manifest.id.toLowerCase()}`;
		}
	} catch {
		// Non-company unit tests and legacy CLI roots retain path isolation.
	}
	return `root:${normalizedRoot(root)}`;
}

export function companyConnectionsPath(root: string): string {
	const id = createHash("sha256").update(companyConnectionStorageIdentity(root)).digest("hex");
	return join(getAgentDir(), "connections", `${id}.json`);
}

function legacyCompanyConnectionsPath(root: string): string {
	const id = createHash("sha256").update(normalizedRoot(root)).digest("hex");
	return join(getAgentDir(), "connections", `${id}.json`);
}

function emptyState(root: string): CompanyConnectionsState {
	return { version: 1, root: resolve(root), destinations: [], secrets: {} };
}

function readState(root: string): CompanyConnectionsState {
	const path = companyConnectionsPath(root);
	const legacyPath = legacyCompanyConnectionsPath(root);
	if (!existsSync(path) && path !== legacyPath && existsSync(legacyPath)) {
		mkdirSync(join(path, ".."), { recursive: true });
		renameSync(legacyPath, path);
	}
	if (!existsSync(path)) return emptyState(root);
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as CompanyConnectionsState;
	if (parsed.version !== 1 || !Array.isArray(parsed.destinations) || typeof parsed.secrets !== "object") {
		throw new Error(`Company connections state is invalid: ${path}`);
	}
	return parsed;
}

function writeState(root: string, state: CompanyConnectionsState): void {
	const path = companyConnectionsPath(root);
	mkdirSync(join(path, ".."), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, FILE_WRITE_OPTIONS);
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function migrateSecretsToTrustedStore(root: string, state: CompanyConnectionsState): void {
	if (!companySecretStore || Object.keys(state.secrets).length === 0) return;
	for (const [name, secret] of Object.entries(state.secrets)) companySecretStore.put(root, name, secret);
	state.secrets = {};
	state.root = resolve(root);
	writeState(root, state);
}

/** Names and destinations only — never secret values. */
export function readCompanyConnections(root: string): { destinations: NetworkDestination[]; secretNames: string[] } {
	const state = readState(root);
	migrateSecretsToTrustedStore(root, state);
	return {
		destinations: state.destinations,
		secretNames: companySecretStore ? companySecretStore.list(root) : Object.keys(state.secrets).sort(),
	};
}

export function bindNetworkDestination(root: string, host: string, note?: string): void {
	const normalized = host.trim().toLowerCase();
	if (!DESTINATION_PATTERN.test(normalized)) {
		throw new Error(`Invalid destination host: ${host} (host or host:port, HTTPS only)`);
	}
	const state = readState(root);
	state.destinations = [
		...state.destinations.filter((destination) => destination.host !== normalized),
		{ host: normalized, ...(note ? { note } : {}), boundAt: new Date().toISOString() },
	];
	writeState(root, state);
}

export function removeNetworkDestination(root: string, host: string): boolean {
	const normalized = host.trim().toLowerCase();
	const state = readState(root);
	const remaining = state.destinations.filter((destination) => destination.host !== normalized);
	if (remaining.length === state.destinations.length) return false;
	state.destinations = remaining;
	writeState(root, state);
	return true;
}

/** HTTPS everywhere; plain HTTP only to the local loopback (dev providers, tests). */
function trustedTokenUrl(tokenUrl: string): boolean {
	if (tokenUrl.startsWith("https://")) return true;
	try {
		const parsed = new URL(tokenUrl);
		return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
	} catch {
		return false;
	}
}

function validOAuthRequestHeaders(value: OAuthRequestHeaderTemplates | undefined): boolean {
	if (value === undefined) return true;
	const entries = Object.entries(value);
	return (
		entries.length <= 16 &&
		entries.every(([name, template]) => {
			if (
				!HTTP_HEADER_NAME_PATTERN.test(name) ||
				FORBIDDEN_TEMPLATE_HEADERS.has(name.toLowerCase()) ||
				typeof template !== "string" ||
				!template ||
				template !== template.trim() ||
				CONTROL_CHARACTER_PATTERN.test(template) ||
				Buffer.byteLength(template, "utf-8") > 1_024 ||
				template.toLowerCase().includes("secret://")
			) {
				return false;
			}
			if (template.replace(/\$\{[^}]+\}/g, "").includes("${")) return false;
			return [...template.matchAll(/\$\{([^}]+)\}/g)].every((match) => OAUTH_HEADER_TEMPLATE_NAMES.has(match[1]));
		})
	);
}

export function materializeOAuthRequestHeaders(
	templates: OAuthRequestHeaderTemplates | undefined,
	url: string | URL,
	body: string,
	now: Date = new Date(),
): Record<string, string> {
	if (!validOAuthRequestHeaders(templates)) throw new Error("OAuth request header templates are invalid");
	const endpoint = new URL(url);
	const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
	return Object.fromEntries(
		Object.entries(templates ?? {}).map(([name, template]) => [
			name,
			template
				.replaceAll(OAUTH_HTTP_DATE_PLACEHOLDER, now.toUTCString())
				.replaceAll(OAUTH_URL_HOST_PLACEHOLDER, endpoint.host)
				.replaceAll(OAUTH_BODY_DIGEST_PLACEHOLDER, digest),
		]),
	);
}

export function validCompanySecret(secret: CompanySecret): boolean {
	if (secret.kind === "static") return typeof secret.value === "string" && secret.value.length > 0;
	const clientAuthentication = secret.clientAuthentication;
	const validClientAuthentication =
		clientAuthentication === undefined ||
		clientAuthentication.kind === "body" ||
		(clientAuthentication.kind === "headers" &&
			typeof secret.clientId === "string" &&
			secret.clientId.length > 0 &&
			typeof secret.clientSecret === "string" &&
			secret.clientSecret.length > 0 &&
			HTTP_HEADER_NAME_PATTERN.test(clientAuthentication.clientIdHeader) &&
			HTTP_HEADER_NAME_PATTERN.test(clientAuthentication.clientSecretHeader) &&
			!FORBIDDEN_CLIENT_AUTH_HEADERS.has(clientAuthentication.clientIdHeader.toLowerCase()) &&
			!FORBIDDEN_CLIENT_AUTH_HEADERS.has(clientAuthentication.clientSecretHeader.toLowerCase()) &&
			clientAuthentication.clientIdHeader.toLowerCase() !== clientAuthentication.clientSecretHeader.toLowerCase());
	const clientHeaderNames =
		clientAuthentication?.kind === "headers"
			? new Set([
					clientAuthentication.clientIdHeader.toLowerCase(),
					clientAuthentication.clientSecretHeader.toLowerCase(),
				])
			: new Set<string>();
	return (
		secret.kind === "oauth2" &&
		typeof secret.accessToken === "string" &&
		typeof secret.refreshToken === "string" &&
		secret.refreshToken.length > 0 &&
		typeof secret.tokenUrl === "string" &&
		trustedTokenUrl(secret.tokenUrl) &&
		validClientAuthentication &&
		validOAuthRequestHeaders(secret.tokenHeaders) &&
		Object.keys(secret.tokenHeaders ?? {}).every((name) => !clientHeaderNames.has(name.toLowerCase()))
	);
}

export function bindCompanySecret(root: string, name: string, secret: CompanySecret): void {
	if (!SECRET_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid secret name: ${name} (letters, digits, - and _, max 64 chars)`);
	}
	if (!validCompanySecret(secret)) throw new Error(`Invalid ${secret.kind} secret for ${name}`);
	const state = readState(root);
	migrateSecretsToTrustedStore(root, state);
	if (companySecretStore) companySecretStore.put(root, name, secret);
	else {
		state.secrets[name] = secret;
		writeState(root, state);
	}
}

export function removeCompanySecret(root: string, name: string): boolean {
	const state = readState(root);
	migrateSecretsToTrustedStore(root, state);
	if (companySecretStore) return companySecretStore.remove(root, name);
	if (!(name in state.secrets)) return false;
	delete state.secrets[name];
	writeState(root, state);
	return true;
}

/** Is this HTTPS URL's destination founder-bound for the company? */
export function destinationAllowed(root: string, url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = url.port ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase();
	return readState(root).destinations.some((destination) => destination.host === host);
}

function validScheduledJobInterval(value: number): number {
	if (!Number.isFinite(value) || value < MIN_WAKE_INTERVAL_MINUTES || value > MAX_WAKE_INTERVAL_MINUTES) {
		throw new Error(
			`Routine interval must be between ${MIN_WAKE_INTERVAL_MINUTES} minutes and 7 days (host execution-rate ceiling)`,
		);
	}
	return Math.round(value);
}

function validScheduledJobText(value: string, field: "title" | "prompt", maxBytes: number): string {
	const normalized = value.trim();
	if (!normalized || Buffer.byteLength(normalized, "utf-8") > maxBytes) {
		throw new Error(`Scheduled job ${field} must be between 1 and ${maxBytes} UTF-8 bytes`);
	}
	return normalized;
}

function validScheduledJobStaffAgentId(value: unknown): string {
	if (typeof value !== "string" || !STAFF_AGENT_ID_PATTERN.test(value)) {
		throw new Error("Scheduled job staffAgentId must be a lowercase UUID v4");
	}
	return value;
}

function validAgentRoutineKey(value: unknown): string {
	if (typeof value !== "string" || !AGENT_ROUTINE_KEY_PATTERN.test(value)) {
		throw new Error("Agent routine key must use lowercase letters, digits, dots, underscores, or hyphens");
	}
	return value;
}

function validScheduledJobEffort(value: unknown): ScheduledJobEffort {
	if (typeof value !== "string" || !SCHEDULED_JOB_EFFORTS.includes(value as ScheduledJobEffort)) {
		throw new Error(`Scheduled job effort must be one of ${SCHEDULED_JOB_EFFORTS.join(", ")}`);
	}
	return value as ScheduledJobEffort;
}

function validRoutinePlacement(value: unknown): RoutinePlacement {
	if (typeof value !== "string" || !ROUTINE_PLACEMENTS.includes(value as RoutinePlacement)) {
		throw new Error(`Scheduled job placement must be one of ${ROUTINE_PLACEMENTS.join(", ")}`);
	}
	return value as RoutinePlacement;
}

const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9._-]{1,100}$/i;
const ROUTINE_ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function validRoutineTrigger(input: RoutineTriggerInput): RoutineTrigger {
	const id = input.id?.trim() ? input.id.trim() : randomUUID();
	if (Buffer.byteLength(id, "utf-8") > 160) throw new Error("Routine trigger id is too long");
	if (input.kind === "schedule") {
		const calendarFieldCount = [input.weekdays, input.localTime, input.timeZone].filter(
			(value) => value !== undefined,
		).length;
		if (calendarFieldCount !== 0 && calendarFieldCount !== 3) {
			throw new Error("Weekly routine schedules require weekdays, localTime, and timeZone together");
		}
		if (calendarFieldCount && input.startAt !== undefined) {
			throw new Error("A routine schedule cannot combine startAt with a weekly wall-clock schedule");
		}
		let startAt: string | undefined;
		if (input.startAt !== undefined) {
			const parsed = Date.parse(input.startAt);
			if (!Number.isFinite(parsed)) throw new Error("Routine schedule startAt must be an ISO 8601 timestamp");
			startAt = new Date(parsed).toISOString();
		}
		let weekly: { weekdays: RoutineWeekday[]; localTime: string; timeZone: string } | undefined;
		if (calendarFieldCount) {
			const weekdays = [...new Set(input.weekdays)];
			if (
				weekdays.length < 1 ||
				weekdays.length > 7 ||
				weekdays.some((weekday) => !ROUTINE_WEEKDAYS.includes(weekday)) ||
				typeof input.localTime !== "string" ||
				!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime) ||
				typeof input.timeZone !== "string"
			) {
				throw new Error("Weekly routine schedule is invalid");
			}
			if (input.timeZone !== "auto") {
				try {
					new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(0);
				} catch {
					throw new Error("Weekly routine timeZone must be auto or an IANA timezone");
				}
			}
			weekly = {
				weekdays: ROUTINE_WEEKDAYS.filter((weekday) => weekdays.includes(weekday)),
				localTime: input.localTime,
				timeZone: input.timeZone,
			};
		}
		return {
			id,
			kind: "schedule",
			intervalMinutes: validScheduledJobInterval(input.intervalMinutes),
			...(startAt ? { startAt } : {}),
			...weekly,
		};
	}
	if (input.kind === "github") {
		const repository = input.repository.trim();
		if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
			throw new Error("GitHub routine repository must use owner/repo");
		}
		const allowed = new Set<string>(GITHUB_ROUTINE_EVENT_TYPES);
		const events = [...new Set(input.events)];
		if (!events.length || events.some((event) => !allowed.has(event))) {
			throw new Error("GitHub routine trigger needs at least one supported event");
		}
		const actors = [...new Set(input.actors.map((actor) => actor.trim()).filter(Boolean))];
		if (actors.some((actor) => !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(actor))) {
			throw new Error("GitHub routine actors must be GitHub usernames");
		}
		return { id, kind: "github", repository, events, actors };
	}
	const adapterId = input.adapterId.trim();
	const event = input.event.trim();
	const label = input.label.trim();
	if (!ROUTINE_ADAPTER_ID_PATTERN.test(adapterId) || !event || !label) {
		throw new Error("Custom routine trigger is invalid");
	}
	if (Buffer.byteLength(event, "utf-8") > 160 || Buffer.byteLength(label, "utf-8") > 160) {
		throw new Error("Custom routine trigger is too long");
	}
	let monitor: Extract<RoutineTrigger, { kind: "custom" }>["monitor"];
	if (input.monitor !== undefined) {
		const instructions = input.monitor.instructions.trim();
		const connectorIds = [...new Set(input.monitor.connectorIds.map((connectorId) => connectorId.trim()))];
		if (
			!instructions ||
			Buffer.byteLength(instructions, "utf-8") > 32 * 1024 ||
			connectorIds.length > 16 ||
			connectorIds.some((connectorId) => !ROUTINE_ADAPTER_ID_PATTERN.test(connectorId))
		) {
			throw new Error("Custom routine monitor is invalid");
		}
		monitor = {
			instructions,
			intervalMinutes: validScheduledJobInterval(input.monitor.intervalMinutes),
			connectorIds,
		};
	}
	return { id, kind: "custom", adapterId, event, label, ...(monitor ? { monitor } : {}) };
}

function validRoutineTriggers(value: readonly RoutineTriggerInput[]): RoutineTrigger[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
		throw new Error("A routine needs between 1 and 12 triggers");
	}
	const triggers = value.map(validRoutineTrigger);
	if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) {
		throw new Error("Routine trigger ids must be unique");
	}
	return triggers;
}

export function scheduledJobIntervalMinutes(job: ScheduledJob): number | undefined {
	return job.triggers.find((trigger) => trigger.kind === "schedule")?.intervalMinutes;
}

export function scheduledJobStartAt(job: ScheduledJob): string | undefined {
	return job.triggers.find((trigger) => trigger.kind === "schedule")?.startAt;
}

function migrateScheduledJobs(state: CompanyConnectionsState): ScheduledJob[] {
	if (state.scheduledJobs) {
		return (state.scheduledJobs as LegacyScheduledJob[]).map((job) => {
			const triggers = Array.isArray(job.triggers)
				? validRoutineTriggers(job.triggers)
				: [validRoutineTrigger({ kind: "schedule", intervalMinutes: job.intervalMinutes })];
			const migrated: ScheduledJob = {
				id: job.id,
				...(job.agentKey === undefined ? {} : { agentKey: validAgentRoutineKey(job.agentKey) }),
				title: job.title,
				prompt: job.prompt,
				triggers,
				enabled: job.enabled,
				effort: job.effort === undefined ? "high" : validScheduledJobEffort(job.effort),
				placement: job.placement === undefined ? "local" : validRoutinePlacement(job.placement),
				createdAt: job.createdAt,
				updatedAt: job.updatedAt,
				...(job.staffAgentId === undefined
					? {}
					: { staffAgentId: validScheduledJobStaffAgentId(job.staffAgentId) }),
				...(job.suspendedReason ? { suspendedReason: job.suspendedReason } : {}),
			};
			return migrated;
		});
	}
	if (!state.wake) return [];
	const now = new Date().toISOString();
	return [
		{
			id: DEFAULT_SCHEDULED_JOB_ID,
			title: DEFAULT_SCHEDULED_JOB_TITLE,
			prompt: DEFAULT_SCHEDULED_JOB_PROMPT,
			triggers: [validRoutineTrigger({ kind: "schedule", intervalMinutes: state.wake.intervalMinutes })],
			enabled: state.wake.enabled,
			effort: "high",
			placement: "local",
			createdAt: now,
			updatedAt: now,
			...(state.wake.suspendedReason ? { suspendedReason: state.wake.suspendedReason } : {}),
		},
	];
}

export function readScheduledJobs(root: string): ScheduledJob[] {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	if (
		(!state.scheduledJobs && state.wake) ||
		state.scheduledJobs?.some(
			(job) =>
				!Array.isArray((job as ScheduledJob).triggers) ||
				(job as Partial<ScheduledJob>).effort === undefined ||
				(job as Partial<ScheduledJob>).placement === undefined,
		)
	) {
		state.scheduledJobs = jobs;
		delete state.wake;
		writeState(root, state);
	}
	return jobs;
}

export function createScheduledJob(root: string, input: ScheduledJobInput): ScheduledJob {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	const now = new Date().toISOString();
	const staffAgentId =
		input.staffAgentId === undefined ? undefined : validScheduledJobStaffAgentId(input.staffAgentId);
	const agentKey = input.agentKey === undefined ? undefined : validAgentRoutineKey(input.agentKey);
	if (agentKey && !staffAgentId) throw new Error("Agent routine key requires staff ownership");
	if (agentKey && jobs.some((job) => job.staffAgentId === staffAgentId && job.agentKey === agentKey)) {
		throw new Error(`Agent routine already exists: ${agentKey}`);
	}
	const job: ScheduledJob = {
		id: randomUUID(),
		...(agentKey ? { agentKey } : {}),
		title: validScheduledJobText(input.title, "title", 160),
		prompt: validScheduledJobText(input.prompt, "prompt", 32 * 1024),
		triggers: validRoutineTriggers(input.triggers),
		enabled: input.enabled ?? true,
		effort: input.effort === undefined ? "high" : validScheduledJobEffort(input.effort),
		placement: input.placement === undefined ? "local" : validRoutinePlacement(input.placement),
		...(staffAgentId ? { staffAgentId } : {}),
		createdAt: now,
		updatedAt: now,
	};
	state.scheduledJobs = [...jobs, job];
	delete state.wake;
	writeState(root, state);
	return job;
}

export function findStaffScheduledJob(root: string, staffAgentId: string, agentKey: string): ScheduledJob | undefined {
	const owner = validScheduledJobStaffAgentId(staffAgentId);
	const key = validAgentRoutineKey(agentKey);
	return readScheduledJobs(root).find((job) => job.staffAgentId === owner && job.agentKey === key);
}

export function upsertStaffScheduledJob(
	root: string,
	staffAgentId: string,
	agentKey: string,
	input: Omit<ScheduledJobInput, "staffAgentId" | "agentKey">,
): ScheduledJob {
	const current = findStaffScheduledJob(root, staffAgentId, agentKey);
	if (!current) return createScheduledJob(root, { ...input, staffAgentId, agentKey });
	return updateScheduledJob(root, current.id, {
		title: input.title,
		prompt: input.prompt,
		triggers: input.triggers,
		enabled: input.enabled ?? true,
		effort: input.effort ?? "high",
		placement: input.placement ?? "local",
		staffAgentId,
	});
}

export function updateScheduledJob(root: string, id: string, update: ScheduledJobUpdate): ScheduledJob {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	const index = jobs.findIndex((job) => job.id === id);
	if (index < 0) throw new Error(`Unknown scheduled job: ${id}`);
	const current = jobs[index];
	const enabled = update.enabled ?? current.enabled;
	const next: ScheduledJob = {
		...current,
		...(update.title !== undefined ? { title: validScheduledJobText(update.title, "title", 160) } : {}),
		...(update.prompt !== undefined ? { prompt: validScheduledJobText(update.prompt, "prompt", 32 * 1024) } : {}),
		...(update.triggers !== undefined ? { triggers: validRoutineTriggers(update.triggers) } : {}),
		...(update.effort !== undefined ? { effort: validScheduledJobEffort(update.effort) } : {}),
		...(update.placement !== undefined ? { placement: validRoutinePlacement(update.placement) } : {}),
		...(update.staffAgentId === null
			? { staffAgentId: undefined }
			: update.staffAgentId !== undefined
				? { staffAgentId: validScheduledJobStaffAgentId(update.staffAgentId) }
				: {}),
		enabled,
		updatedAt: new Date().toISOString(),
		...(update.enabled === true ? { suspendedReason: undefined } : {}),
	};
	if (next.staffAgentId === undefined) delete next.staffAgentId;
	jobs[index] = next;
	state.scheduledJobs = jobs;
	delete state.wake;
	writeState(root, state);
	return next;
}

export function deleteScheduledJob(root: string, id: string): boolean {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	const remaining = jobs.filter((job) => job.id !== id);
	if (remaining.length === jobs.length) return false;
	state.scheduledJobs = remaining;
	delete state.wake;
	writeState(root, state);
	return true;
}

export function suspendScheduledJob(root: string, id: string, reason: string): void {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	const index = jobs.findIndex((job) => job.id === id);
	if (index < 0) return;
	jobs[index] = { ...jobs[index], suspendedReason: reason, updatedAt: new Date().toISOString() };
	state.scheduledJobs = jobs;
	delete state.wake;
	writeState(root, state);
}

/**
 * Inbound webhooks are an optional host capability, off by default. The host
 * listens on the local loopback only; public reachability is the
 * founder's business (a tunnel or reverse proxy of their choosing).
 */
export interface WebhookBinding {
	enabled: boolean;
	/** Random path token: the only authentication the local listener has. */
	token: string;
	port?: number;
}

export function readWebhookBinding(root: string): WebhookBinding | undefined {
	return readState(root).webhook;
}

export function enableWebhook(root: string, port?: number): WebhookBinding {
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
		throw new Error(`Invalid webhook port: ${port}`);
	}
	const state = readState(root);
	state.webhook = {
		enabled: true,
		token: state.webhook?.token ?? randomUUID(),
		...(port !== undefined ? { port } : state.webhook?.port !== undefined ? { port: state.webhook.port } : {}),
	};
	writeState(root, state);
	return state.webhook;
}

export function disableWebhook(root: string): boolean {
	const state = readState(root);
	if (!state.webhook?.enabled) return false;
	state.webhook = { ...state.webhook, enabled: false };
	writeState(root, state);
	return true;
}

/**
 * Record the port the host actually bound. Bindings enabled before ports
 * were persisted carry none; the first listener start writes its OS-assigned
 * port back so the founder gets a stable tunnel/provider endpoint.
 */
export function persistWebhookPort(root: string, port: number): WebhookBinding | undefined {
	const state = readState(root);
	if (!state.webhook?.enabled) return state.webhook;
	state.webhook = { ...state.webhook, port };
	writeState(root, state);
	return state.webhook;
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * Dereference a secret to its raw value — host-side only. OAuth2 secrets
 * past their expiry are refreshed through the token endpoint (RFC 6749
 * §6) and the rotated tokens are persisted before the value is returned.
 */
export async function resolveCompanySecret(
	root: string,
	name: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const state = readState(root);
	migrateSecretsToTrustedStore(root, state);
	const secret = companySecretStore ? companySecretStore.get(root, name) : state.secrets[name];
	if (!secret) throw new Error(`Unknown secret reference: secret://${name}`);
	if (secret.kind === "static") return secret.value;
	const expiresAt = secret.expiresAt ? Date.parse(secret.expiresAt) : Number.POSITIVE_INFINITY;
	if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
		const parameters = new URLSearchParams({ grant_type: "refresh_token", refresh_token: secret.refreshToken });
		if (secret.clientAuthentication?.kind !== "headers") {
			if (secret.clientId) parameters.set("client_id", secret.clientId);
			if (secret.clientSecret) parameters.set("client_secret", secret.clientSecret);
		}
		if (secret.scope) parameters.set("scope", secret.scope);
		const body = parameters.toString();
		const headers: Record<string, string> = {
			"content-type": "application/x-www-form-urlencoded",
			...materializeOAuthRequestHeaders(secret.tokenHeaders, secret.tokenUrl, body),
		};
		if (secret.clientAuthentication?.kind === "headers") {
			headers[secret.clientAuthentication.clientIdHeader] = secret.clientId ?? "";
			headers[secret.clientAuthentication.clientSecretHeader] = secret.clientSecret ?? "";
		}
		const response = await fetchImpl(secret.tokenUrl, {
			method: "POST",
			headers,
			body,
		});
		if (!response.ok) {
			throw new Error(`Secret refresh failed for secret://${name}: token endpoint returned ${response.status}`);
		}
		const granted = (await response.json()) as {
			access_token?: unknown;
			refresh_token?: unknown;
			expires_in?: unknown;
		};
		if (typeof granted.access_token !== "string" || !granted.access_token) {
			throw new Error(`Secret refresh failed for secret://${name}: no access token in the grant`);
		}
		const updated: OAuth2Secret = {
			...secret,
			accessToken: granted.access_token,
			...(typeof granted.refresh_token === "string" && granted.refresh_token
				? { refreshToken: granted.refresh_token }
				: {}),
			...(typeof granted.expires_in === "number" && Number.isFinite(granted.expires_in)
				? { expiresAt: new Date(Date.now() + granted.expires_in * 1000).toISOString() }
				: {}),
		};
		if (companySecretStore) companySecretStore.put(root, name, updated);
		else {
			const current = readState(root);
			current.secrets[name] = updated;
			writeState(root, current);
		}
		return updated.accessToken;
	}
	return secret.accessToken;
}
