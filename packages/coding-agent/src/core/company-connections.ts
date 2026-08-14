/**
 * Company connections state (Build 3 — generic connectivity).
 *
 * Kernel-side, machine-local, per-company: founder-bound outbound network
 * destinations and named secrets. Lives under the foundation's agent
 * directory — never inside the company folder — so exports, forks, and
 * clones carry no credentials or standing external capability (manifesto
 * §7.1, §10). Secrets are referenced from company content as opaque
 * `secret://<name>` tokens; only the kernel dereferences them, at the
 * brokered boundary (http-request-broker). Raw values used through that lane
 * never enter model context, company files, or the trail. A host-capable
 * controller runs as the same OS user and could deliberately locate this
 * machine-local file, so it is not an OS-level vault.
 *
 * The OAuth2 shape is RFC 6749's refresh-token grant — generic protocol,
 * not provider ontology. Refresh happens kernel-side at dereference time
 * and writes the rotated tokens back here; the controller-facing broker API
 * never returns the stored refresh credential (build plan §5).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";

export const SECRET_REFERENCE_PATTERN = /secret:\/\/([a-z0-9][a-z0-9_-]{0,63})/gi;
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DESTINATION_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

export interface StaticSecret {
	kind: "static";
	value: string;
}

export interface OAuth2Secret {
	kind: "oauth2";
	accessToken: string;
	refreshToken: string;
	tokenUrl: string;
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	/** ISO timestamp after which the access token needs a refresh. */
	expiresAt?: string;
}

export type CompanySecret = StaticSecret | OAuth2Secret;

export interface NetworkDestination {
	/** Lowercase host, optionally with an explicit :port. HTTPS only. */
	host: string;
	note?: string;
	boundAt: string;
}

/**
 * The founder-bound wake schedule (Build 4 — durable autonomy). The kernel
 * wakes the controller on this cadence; what the wake MEANS — which routine
 * runs, what gets done — stays entirely the controller's decision. The
 * minimum interval is a kernel-owned wake-rate ceiling: a malfunctioning
 * controller cannot bound itself.
 */
export interface WakeSchedule {
	intervalMinutes: number;
	enabled: boolean;
	/** Set by the kernel (e.g. repeated wake failures); cleared by re-binding. */
	suspendedReason?: string;
}

export const MIN_WAKE_INTERVAL_MINUTES = 5;
const MAX_WAKE_INTERVAL_MINUTES = 7 * 24 * 60;

/**
 * A founder-bound unit of recurring controller work. Definitions stay in the
 * machine-local connection store because enabling unattended work is standing
 * authority; the resulting runs and artifacts still land in the company trail.
 */
export interface ScheduledJob {
	id: string;
	title: string;
	prompt: string;
	intervalMinutes: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	/** Set by the kernel after repeated failures; cleared when the job is re-enabled. */
	suspendedReason?: string;
}

export interface ScheduledJobInput {
	title: string;
	prompt: string;
	intervalMinutes: number;
	enabled?: boolean;
}

export interface ScheduledJobUpdate {
	title?: string;
	prompt?: string;
	intervalMinutes?: number;
	enabled?: boolean;
}

export const DEFAULT_SCHEDULED_JOB_ID = "company-orchestration";
export const DEFAULT_SCHEDULED_JOB_TITLE = "Company orchestration";
export const DEFAULT_SCHEDULED_JOB_PROMPT =
	"Read company.md, the inbox, and app/routines/. Decide what most needs doing and do it. Post inbox/messages items for anything that needs the founder; when nothing needs doing, settle without inventing work.";

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

const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

