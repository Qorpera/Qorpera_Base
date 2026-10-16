import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

/**
 * Member surface for Runtime Step 7 connectors (Gmail, Google Drive, GitHub).
 *
 * Company first: a connection belongs to the company. An owner or admin
 * connects it (the kernel refuses anyone else a company-owned ticket), every
 * agent of the company may use it, and the member who connected it is shown
 * for attribution only.
 *
 * Connecting an account is two hops: the cloud issues a one-time capture
 * ticket (RPC), and the member's browser takes that ticket to the company's
 * secret broker, which sends the member to the provider and seals what comes
 * back. Nothing secret passes through this module or Supabase: the browser
 * only ever sees the ticket, the broker origin and a provider consent page.
 * Several companies' brokers share one origin; `?company=<profileId>` (not a
 * secret) lets its router reach this company's broker, as for secret cards.
 * Contract §11.5; RPCs listed in supabase/CLIENT-CONTRACT.md §2.
 */

export type HostedConnectorId = "gmail" | "google_drive" | "github";

export const HOSTED_CONNECTORS: ReadonlyArray<{
	id: HostedConnectorId;
	label: string;
	logo: string;
	/** Whether a typed token is an alternative to signing in with the provider. */
	token?: true;
}> = [
	{ id: "gmail", label: "Gmail", logo: "provider-gmail.svg" },
	{ id: "google_drive", label: "Google Drive", logo: "provider-drive.svg" },
	{ id: "github", label: "GitHub", logo: "provider-github.svg", token: true },
];

export interface HostedConnectorConnection {
	secretId: string;
	version: number;
	connectorId: string;
	secretName: string;
	purpose: string;
	ownerKind: "company" | "member";
	ownerUserId: string | null;
	status: "active" | "revoked";
	accountLabel: string | null;
	/** The member who connected a company connection: attribution only. */
	connectedByUserId: string | null;
	availableToAllAgents: boolean;
	activeGrantCount: number;
	createdAt: string;
	updatedAt: string;
}

export interface HostedConnectorCaptureTicket {
	ticketId: string;
	captureCapability: string;
	serviceOrigin: string;
	expiresAt: string;
}

/** A sign-in this browser tab started, kept in session storage until the
 * provider sends the member back. The proof never leaves this tab except to
 * the company's broker in the confirm request. */
export interface HostedConnectorSignIn {
	ticketId: string;
	connectorId: HostedConnectorId;
	companyId: string;
	serviceOrigin: string;
	browserProof: string;
	startedAt: number;
}

export interface HostedConnectorReturn {
	connector: HostedConnectorId;
	connection: "confirm" | "failed";
	confirmation?: string;
	reason?: string;
	signIn: HostedConnectorSignIn;
}

const SIGN_IN_KEY = "qorpera.connector-sign-in.v1";
const SIGN_IN_TTL_MS = 15 * 60_000;
const CONFIRM_DEADLINE_MS = 45_000;

function readSignIn(): HostedConnectorSignIn | undefined {
	try {
		const text = sessionStorage.getItem(SIGN_IN_KEY);
		if (!text) return undefined;
		const value = JSON.parse(text) as Record<string, unknown>;
		if (
			typeof value.ticketId !== "string" ||
			!UUID_PATTERN.test(value.ticketId) ||
			typeof value.connectorId !== "string" ||
			!CONNECTOR_IDS.has(value.connectorId) ||
			typeof value.companyId !== "string" ||
			!UUID_PATTERN.test(value.companyId) ||
			typeof value.serviceOrigin !== "string" ||
			typeof value.browserProof !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(value.browserProof) ||
			typeof value.startedAt !== "number"
		)
			return undefined;
		const origin = new URL(value.serviceOrigin);
		if (origin.protocol !== "https:" || origin.origin !== value.serviceOrigin) return undefined;
		return value as unknown as HostedConnectorSignIn;
	} catch {
		return undefined;
	}
}

function forgetSignIn(): void {
	try {
		sessionStorage.removeItem(SIGN_IN_KEY);
	} catch {
		// Storage unavailable: nothing was kept.
	}
}

function base64Url(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CONNECTOR_IDS = new Set<string>(HOSTED_CONNECTORS.map((connector) => connector.id));

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
	return value;
}

