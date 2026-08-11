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

interface CompanyConnectionsState {
	version: 1;
	root: string;
	destinations: NetworkDestination[];
	secrets: Record<string, CompanySecret>;
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
	return readState(root).wake;
}

export function bindWakeSchedule(root: string, intervalMinutes: number): WakeSchedule {
	if (
		!Number.isFinite(intervalMinutes) ||
		intervalMinutes < MIN_WAKE_INTERVAL_MINUTES ||
		intervalMinutes > MAX_WAKE_INTERVAL_MINUTES
	) {
		throw new Error(
			`Wake interval must be between ${MIN_WAKE_INTERVAL_MINUTES} minutes and 7 days (kernel wake-rate ceiling)`,
		);
	}
	const state = readState(root);
	state.wake = { intervalMinutes: Math.round(intervalMinutes), enabled: true };
	writeState(root, state);
	return state.wake;
}

export function disableWakeSchedule(root: string): boolean {
	const state = readState(root);
	if (!state.wake?.enabled) return false;
	state.wake = { ...state.wake, enabled: false };
	writeState(root, state);
	return true;
}

/** Kernel-side suspension (e.g. repeated wake failures). Re-binding clears it. */
export function suspendWakeSchedule(root: string, reason: string): void {
	const state = readState(root);
	if (!state.wake) return;
	state.wake = { ...state.wake, suspendedReason: reason };
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