function normalizedRoot(root: string): string {
	const resolved = resolve(root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function companyConnectionsPath(root: string): string {
	const id = createHash("sha256").update(normalizedRoot(root)).digest("hex");
	return join(getAgentDir(), "connections", `${id}.json`);
}

function emptyState(root: string): CompanyConnectionsState {
	return { version: 1, root: resolve(root), destinations: [], secrets: {} };
}

function readState(root: string): CompanyConnectionsState {
	const path = companyConnectionsPath(root);
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

/** Names and destinations only — never secret values. */
export function readCompanyConnections(root: string): { destinations: NetworkDestination[]; secretNames: string[] } {
	const state = readState(root);
	return { destinations: state.destinations, secretNames: Object.keys(state.secrets).sort() };
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

function validSecret(secret: CompanySecret): boolean {
	if (secret.kind === "static") return typeof secret.value === "string" && secret.value.length > 0;
	return (
		secret.kind === "oauth2" &&
		typeof secret.accessToken === "string" &&
		typeof secret.refreshToken === "string" &&
		secret.refreshToken.length > 0 &&
		typeof secret.tokenUrl === "string" &&
		trustedTokenUrl(secret.tokenUrl)
	);
}

export function bindCompanySecret(root: string, name: string, secret: CompanySecret): void {
	if (!SECRET_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid secret name: ${name} (letters, digits, - and _, max 64 chars)`);
	}
	if (!validSecret(secret)) throw new Error(`Invalid ${secret.kind} secret for ${name}`);
	const state = readState(root);
	state.secrets[name] = secret;
	writeState(root, state);
}

export function removeCompanySecret(root: string, name: string): boolean {
	const state = readState(root);
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

export function readWakeSchedule(root: string): WakeSchedule | undefined {
	const job = readScheduledJobs(root).find((candidate) => candidate.id === DEFAULT_SCHEDULED_JOB_ID);
	return job
		? {
				intervalMinutes: job.intervalMinutes,
				enabled: job.enabled,
				...(job.suspendedReason ? { suspendedReason: job.suspendedReason } : {}),
			}
		: undefined;
}

export function bindWakeSchedule(root: string, intervalMinutes: number): WakeSchedule {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	const normalizedInterval = validScheduledJobInterval(intervalMinutes);
	const now = new Date().toISOString();
	const current = jobs.find((job) => job.id === DEFAULT_SCHEDULED_JOB_ID);
	const job: ScheduledJob = current
		? { ...current, intervalMinutes: normalizedInterval, enabled: true, updatedAt: now, suspendedReason: undefined }
		: {
				id: DEFAULT_SCHEDULED_JOB_ID,
				title: DEFAULT_SCHEDULED_JOB_TITLE,
				prompt: DEFAULT_SCHEDULED_JOB_PROMPT,
				intervalMinutes: normalizedInterval,
				enabled: true,
				createdAt: now,
				updatedAt: now,
			};
	state.scheduledJobs = [...jobs.filter((candidate) => candidate.id !== job.id), job];
	delete state.wake;
	writeState(root, state);
	return { intervalMinutes: job.intervalMinutes, enabled: job.enabled };
}

export function disableWakeSchedule(root: string): boolean {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	const index = jobs.findIndex((job) => job.id === DEFAULT_SCHEDULED_JOB_ID);
	if (index < 0 || !jobs[index].enabled) return false;
	jobs[index] = { ...jobs[index], enabled: false, updatedAt: new Date().toISOString() };
	state.scheduledJobs = jobs;
	delete state.wake;
	writeState(root, state);
	return true;
}

/** Kernel-side suspension (e.g. repeated wake failures). Re-binding clears it. */
export function suspendWakeSchedule(root: string, reason: string): void {
	suspendScheduledJob(root, DEFAULT_SCHEDULED_JOB_ID, reason);
}

function validScheduledJobInterval(value: number): number {
	if (!Number.isFinite(value) || value < MIN_WAKE_INTERVAL_MINUTES || value > MAX_WAKE_INTERVAL_MINUTES) {
		throw new Error(
			`Wake interval must be between ${MIN_WAKE_INTERVAL_MINUTES} minutes and 7 days (kernel wake-rate ceiling)`,
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

function migrateScheduledJobs(state: CompanyConnectionsState): ScheduledJob[] {
	if (state.scheduledJobs) return [...state.scheduledJobs];
	if (!state.wake) return [];
	const now = new Date().toISOString();
	return [
		{
			id: DEFAULT_SCHEDULED_JOB_ID,
			title: DEFAULT_SCHEDULED_JOB_TITLE,
			prompt: DEFAULT_SCHEDULED_JOB_PROMPT,
			intervalMinutes: state.wake.intervalMinutes,
			enabled: state.wake.enabled,
			createdAt: now,
			updatedAt: now,
			...(state.wake.suspendedReason ? { suspendedReason: state.wake.suspendedReason } : {}),
		},
	];
}

export function readScheduledJobs(root: string): ScheduledJob[] {
	const state = readState(root);
	const jobs = migrateScheduledJobs(state);
	if (!state.scheduledJobs && state.wake) {
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
	const job: ScheduledJob = {
		id: randomUUID(),
		title: validScheduledJobText(input.title, "title", 160),
		prompt: validScheduledJobText(input.prompt, "prompt", 32 * 1024),
		intervalMinutes: validScheduledJobInterval(input.intervalMinutes),
		enabled: input.enabled ?? true,
		createdAt: now,
		updatedAt: now,
	};
	state.scheduledJobs = [...jobs, job];
	delete state.wake;
	writeState(root, state);
	return job;
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
		...(update.intervalMinutes !== undefined
			? { intervalMinutes: validScheduledJobInterval(update.intervalMinutes) }
			: {}),
		enabled,
		updatedAt: new Date().toISOString(),
		...(update.enabled === true ? { suspendedReason: undefined } : {}),
	};
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
 * Inbound webhooks — the first optional kernel module (manifesto §9):
 * kernel-necessary when wanted, off by default, no ontology. The kernel
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
 * Record the port the kernel actually bound. Bindings enabled before ports
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
 * Dereference a secret to its raw value — kernel-side only. OAuth2 secrets
 * past their expiry are refreshed through the token endpoint (RFC 6749
 * §6) and the rotated tokens are persisted before the value is returned.
 */
export async function resolveCompanySecret(
	root: string,
	name: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const state = readState(root);
	const secret = state.secrets[name];
	if (!secret) throw new Error(`Unknown secret reference: secret://${name}`);
	if (secret.kind === "static") return secret.value;
	const expiresAt = secret.expiresAt ? Date.parse(secret.expiresAt) : Number.POSITIVE_INFINITY;
	if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
		const parameters = new URLSearchParams({ grant_type: "refresh_token", refresh_token: secret.refreshToken });
		if (secret.clientId) parameters.set("client_id", secret.clientId);
		if (secret.clientSecret) parameters.set("client_secret", secret.clientSecret);
		if (secret.scope) parameters.set("scope", secret.scope);
		const response = await fetchImpl(secret.tokenUrl, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: parameters.toString(),
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
		const current = readState(root);
		current.secrets[name] = updated;
		writeState(root, current);
		return updated.accessToken;
	}
	return secret.accessToken;
}