export function parseConnectorConnections(value: unknown): HostedConnectorConnection[] {
	if (!Array.isArray(value)) throw new Error("Invalid connections.");
	return value.map((item) => {
		const input = record(item, "connection");
		if (input.schema !== "qorpera.cloud-secret-descriptor/v1") throw new Error("Invalid connection.");
		const status = input.status === "revoked" ? "revoked" : "active";
		return {
			secretId: text(input.secretId, "connection id"),
			version: typeof input.version === "number" ? input.version : 1,
			connectorId: text(input.connectorId, "connector"),
			secretName: text(input.secretName, "connection name"),
			purpose: typeof input.purpose === "string" ? input.purpose : "",
			ownerKind: input.ownerKind === "company" ? "company" : "member",
			ownerUserId: typeof input.ownerUserId === "string" ? input.ownerUserId : null,
			status,
			accountLabel: typeof input.accountLabel === "string" ? input.accountLabel : null,
			connectedByUserId:
				typeof input.connectedByUserId === "string" && UUID_PATTERN.test(input.connectedByUserId)
					? input.connectedByUserId
					: null,
			availableToAllAgents: input.availableToAllAgents === true,
			activeGrantCount: typeof input.activeGrantCount === "number" ? input.activeGrantCount : 0,
			createdAt: typeof input.createdAt === "string" ? input.createdAt : "",
			updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "",
		};
	});
}

function parseTicket(value: unknown): HostedConnectorCaptureTicket {
	const input = record(value, "capture ticket");
	if (input.schema !== "qorpera.cloud-secret-capture/v1") throw new Error("Invalid capture ticket.");
	const origin = new URL(text(input.serviceOrigin, "broker origin"));
	if (origin.protocol !== "https:" || origin.origin !== origin.href.replace(/\/$/, ""))
		throw new Error("Invalid broker origin.");
	const ticketId = text(input.ticketId, "ticket id");
	if (!UUID_PATTERN.test(ticketId)) throw new Error("Invalid capture ticket.");
	return {
		ticketId,
		captureCapability: text(input.captureCapability, "capture capability"),
		serviceOrigin: origin.origin,
		expiresAt: text(input.expiresAt, "ticket expiry"),
	};
}

/** Reads and strips a connector outcome the broker appended to the page hash
 * after a provider sign-in (`#/c/<id>?connector=gmail&connection=confirm&confirmation=…`).
 * It counts only for a sign-in this tab started: a crafted link with no
 * matching sign-in in session storage is stripped and does nothing. */
export function takeConnectorReturn(): HostedConnectorReturn | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	if (at < 0) return undefined;
	const params = new URLSearchParams(hash.slice(at + 1));
	const connector = params.get("connector");
	const connection = params.get("connection");
	if (!connector || !CONNECTOR_IDS.has(connector) || (connection !== "confirm" && connection !== "failed"))
		return undefined;
	history.replaceState(null, "", hash.slice(0, at) || "#/");
	const signIn = readSignIn();
	if (!signIn || signIn.connectorId !== connector || Date.now() - signIn.startedAt > SIGN_IN_TTL_MS) {
		forgetSignIn();
		return undefined;
	}
	const confirmation = params.get("confirmation") ?? "";
	if (connection === "confirm" && !/^[A-Za-z0-9_-]{43}$/.test(confirmation)) {
		forgetSignIn();
		return undefined;
	}
	if (connection === "failed") forgetSignIn();
	const reason = params.get("reason") ?? undefined;
	return {
		connector: connector as HostedConnectorId,
		connection,
		...(connection === "confirm" ? { confirmation } : {}),
		...(reason ? { reason } : {}),
		signIn,
	};
}

/** Whose secret a capture makes or replaces, and what it is called. The cloud checks each against the member's
 * role before it issues a ticket. */
export interface SecretCaptureTarget {
	ownerKind: "company" | "member";
	/** The member who owns a member secret (always the caller); null for the company's. */
	ownerUserId: string | null;
	connectorId: string;
	secretName: string;
	purpose: string;
	/** The secret whose value this capture replaces; undefined for a new one. */
	existingSecretId: string | undefined;
}

