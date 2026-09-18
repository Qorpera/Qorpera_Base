import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { CloudMemberBrowserRecovery } from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { CloudMemberCompanyComputerClient } from "@qorpera/cloud-client/cloud-member-company-computer";
import { CloudMemberCompanyPresence } from "@qorpera/cloud-client/cloud-member-company-presence";
import {
	NativeSubscriptionControlPlane,
	SupabaseNativeSubscriptionControlTransport,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { SupabaseCloudPresenceTransport } from "@qorpera/cloud-client/cloud-presence";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { CloudSessionRunControl } from "@qorpera/cloud-client/cloud-session-run-control";
import type { CompanyPathPresenceView } from "@qorpera/cloud-client/company-path-presence";
import {
	createSupabaseHostedPrimary,
	type HostedPrimaryDatabase,
	type QorperaHostedPrimary,
} from "@qorpera/cloud-client/hosted-primary";
import {
	HttpNativeProviderIdentityBridge,
	type NativeProviderIdentityBridge,
} from "@qorpera/cloud-client/native-provider-login";
import {
	ChainedCloudObjectTransport,
	CloudContentAddressedStore,
	type CloudObjectTransport,
	GATEWAY_EDGE_USER_AGENT,
	HttpCloudObjectTransport,
	SupabaseCloudObjectTransport,
} from "@qorpera/cloud-client/node/cloud-object-store";
import {
	createClient,
	isAuthRetryableFetchError,
	type Session,
	type SupportedStorage,
	type User,
} from "@supabase/supabase-js";
import {
	CloudMemberCompanyFileClient,
	type CloudMemberCompanyMode,
	parseCloudMemberCompanyMode,
} from "./cloud-member-company-editor.ts";
import { SupabaseCloudRealtimeTransport } from "./cloud-realtime-sync.ts";
import { CloudSessionAttachments } from "./cloud-session-attachments.ts";
import type { ProductFeedbackSubmission } from "./product-feedback.ts";

export const QORPERA_AUTH_URL = "https://wovsmjvghnbcbfazdtvr.supabase.co";
export const QORPERA_AUTH_PUBLISHABLE_KEY = "sb_publishable_nOLb65dGcfMmfiEJHVPuEg_aS2uzVjS";
export const QORPERA_AUTH_REDIRECT_PATTERN = "http://127.0.0.1:*/auth/callback";
export const QORPERA_OBJECT_GATEWAY_URL = "https://objects.qorpera.com";

const ACCOUNT_AUTH_FILE = "account-auth.json";
const ACCOUNT_PROJECTION_STORAGE_KEY = "qorpera-account-projection/v1";
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000;

export type QorperaAccountProvider = "github" | "google";

export interface QorperaAccount {
	id: string;
	email: string;
	displayName: string;
	avatarUrl?: string;
	provider?: string;
}

export interface QorperaAccountInfo {
	authenticated: boolean;
	user?: QorperaAccount;
	offline?: true;
}

export interface QorperaAccountAuthOptions {
	openExternal: (url: string) => Promise<void>;
	fetch?: typeof fetch;
	projectUrl?: string;
	publishableKey?: string;
	objectStoragePrimary?: "nas" | "supabase";
	objectGatewayUrl?: string;
	nativeProviderUrl?: string;
	officeViewerOrigin?: string;
	officeViewerClientOrigin?: string;
	timeoutMs?: number;
}

function configuredObjectStoragePrimary(configured: string | undefined): "nas" | "supabase" {
	if (configured !== undefined) {
		const value = configured.trim();
		if (value === "nas" || value === "supabase") return value;
		throw new Error("Qorpera object storage primary must be 'nas' or 'supabase'");
	}
	/* Cloud-first since the transports chained (2026-08-26): storage answers
	 * in milliseconds from anywhere while the gateway rides a consumer NAS
	 * that has now failed twice in one night; the chain still reads
	 * NAS-only objects through the gateway fallback and dual-writes keep
	 * the NAS converged as the carrier and backup. */
	return "supabase";
}

export class FileAccountAuthStorage implements SupportedStorage {
	readonly path: string;
	private memory: Record<string, string> = {};
	private persistent = true;

	constructor(path: string) {
		this.path = path;
	}

	getItem(key: string): string | null {
		return (this.persistent ? this.read() : this.memory)[key] ?? null;
	}

	setItem(key: string, value: string): void {
		if (!this.persistent) {
			this.memory[key] = value;
			return;
		}
		const entries = this.read();
		entries[key] = value;
		this.write(entries);
	}

	removeItem(key: string): void {
		if (!this.persistent) {
			delete this.memory[key];
			return;
		}
		const entries = this.read();
		if (!(key in entries)) return;
		delete entries[key];
		this.write(entries);
	}

	clear(): void {
		this.memory = {};
		rmSync(this.path, { force: true });
	}

	setPersistence(persistent: boolean): void {
		if (persistent === this.persistent) return;
		if (persistent) {
			this.memory = {};
			this.persistent = true;
			return;
		}
		this.memory = this.read();
		this.persistent = false;
		rmSync(this.path, { force: true });
	}

	private read(): Record<string, string> {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			const entries: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === "string") entries[key] = value;
			}
			return entries;
		} catch {
			return {};
		}
	}

	private write(entries: Record<string, string>): void {
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(temporary, `${JSON.stringify(entries, null, "\t")}\n`, {
				encoding: "utf-8",
				mode: 0o600,
			});
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}
}

