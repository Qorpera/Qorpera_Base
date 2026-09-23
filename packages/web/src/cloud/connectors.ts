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
	summary: string;
	/** Whether a typed token is an alternative to signing in with the provider. */
	token?: { label: string; hint: string };
}> = [
	{
		id: "gmail",
		label: "Gmail",
		logo: "provider-google.svg",
		summary: "Read and search the mailbox, send email.",
	},
	{
		id: "google_drive",
		label: "Google Drive",
		logo: "provider-google.svg",
		summary: "Find, read, create and update documents.",
	},
	{
		id: "github",
		label: "GitHub",
		logo: "provider-github.svg",
		summary: "Repositories, issues, pull requests and files.",
		token: {
			label: "Use a personal access token instead",
			hint: "A fine-grained token with the repositories the agents may use.",
		},
	},
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

export interface HostedConnectorReturn {
	connector: HostedConnectorId;
	connection: "connected" | "failed";
	reason?: string;
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
 * after a provider sign-in (`#/c/<id>?connector=gmail&connection=connected`). */
export function takeConnectorReturn(): HostedConnectorReturn | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	if (at < 0) return undefined;
	const params = new URLSearchParams(hash.slice(at + 1));
	const connector = params.get("connector");
	const connection = params.get("connection");
	if (!connector || !CONNECTOR_IDS.has(connector) || (connection !== "connected" && connection !== "failed"))
		return undefined;
	history.replaceState(null, "", hash.slice(0, at) || "#/");
	const reason = params.get("reason") ?? undefined;
	return { connector: connector as HostedConnectorId, connection, ...(reason ? { reason } : {}) };
}

export interface WebConnectors {
	list(signal?: AbortSignal): Promise<HostedConnectorConnection[]>;
	/** Starts a provider sign-in for a company connection; resolves to the
	 * consent URL the browser must visit. */
	beginSignIn(
		connectorId: HostedConnectorId,
		existingSecretId: string | undefined,
		signal?: AbortSignal,
	): Promise<string>;
	/** Captures a typed token for a company connection directly at the broker;
	 * the token never reaches Supabase. */
	captureToken(
		connectorId: HostedConnectorId,
		token: string,
		existingSecretId: string | undefined,
		signal?: AbortSignal,
	): Promise<void>;
	/** Grants every operation of the connection to all active agents, including future hires. */
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
	const label = (connectorId: HostedConnectorId) =>
		HOSTED_CONNECTORS.find((connector) => connector.id === connectorId)?.label ?? connectorId;
	async function ticket(connectorId: HostedConnectorId, existingSecretId: string | undefined) {
		return parseTicket(
			await cloud.rpc("qorpera_begin_cloud_secret_capture", {
				p_profile_id: profile.profileId,
				p_environment_id: profile.environmentId,
				// Company first: the connection is the company's, never the member's.
				p_owner_kind: "company",
				p_owner_user_id: null,
				p_connector_id: connectorId,
				p_secret_name: "primary",
				p_purpose: `${label(connectorId)} account`,
				p_existing_secret_id: existingSecretId ?? null,
			}),
		);
	}
	async function brokerPost(url: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
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
				if (response.status !== 200) throw new Error("The connection could not be started. Try again.");
				return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
			},
			15_000,
			signal,
		);
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
			const started = record(
				await brokerPost(
					`${issued.serviceOrigin}/v1/oauth/${issued.ticketId}/start?company=${company}`,
					{
						schema: "qorpera.cloud-connector-oauth-start/v1",
						captureCapability: issued.captureCapability,
						returnTo: location.href,
					},
					signal,
				),
				"sign-in start",
			);
			const url = new URL(text(started.authorizationUrl, "sign-in URL"));
			if (url.protocol !== "https:") throw new Error("Invalid sign-in URL.");
			return url.href;
		},
		async captureToken(connectorId, token, existingSecretId, signal) {
			const trimmed = token.trim();
			if (!trimmed || trimmed.length > 4096 || /\s/.test(trimmed))
				throw new Error("That does not look like a token.");
			const issued = await ticket(connectorId, existingSecretId);
			const connector = HOSTED_CONNECTORS.find((item) => item.id === connectorId);
			if (!connector?.token) throw new Error("This service only connects by signing in.");
			await brokerPost(
				`${issued.serviceOrigin}/v1/captures/${issued.ticketId}?company=${company}`,
				{
					schema: "qorpera.cloud-secret-capture-request/v1",
					captureCapability: issued.captureCapability,
					fields: { access_token: trimmed },
				},
				signal,
			);
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