/** The two hops every typed secret takes: a one-time ticket from the cloud, then the company's broker. */
export interface SecretCapture {
	ticket(target: SecretCaptureTarget): Promise<HostedConnectorCaptureTicket>;
	/** Posts JSON to the broker and resolves to its status and answer, whatever the status. */
	call(
		url: string,
		body: unknown,
		signal: AbortSignal | undefined,
		deadlineMs?: number,
	): Promise<{ status: number; value: unknown }>;
	/** Posts JSON to the broker; anything but a 200 is a failure. */
	post(url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown>;
	/** Hands typed fields to the broker under a ticket; they never pass through Supabase. */
	send(
		issued: HostedConnectorCaptureTicket,
		fields: Readonly<Record<string, string>>,
		signal: AbortSignal | undefined,
	): Promise<void>;
}

export function createSecretCapture(
	cloud: Cloud,
	profile: { profileId: string; environmentId: string },
	fetchImplementation: typeof fetch = fetch,
): SecretCapture {
	const company = profile.profileId.toLowerCase();
	async function call(
		url: string,
		body: unknown,
		signal: AbortSignal | undefined,
		deadlineMs = 30_000,
	): Promise<{ status: number; value: unknown }> {
		return withCloudDeadline(
			async (deadline) => {
				const response = await fetchImplementation(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: deadline,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
				});
				const bytes = await readBoundedCloudResponse(response, 64 * 1024, deadline);
				let value: unknown = null;
				try {
					value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
				} catch {
					value = null;
				}
				return { status: response.status, value };
			},
			deadlineMs,
			signal,
		);
	}
	async function post(url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
		const answer = await call(url, body, signal);
		if (answer.status !== 200) throw new Error("The connection could not be started. Try again.");
		return answer.value;
	}
	return {
		async ticket(target) {
			return parseTicket(
				await cloud.rpc("qorpera_begin_cloud_secret_capture", {
					p_profile_id: profile.profileId,
					p_environment_id: profile.environmentId,
					p_owner_kind: target.ownerKind,
					p_owner_user_id: target.ownerUserId,
					p_connector_id: target.connectorId,
					p_secret_name: target.secretName,
					p_purpose: target.purpose,
					p_existing_secret_id: target.existingSecretId ?? null,
				}),
			);
		},
		call,
		post,
		async send(issued, fields, signal) {
			await post(
				`${issued.serviceOrigin}/v1/captures/${issued.ticketId}?company=${company}`,
				{
					schema: "qorpera.cloud-secret-capture-request/v1",
					captureCapability: issued.captureCapability,
					fields,
				},
				signal,
			);
		},
	};
}

export interface WebConnectors {
	list(signal?: AbortSignal): Promise<HostedConnectorConnection[]>;
	/** Starts a provider sign-in for a company connection; resolves to the
	 * consent URL the browser must visit. The tab keeps a proof that only it
	 * can present when the member comes back. */
	beginSignIn(
		connectorId: HostedConnectorId,
		existingSecretId: string | undefined,
		signal?: AbortSignal,
	): Promise<string>;
	/** Finishes a sign-in this tab started: the broker seals the account only
	 * for the browser that holds the proof. Resolves to the account label. */
	finishSignIn(outcome: HostedConnectorReturn, signal?: AbortSignal): Promise<string | null>;
	/** Captures a typed token for a company connection directly at the broker;
	 * the token never reaches Supabase. */
	captureToken(
		connectorId: HostedConnectorId,
		token: string,
		existingSecretId: string | undefined,
		signal?: AbortSignal,
	): Promise<void>;
	/** Grants every operation of the connection to all active agents, including
	 * future hires. A company connection is always shared; there is no unshare. */
	grantAllAgents(secretId: string, signal?: AbortSignal): Promise<void>;
	disconnect(secretId: string, signal?: AbortSignal): Promise<void>;
}