export function accountAuthStoragePath(userData: string): string {
	return join(userData, ACCOUNT_AUTH_FILE);
}

export function projectQorperaAccount(user: User): QorperaAccount {
	const metadata = user.user_metadata;
	const displayName = [metadata.full_name, metadata.name, metadata.user_name, metadata.preferred_username]
		.find((value): value is string => typeof value === "string" && Boolean(value.trim()))
		?.trim();
	const avatarUrl = [metadata.avatar_url, metadata.picture].find(
		(value): value is string => typeof value === "string" && /^https:\/\//.test(value),
	);
	const provider = typeof user.app_metadata.provider === "string" ? user.app_metadata.provider : undefined;
	return {
		id: user.id,
		email: user.email ?? "",
		displayName: displayName ?? user.email?.split("@")[0] ?? "Qorpera user",
		...(avatarUrl ? { avatarUrl } : {}),
		...(provider ? { provider } : {}),
	};
}

interface LoopbackCallback {
	redirectTo: string;
	result: Promise<URL>;
	close: () => void;
}

async function startLoopbackCallback(timeoutMs: number): Promise<LoopbackCallback> {
	let settle: ((url: URL) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	let server: Server;
	const result = new Promise<URL>((resolvePromise, rejectPromise) => {
		settle = resolvePromise;
		fail = rejectPromise;
	});
	// A sign-in setup failure can close the listener before its result is
	// awaited. Keep that cancellation from becoming an unhandled rejection.
	void result.catch(() => {});
	server = createServer((request, response) => {
		const address = server.address();
		if (!address || typeof address === "string") {
			response.writeHead(503).end("Qorpera sign-in is unavailable.");
			return;
		}
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${address.port}`);
		if (url.pathname !== CALLBACK_PATH) {
			response.writeHead(404).end("Not found");
			return;
		}
		response.writeHead(200, {
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
			"content-type": "text/html; charset=utf-8",
		});
		response.end(
			"<!doctype html><meta charset=utf-8><title>Qorpera</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:80vh;color:#171716}</style><p>Signed in. You can close this tab and return to Qorpera.</p>",
		);
		if (!settled) {
			settled = true;
			settle?.(url);
		}
	});
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", rejectPromise);
			resolvePromise();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not reserve the Qorpera sign-in callback");
	}
	timeout = setTimeout(() => {
		if (settled) return;
		settled = true;
		fail?.(new Error("Sign-in timed out. Try again."));
		server.close();
	}, timeoutMs);
	return {
		redirectTo: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
		result,
		close: () => {
			if (timeout) clearTimeout(timeout);
			server.close();
		},
	};
}

function accountInfoForSession(session: Session | null): QorperaAccountInfo {
	return session ? { authenticated: true, user: projectQorperaAccount(session.user) } : { authenticated: false };
}

function parseCachedAccount(value: string | null): QorperaAccount | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const candidate = parsed as Record<string, unknown>;
		if (
			candidate.schema !== ACCOUNT_PROJECTION_STORAGE_KEY ||
			typeof candidate.account !== "object" ||
			candidate.account === null ||
			Array.isArray(candidate.account)
		) {
			return undefined;
		}
		const account = candidate.account as Record<string, unknown>;
		if (
			typeof account.id !== "string" ||
			!account.id ||
			Buffer.byteLength(account.id, "utf-8") > 128 ||
			typeof account.email !== "string" ||
			Buffer.byteLength(account.email, "utf-8") > 320 ||
			typeof account.displayName !== "string" ||
			!account.displayName ||
			Buffer.byteLength(account.displayName, "utf-8") > 512 ||
			(account.avatarUrl !== undefined &&
				(typeof account.avatarUrl !== "string" || !/^https:\/\//.test(account.avatarUrl))) ||
			(account.provider !== undefined &&
				(typeof account.provider !== "string" || Buffer.byteLength(account.provider, "utf-8") > 64))
		) {
			return undefined;
		}
		return {
			id: account.id,
			email: account.email,
			displayName: account.displayName,
			...(typeof account.avatarUrl === "string" ? { avatarUrl: account.avatarUrl } : {}),
			...(typeof account.provider === "string" ? { provider: account.provider } : {}),
		};
	} catch {
		return undefined;
	}
}

function storedSessionExpired(value: string | null): boolean {
	if (!value) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		return Boolean(
			parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				typeof (parsed as Record<string, unknown>).expires_at === "number" &&
				((parsed as Record<string, unknown>).expires_at as number) * 1000 <= Date.now(),
		);
	} catch {
		return false;
	}
}

export class QorperaAccountAuth {
	private readonly client;
	private readonly authStorageKey: string;
	private readonly primary: QorperaHostedPrimary;
	private readonly realtime: SupabaseCloudRealtimeTransport;
	private readonly presence: SupabaseCloudPresenceTransport;
	private readonly objects: CloudContentAddressedStore;
	private readonly nativeSubscriptions: NativeSubscriptionControlPlane;
	private readonly sessionRuns: CloudSessionRunControl;
	private readonly nativeIdentityBridge?: NativeProviderIdentityBridge;
	private readonly memberClientOptions: (
		companyId: string,
		environmentId: string,
		accountId: string,
	) => ConstructorParameters<typeof CloudMemberCompanyFileClient>[0];
	private readonly memberComputerOptions: (
		companyId: string,
		environmentId: string,
		accountId: string,
	) => ConstructorParameters<typeof CloudMemberCompanyComputerClient>[0];
	private readonly openExternal: (url: string) => Promise<void>;
	private readonly officeViewerOrigin?: string;
	private readonly officeViewerClientOrigin?: string;
	private readonly storage: FileAccountAuthStorage;
	private readonly timeoutMs: number;
	private refreshExpiredSessionInFlight: Promise<void> | undefined;
	private signInPending = false;

	constructor(userData: string, options: QorperaAccountAuthOptions) {
		this.openExternal = options.openExternal;
		if (options.officeViewerOrigin || options.officeViewerClientOrigin) {
			if (!options.officeViewerOrigin || !options.officeViewerClientOrigin)
				throw new Error("Invalid Company Computer viewer origin");
			const origin = new URL(options.officeViewerOrigin),
				clientOrigin = new URL(options.officeViewerClientOrigin);
			if (
				origin.protocol !== "wss:" ||
				origin.username ||
				origin.password ||
				origin.pathname !== "/" ||
				origin.search ||
				origin.hash ||
				(origin.origin !== options.officeViewerOrigin && `${origin.origin}/` !== options.officeViewerOrigin) ||
				clientOrigin.protocol !== "https:" ||
				clientOrigin.origin !== options.officeViewerClientOrigin
			)
				throw new Error("Invalid Company Computer viewer origin");
			this.officeViewerOrigin = origin.origin;
			this.officeViewerClientOrigin = clientOrigin.origin;
		}
		this.timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
		this.storage = new FileAccountAuthStorage(accountAuthStoragePath(userData));
		const projectUrl = options.projectUrl ?? QORPERA_AUTH_URL;
		this.authStorageKey = `sb-${new URL(projectUrl).hostname.split(".")[0]}-auth-token`;
		this.client = createClient<HostedPrimaryDatabase>(
			projectUrl,
			options.publishableKey ?? QORPERA_AUTH_PUBLISHABLE_KEY,
			{
				auth: {
					autoRefreshToken: true,
					detectSessionInUrl: false,
					flowType: "pkce",
					persistSession: true,
					storage: this.storage,
				},
				...(options.fetch ? { global: { fetch: options.fetch } } : {}),
			},
		);
		this.primary = createSupabaseHostedPrimary(this.client);
		this.realtime = new SupabaseCloudRealtimeTransport(this.client);
		this.presence = new SupabaseCloudPresenceTransport(this.client, this.primary);
		const objectStoragePrimary = configuredObjectStoragePrimary(
			options.objectStoragePrimary ?? process.env.QORPERA_OBJECT_STORAGE_PRIMARY,
		);
		const configuredObjectGatewayUrl =
			options.objectGatewayUrl?.trim() || process.env.QORPERA_OBJECT_GATEWAY_URL?.trim();
		const objectGatewayUrl =
			configuredObjectGatewayUrl ||
			(new URL(projectUrl).origin === new URL(QORPERA_AUTH_URL).origin ? QORPERA_OBJECT_GATEWAY_URL : undefined);
		this.memberComputerOptions = (companyId, environmentId, accountId) => {
			return {
				companyId,
				environmentId,
				supabaseUrl: projectUrl,
				publishableKey: options.publishableKey ?? QORPERA_AUTH_PUBLISHABLE_KEY,
				fetch: options.fetch,
				accessToken: async (signal) => {
					const { data, error } = await this.client.auth.getSession();
					signal.throwIfAborted();
					if (error || !data.session || data.session.user.id !== accountId)
						throw new Error("Company File member changed");
					return data.session.access_token;
				},
			};
		};
		this.memberClientOptions = (companyId, environmentId, accountId) => {
			if (!objectGatewayUrl) throw new Error("The governed Company File gateway is not configured");
			return { ...this.memberComputerOptions(companyId, environmentId, accountId), objectGatewayUrl };
		};
		const storageTransport = new SupabaseCloudObjectTransport(this.client);
		const gatewayTransport = objectGatewayUrl
			? new HttpCloudObjectTransport({
					baseUrl: objectGatewayUrl,
					fetch: options.fetch,
					accessToken: async () => {
						const { data, error } = await this.client.auth.getSession();
						if (error) throw error;
						if (!data.session) throw new Error("Qorpera object access requires sign-in");
						return data.session.access_token;
					},
				})
			: undefined;
		let objectTransport: CloudObjectTransport;
		if (objectStoragePrimary === "supabase") {
			objectTransport = gatewayTransport
				? new ChainedCloudObjectTransport(storageTransport, gatewayTransport)
				: storageTransport;
		} else {
			if (!gatewayTransport) throw new Error("Qorpera NAS object gateway is not configured");
			objectTransport = new ChainedCloudObjectTransport(gatewayTransport, storageTransport);
		}
		this.objects = new CloudContentAddressedStore(objectTransport);
		this.nativeSubscriptions = new NativeSubscriptionControlPlane(
			new SupabaseNativeSubscriptionControlTransport(async (name, args) => {
				const { data, error } = await this.client.rpc(name as never, args as never);
				return { data, error };
			}),
		);
		this.sessionRuns = new CloudSessionRunControl(async (name, args, signal) => {
			const { data, error } = await this.client.rpc(name as never, args as never).abortSignal(signal);
			return { data, error };
		});
		this.nativeIdentityBridge = new HttpNativeProviderIdentityBridge(
			options.nativeProviderUrl ?? new URL("/functions/v1/native-provider-login/", projectUrl).href,
			options.fetch ?? fetch,
		);
	}

	hostedPrimary(): QorperaHostedPrimary {
		return this.primary;
	}

	hostedRealtime(): SupabaseCloudRealtimeTransport {
		return this.realtime;
	}

	hostedPresence(): SupabaseCloudPresenceTransport {
		return this.presence;
	}

	hostedObjects(): CloudContentAddressedStore {
		return this.objects;
	}

	memberCompanyFile(companyId: string, environmentId: string, accountId: string): CloudMemberCompanyFileClient {
		return new CloudMemberCompanyFileClient(this.memberClientOptions(companyId, environmentId, accountId));
	}
	memberCompanyPresence(
		companyId: string,
		environmentId: string,
		accountId: string,
		signal: AbortSignal,
		onChange: (view: CompanyPathPresenceView) => void,
	): CloudMemberCompanyPresence {
		const options = this.memberClientOptions(companyId, environmentId, accountId),
			request = options.fetch ?? fetch;
		// Supabase reuses topics within one client. This observer owns its
		// connection so closing it cannot remove the app's member presence.
		const client = createClient(options.supabaseUrl, options.publishableKey, {
			auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
			accessToken: () => withCloudDeadline((requestSignal) => options.accessToken(requestSignal), 2000, signal),
		});
		return new CloudMemberCompanyPresence({
			...options,
			client,
			signal,
			onChange,
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.set("user-agent", GATEWAY_EDGE_USER_AGENT);
				return request(input, { ...init, headers });
			},
		});
	}
	memberCompanyComputer(
		companyId: string,
		environmentId: string,
		accountId: string,
	): CloudMemberCompanyComputerClient {
		return new CloudMemberCompanyComputerClient(this.memberComputerOptions(companyId, environmentId, accountId));
	}
	memberBrowserRecovery(accountId: string): CloudMemberBrowserRecovery {
		return new CloudMemberBrowserRecovery({
			memberId: accountId,
			rpc: async (method, args, signal) =>
				withCloudDeadline(
					async (deadline) => {
						const check = async () => {
							const { data, error } = await this.client.auth.getSession();
							deadline.throwIfAborted();
							if (error || data.session?.user.id !== accountId)
								throw new Error("Browser cleanup account changed");
						};
						await check();
						const response = await this.client.rpc(method as never, args as never).abortSignal(deadline);
						await check();
						return { data: response.data, error: response.error };
					},
					5000,
					signal,
				),
		});
	}
	memberCompanyComputerViews(companyId: string, environmentId: string, accountId: string) {
		if (!this.officeViewerOrigin) return undefined;
		const client = this.memberCompanyComputer(companyId, environmentId, accountId),
			origin = this.officeViewerOrigin,
			clientOrigin = this.officeViewerClientOrigin!;
		return (scope: Parameters<CloudMemberCompanyComputerClient["views"]>[0]) =>
			client.views(
				scope,
				accountId,
				`${origin}/office/${scope.companyComputerId}/view`,
				(url) => new WebSocket(url, { headers: { Origin: clientOrigin } }),
			);
	}

	sessionAttachments(companyId: string, environmentId: string, accountId: string): CloudSessionAttachments {
		return new CloudSessionAttachments(this.memberClientOptions(companyId, environmentId, accountId));
	}

	companyFileMode(companyId: string, accountId: string, signal: AbortSignal): Promise<CloudMemberCompanyMode> {
		return withCloudDeadline(
			async (deadline) => {
				const session = await this.client.auth.getSession();
				deadline.throwIfAborted();
				if (session.error || session.data.session?.user.id !== accountId)
					throw new Error("Company File member changed");
				const { data, error } = await this.client
					.rpc("qorpera_member_company_file_mode" as never, { p_profile_id: companyId } as never)
					.abortSignal(deadline);
				deadline.throwIfAborted();
				if (error)
					throw new Error(
						"Company File access mode is unavailable. Try again when the cloud connection is restored.",
					);
				return parseCloudMemberCompanyMode(data, companyId);
			},
			15_000,
			signal,
		);
	}

	nativeSubscriptionControl(): NativeSubscriptionControlPlane {
		return this.nativeSubscriptions;
	}

	cloudSessionRunControl(): CloudSessionRunControl {
		return this.sessionRuns;
	}

	nativeProviderIdentityBridge(): NativeProviderIdentityBridge {
		if (!this.nativeIdentityBridge) throw new Error("Cloud native provider login is not configured");
		return this.nativeIdentityBridge;
	}

	async submitProductFeedback(input: ProductFeedbackSubmission): Promise<string> {
		const { data, error } = await this.client.rpc(
			"qorpera_submit_product_feedback" as never,
			{
				p_client_feedback_id: input.clientFeedbackId,
				p_category: input.category,
				p_details: input.details,
				p_include_diagnostics: input.includeDiagnostics,
				p_diagnostics: input.diagnostics,
			} as never,
		);
		if (error) throw error;
		if (typeof data !== "string" || !data) throw new Error("Qorpera did not confirm the feedback submission");
		return data;
	}

	async info(): Promise<QorperaAccountInfo> {
		const cachedAccount = parseCachedAccount(this.storage.getItem(ACCOUNT_PROJECTION_STORAGE_KEY));
		if (cachedAccount && storedSessionExpired(this.storage.getItem(this.authStorageKey))) {
			this.refreshExpiredSession();
			return { authenticated: true, user: cachedAccount, offline: true };
		}
		try {
			const { data, error } = await this.client.auth.getSession();
			if (error) throw error;
			const account = accountInfoForSession(data.session);
			if (account.user) this.rememberAccount(account.user);
			else this.storage.removeItem(ACCOUNT_PROJECTION_STORAGE_KEY);
			return account;
		} catch (error) {
			if (!isAuthRetryableFetchError(error)) throw error;
			const account = parseCachedAccount(this.storage.getItem(ACCOUNT_PROJECTION_STORAGE_KEY));
			if (!account) throw error;
			return { authenticated: true, user: account, offline: true };
		}
	}

	async signInWithProvider(
		provider: QorperaAccountProvider,
		options: { rememberLocally?: boolean } = {},
		report: (message: string) => void = () => {},
	): Promise<QorperaAccountInfo> {
		return this.runSignIn(options.rememberLocally !== false, async () => {
			const callback = await startLoopbackCallback(this.timeoutMs);
			try {
				const { data, error } = await this.client.auth.signInWithOAuth({
					provider,
					options: { redirectTo: callback.redirectTo, skipBrowserRedirect: true },
				});
				if (error) throw error;
				if (!data.url) throw new Error("The sign-in provider did not return an authorization URL");
				report(`Finish signing in with ${provider === "github" ? "GitHub" : "Google"} in your browser…`);
				await this.openExternal(data.url);
				const callbackUrl = await callback.result;
				const providerError =
					callbackUrl.searchParams.get("error_description") ?? callbackUrl.searchParams.get("error");
				if (providerError) throw new Error(providerError);
				const code = callbackUrl.searchParams.get("code");
				if (!code) throw new Error("The sign-in callback did not include an authorization code");
				const { data: sessionData, error: exchangeError } = await this.client.auth.exchangeCodeForSession(
					code,
					data.flowId ? { flowId: data.flowId } : undefined,
				);
				if (exchangeError) throw exchangeError;
				if (!sessionData.session) throw new Error("Supabase did not create a Qorpera session");
				report("Signed in.");
				const account = accountInfoForSession(sessionData.session);
				if (account.user) this.rememberAccount(account.user);
				return account;
			} finally {
				callback.close();
			}
		});
	}

	async signInWithEmail(
		email: string,
		options: { rememberLocally?: boolean } = {},
		report: (message: string) => void = () => {},
	): Promise<QorperaAccountInfo> {
		const normalizedEmail = email.trim().toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error("Enter a valid email address");
		return this.runSignIn(options.rememberLocally !== false, async () => {
			const callback = await startLoopbackCallback(this.timeoutMs);
			try {
				const { error } = await this.client.auth.signInWithOtp({
					email: normalizedEmail,
					options: { emailRedirectTo: callback.redirectTo, shouldCreateUser: true },
				});
				if (error) throw error;
				report("Check your email and open the Qorpera sign-in link.");
				const callbackUrl = await callback.result;
				const providerError =
					callbackUrl.searchParams.get("error_description") ?? callbackUrl.searchParams.get("error");
				if (providerError) throw new Error(providerError);
				const code = callbackUrl.searchParams.get("code");
				if (!code) throw new Error("The email sign-in callback did not include an authorization code");
				const { data: sessionData, error: exchangeError } = await this.client.auth.exchangeCodeForSession(code);
				if (exchangeError) throw exchangeError;
				if (!sessionData.session) throw new Error("Supabase did not create a Qorpera session");
				report("Signed in.");
				const account = accountInfoForSession(sessionData.session);
				if (account.user) this.rememberAccount(account.user);
				return account;
			} finally {
				callback.close();
			}
		});
	}

	async signOut(): Promise<QorperaAccountInfo> {
		try {
			await this.client.auth.signOut({ scope: "local" });
		} finally {
			// Signing out must still close the local gate while offline. Provider
			// intelligence credentials are intentionally stored elsewhere.
			this.storage.clear();
		}
		return { authenticated: false };
	}

	private async runSignIn<T>(rememberLocally: boolean, operation: () => Promise<T>): Promise<T> {
		if (this.signInPending) throw new Error("Another Qorpera sign-in is already in progress");
		this.signInPending = true;
		this.storage.setPersistence(rememberLocally);
		try {
			return await operation();
		} finally {
			this.signInPending = false;
		}
	}

	private rememberAccount(account: QorperaAccount): void {
		this.storage.setItem(
			ACCOUNT_PROJECTION_STORAGE_KEY,
			JSON.stringify({ schema: ACCOUNT_PROJECTION_STORAGE_KEY, account }),
		);
	}

	private refreshExpiredSession(): void {
		if (this.refreshExpiredSessionInFlight) return;
		this.refreshExpiredSessionInFlight = this.client.auth
			.getSession()
			.then(({ data, error }) => {
				if (error) {
					if (!isAuthRetryableFetchError(error)) this.storage.removeItem(ACCOUNT_PROJECTION_STORAGE_KEY);
					return;
				}
				if (data.session) this.rememberAccount(projectQorperaAccount(data.session.user));
				else this.storage.removeItem(ACCOUNT_PROJECTION_STORAGE_KEY);
			})
			.catch((error: unknown) => {
				if (!isAuthRetryableFetchError(error)) this.storage.removeItem(ACCOUNT_PROJECTION_STORAGE_KEY);
			})
			.finally(() => {
				this.refreshExpiredSessionInFlight = undefined;
			});
	}
}
