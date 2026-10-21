import { createPrivateKey } from "node:crypto";
import { POSTGRES_UUID_PATTERN } from "@qorpera/contracts";
import { type EnableBankingApp, EnableBankingClient } from "./cloud-connector-enable-banking.ts";
import { createGitHubConnectorAdapters } from "./cloud-connector-github.ts";
import {
	createGmailConnectorAdapters,
	createGoogleDriveConnectorAdapters,
	type GoogleOAuthClient,
} from "./cloud-connector-google.ts";
import { BANK_CONNECTOR_ID, CloudConnectorOAuthFlows, parseConnectorReturnOrigins } from "./cloud-connector-oauth.ts";
import { CloudConnectorTokenRevoker } from "./cloud-connector-token-revocation.ts";
import type { CloudSecretConnectorAdapter } from "./cloud-secret-broker.ts";

/**
 * Composition of the production connectors inside the cloud secret broker.
 * The configuration is one private systemd credential
 * (`qorpera-cloud-secret-connectors`); without it the broker runs without
 * connectors and without OAuth routes, exactly as before Step 7.
 *
 * Several companies' brokers share one public origin (each its own process
 * behind one router), so the configuration names that shared origin; the
 * OAuth state carries the company so the router can find this broker again
 * (see cloud-connector-oauth.ts). The member app origins that may start a
 * sign-in and receive the member back are the broker's own `memberOrigins`
 * (config v2), the same list the capture route answers to.
 *
 * `enableBanking` is Qorpera's Enable Banking application (its id and RSA
 * private key, PEM): with it the vault connects companies' banks and keeps
 * their bank summaries current (cloud-bank-sync.ts).
 */

export interface CloudConnectorServiceConfig {
	readonly schema: "qorpera.cloud-connector-service/v1";
	/** The broker's TLS origin as member browsers and providers reach it (the
	 * authority's bare `service_origin`); the OAuth callback registered at each
	 * provider is `<publicOrigin>/v1/oauth/callback`. */
	readonly publicOrigin: string;
	readonly google?: GoogleOAuthClient;
	readonly github?: GoogleOAuthClient;
	readonly enableBanking?: EnableBankingApp;
}

export interface CloudConnectorService {
	readonly adapters: readonly CloudSecretConnectorAdapter[];
	readonly oauth: CloudConnectorOAuthFlows;
	readonly connectors: readonly string[];
	/** Cancels disconnected and deleted companies' tokens at the provider (company delete D6). */
	readonly revoker: CloudConnectorTokenRevoker;
	/** Enable Banking, when the vault has the application: the bank sync's client. */
	readonly bank?: EnableBankingClient;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function client(value: unknown, label: string): GoogleOAuthClient | undefined {
	if (value === undefined) return undefined;
	const input = record(value, label);
	if (
		Object.keys(input).sort().join() !== "clientId,clientSecret" ||
		typeof input.clientId !== "string" ||
		typeof input.clientSecret !== "string" ||
		!/^[\x21-\x7e]{8,512}$/.test(input.clientId) ||
		!/^[\x21-\x7e]{8,512}$/.test(input.clientSecret)
	)
		throw new Error(`${label} is invalid`);
	return Object.freeze({ clientId: input.clientId, clientSecret: input.clientSecret });
}

function enableBankingApp(value: unknown): EnableBankingApp | undefined {
	if (value === undefined) return undefined;
	const input = record(value, "Enable Banking application");
	if (
		Object.keys(input).sort().join() !== "applicationId,privateKeyPem" ||
		typeof input.applicationId !== "string" ||
		!POSTGRES_UUID_PATTERN.test(input.applicationId) ||
		typeof input.privateKeyPem !== "string" ||
		input.privateKeyPem.length > 16_384
	)
		throw new Error("Enable Banking application is invalid");
	let type: string | undefined;
	try {
		type = createPrivateKey(input.privateKeyPem).asymmetricKeyType;
	} catch {
		type = undefined;
	}
	// Never the key's text in the message: the configuration error is logged.
	if (type !== "rsa") throw new Error("Enable Banking application is invalid");
	return Object.freeze({ applicationId: input.applicationId, privateKeyPem: input.privateKeyPem });
}

export function parseCloudConnectorServiceConfig(text: string): CloudConnectorServiceConfig {
	const input = record(JSON.parse(text), "Cloud connector service configuration");
	const keys = Object.keys(input).sort();
	if (
		input.schema !== "qorpera.cloud-connector-service/v1" ||
		keys.some((key) => !["schema", "publicOrigin", "google", "github", "enableBanking"].includes(key)) ||
		typeof input.publicOrigin !== "string"
	)
		throw new Error("Cloud connector service configuration is invalid");
	const origin = new URL(input.publicOrigin);
	if (origin.origin !== input.publicOrigin || origin.protocol !== "https:" || origin.username || origin.password)
		throw new Error("Cloud connector service public origin is invalid");
	const google = client(input.google, "Google OAuth client");
	const github = client(input.github, "GitHub OAuth client");
	const enableBanking = enableBankingApp(input.enableBanking);
	if (!google && !github && !enableBanking)
		throw new Error("Cloud connector service configuration names no OAuth client");
	return Object.freeze({
		schema: "qorpera.cloud-connector-service/v1",
		publicOrigin: origin.origin,
		...(google ? { google } : {}),
		...(github ? { github } : {}),
		...(enableBanking ? { enableBanking } : {}),
	});
}

export function composeCloudConnectorService(
	config: CloudConnectorServiceConfig,
	memberOrigins: readonly string[],
	fetchImplementation: typeof fetch = fetch,
): CloudConnectorService {
	// A sign-in must send the member back to the app; without a member origin
	// the broker would start flows it can never finish.
	const returnOrigins = parseConnectorReturnOrigins([...memberOrigins]);
	const adapters: CloudSecretConnectorAdapter[] = [];
	const connectors: string[] = [];
	if (config.github) {
		adapters.push(...createGitHubConnectorAdapters(fetchImplementation));
		connectors.push("github");
	}
	if (config.google) {
		adapters.push(...createGmailConnectorAdapters({ fetch: fetchImplementation, client: config.google }));
		adapters.push(...createGoogleDriveConnectorAdapters({ fetch: fetchImplementation, client: config.google }));
		connectors.push("gmail", "google_drive");
	}
	const bank = config.enableBanking ? new EnableBankingClient(config.enableBanking, fetchImplementation) : undefined;
	if (bank) connectors.push(BANK_CONNECTOR_ID);
	const oauth = new CloudConnectorOAuthFlows({
		clients: {
			...(config.google ? { google: config.google } : {}),
			...(config.github ? { github: config.github } : {}),
		},
		callbackUrl: `${config.publicOrigin}/v1/oauth/callback`,
		returnOrigins,
		fetch: fetchImplementation,
		...(bank ? { bank } : {}),
	});
	return Object.freeze({
		adapters: Object.freeze(adapters),
		oauth,
		connectors: Object.freeze(connectors),
		revoker: new CloudConnectorTokenRevoker({
			...(config.github ? { github: config.github } : {}),
			fetch: fetchImplementation,
		}),
		...(bank ? { bank } : {}),
	});
}