export function createWebConnectors(
	cloud: Cloud,
	profile: { profileId: string; environmentId: string },
	fetchImplementation: typeof fetch = fetch,
): WebConnectors {
	if (!UUID_PATTERN.test(profile.profileId) || !UUID_PATTERN.test(profile.environmentId))
		throw new Error("Invalid company for connectors.");
	const company = profile.profileId.toLowerCase();
	const capture = createSecretCapture(cloud, profile, fetchImplementation);
	const label = (connectorId: HostedConnectorId) =>
		HOSTED_CONNECTORS.find((connector) => connector.id === connectorId)?.label ?? connectorId;
	async function ticket(connectorId: HostedConnectorId, existingSecretId: string | undefined) {
		return capture.ticket({
			// Company first: the connection is the company's, never the member's.
			ownerKind: "company",
			ownerUserId: null,
			connectorId,
			secretName: "primary",
			purpose: `${label(connectorId)} account`,
			existingSecretId,
		});
	}
	return {
		async list(signal) {
			signal?.throwIfAborted();
			return parseConnectorConnections(
				await cloud.rpc("qorpera_list_cloud_secret_connections", {
					p_profile_id: profile.profileId,
					p_environment_id: profile.environmentId,
				}),
			);
		},
		async beginSignIn(connectorId, existingSecretId, signal) {
			const issued = await ticket(connectorId, existingSecretId);
			// This tab's proof: only its hash goes to the broker now; the proof
			// itself only with the confirmation after the provider sends us back.
			const browserProof = base64Url(crypto.getRandomValues(new Uint8Array(32)));
			const started = record(
				await capture.post(
					`${issued.serviceOrigin}/v1/oauth/${issued.ticketId}/start?company=${company}`,
					{
						schema: "qorpera.cloud-connector-oauth-start/v2",
						captureCapability: issued.captureCapability,
						// The broker returns only to the app's root page; the route is in the hash.
						returnTo: `${location.origin}/${location.hash}`,
						browserProofSha256: await sha256Hex(browserProof),
					},
					signal,
				),
				"sign-in start",
			);
			const url = new URL(text(started.authorizationUrl, "sign-in URL"));
			if (url.protocol !== "https:") throw new Error("Invalid sign-in URL.");
			const signIn: HostedConnectorSignIn = {
				ticketId: issued.ticketId,
				connectorId,
				companyId: company,
				serviceOrigin: issued.serviceOrigin,
				browserProof,
				startedAt: Date.now(),
			};
			try {
				sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify(signIn));
			} catch {
				throw new Error("This browser does not allow the sign-in to be finished here.");
			}
			return url.href;
		},
		async finishSignIn(outcome, signal) {
			const signIn = outcome.signIn;
			// One attempt: the proof is dropped whatever the broker answers.
			forgetSignIn();
			if (outcome.connection !== "confirm" || !outcome.confirmation || signIn.companyId !== company)
				throw new Error("This sign-in cannot be finished here.");
			const answer = await capture.call(
				`${signIn.serviceOrigin}/v1/oauth/${signIn.ticketId}/confirm?company=${company}`,
				{
					schema: "qorpera.cloud-connector-oauth-confirm/v1",
					confirmation: outcome.confirmation,
					browserProof: signIn.browserProof,
				},
				signal,
				// Longer than the broker's worst case for a confirm: 20 s for the
				// provider exchange and account label, then 15 s to seal.
				CONFIRM_DEADLINE_MS,
			);
			const value =
				answer.value && typeof answer.value === "object" ? (answer.value as Record<string, unknown>) : {};
			if (answer.status !== 200 || value.schema !== "qorpera.cloud-connector-oauth-confirmed/v1") {
				const reason = typeof value.reason === "string" ? value.reason : "provider_error";
				throw Object.assign(new Error("The sign-in could not be finished."), { reason });
			}
			return typeof value.accountLabel === "string" ? value.accountLabel : null;
		},
		async captureToken(connectorId, token, existingSecretId, signal) {
			const trimmed = token.trim();
			if (!trimmed || trimmed.length > 4096 || /\s/.test(trimmed))
				throw new Error("That does not look like a token.");
			const issued = await ticket(connectorId, existingSecretId);
			const connector = HOSTED_CONNECTORS.find((item) => item.id === connectorId);
			if (!connector?.token) throw new Error("This service only connects by signing in.");
			await capture.send(issued, { access_token: trimmed }, signal);
		},
		async grantAllAgents(secretId, signal) {
			signal?.throwIfAborted();
			await cloud.rpc("qorpera_grant_cloud_connector", {
				p_profile_id: profile.profileId,
				p_environment_id: profile.environmentId,
				p_secret_id: secretId,
				p_staff_agent_ids: null,
			});
		},
		async disconnect(secretId, signal) {
			signal?.throwIfAborted();
			await cloud.rpc("qorpera_revoke_cloud_secret", { p_profile_id: profile.profileId, p_secret_id: secretId });
		},
	};
}
