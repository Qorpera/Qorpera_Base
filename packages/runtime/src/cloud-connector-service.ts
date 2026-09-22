import { createGitHubConnectorAdapters } from "./cloud-connector-github.ts";
import {
	createGmailConnectorAdapters,
	createGoogleDriveConnectorAdapters,
	type GoogleOAuthClient,
} from "./cloud-connector-google.ts";
import { CloudConnectorOAuthFlows, parseConnectorReturnOrigins } from "./cloud-connector-oauth.ts";
import type { CloudSecretConnectorAdapter } from "./cloud-secret-broker.ts";

/**
 * Composition of the production connectors inside the cloud secret broker.
 * The configuration is one private systemd credential
 * (`qorpera-cloud-secret-connectors`); without it the broker runs without
 * connectors and without OAuth routes, exactly as before Step 7.
 */

export interface CloudConnectorServiceConfig {
	readonly schema: "qorpera.cloud-connector-service/v1";
	/** The broker's TLS origin as member browsers and providers reach it; the
	 * OAuth callback is `<publicOrigin>/v1/oauth/callback`. */
	readonly publicOrigin: string;
	/** Web app origins allowed to start captures from a browser and to receive
	 * the member back after a provider sign-in. */
	readonly returnOrigins: readonly string[];
	readonly google?: GoogleOAuthClient;
	readonly github?: GoogleOAuthClient;
}

export interface CloudConnectorService {
	readonly adapters: readonly CloudSecretConnectorAdapter[];
	readonly oauth: CloudConnectorOAuthFlows;
	readonly corsOrigins: readonly string[];
	readonly connectors: readonly string[];
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

export function parseCloudConnectorServiceConfig(text: string): CloudConnectorServiceConfig {
	const input = record(JSON.parse(text), "Cloud connector service configuration");
	const keys = Object.keys(input).sort();
	if (
		input.schema !== "qorpera.cloud-connector-service/v1" ||
		keys.some((key) => !["schema", "publicOrigin", "returnOrigins", "google", "github"].includes(key)) ||
		typeof input.publicOrigin !== "string"
	)
		throw new Error("Cloud connector service configuration is invalid");
	const origin = new URL(input.publicOrigin);
	if (origin.origin !== input.publicOrigin || origin.protocol !== "https:")
		throw new Error("Cloud connector service public origin is invalid");
	const google = client(input.google, "Google OAuth client");
	const github = client(input.github, "GitHub OAuth client");
	if (!google && !github) throw new Error("Cloud connector service configuration names no OAuth client");
	return Object.freeze({
		schema: "qorpera.cloud-connector-service/v1",
		publicOrigin: origin.origin,
		returnOrigins: parseConnectorReturnOrigins(input.returnOrigins),
		...(google ? { google } : {}),
		...(github ? { github } : {}),
	});
}

export function composeCloudConnectorService(
	config: CloudConnectorServiceConfig,
	fetchImplementation: typeof fetch = fetch,
): CloudConnectorService {
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
	const oauth = new CloudConnectorOAuthFlows({
		clients: {
			...(config.google ? { google: config.google } : {}),
			...(config.github ? { github: config.github } : {}),
		},
		callbackUrl: `${config.publicOrigin}/v1/oauth/callback`,
		returnOrigins: config.returnOrigins,
		fetch: fetchImplementation,
	});
	return Object.freeze({
		adapters: Object.freeze(adapters),
		oauth,
		corsOrigins: config.returnOrigins,
		connectors: Object.freeze(connectors),
	});
}
