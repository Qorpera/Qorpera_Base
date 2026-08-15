import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@qorpera/pi-ai";

const MODEL_ACCOUNT_SCHEMA = "qorpera.model-accounts/v1";
const MAX_ACCOUNTS = 64;
const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

export interface ModelAccountUsageWindow {
	id: string;
	label: string;
	usedPercent: number;
	remainingPercent: number;
	resetAt?: string;
}

export interface ModelAccountUsage {
	status: "available" | "unavailable" | "error";
	windows: ModelAccountUsageWindow[];
	refreshedAt: string;
	detail?: string;
}

interface StoredModelAccount {
	id: string;
	ownerUserId: string;
	providerId: string;
	credential: Credential;
	createdAt: string;
	lastUsedAt?: string;
	usage?: ModelAccountUsage;
	rateLimitedUntil?: string;
}

interface ModelAccountDocument {
	schema: typeof MODEL_ACCOUNT_SCHEMA;
	accounts: StoredModelAccount[];
}

export interface ModelAccountView {
	id: string;
	providerId: string;
	accountName: string;
	usage?: ModelAccountUsage;
	lastUsedAt?: string;
}

export interface ModelAccountLease {
	accountId: string;
	run<T>(operation: () => Promise<T>): Promise<T>;
	release(): void;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finitePercent(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

function decodeJwtClaims(access: unknown): Record<string, unknown> | undefined {
	if (typeof access !== "string") return undefined;
	const parts = access.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		return recordValue(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")));
	} catch {
		return undefined;
	}
}

function credentialAccountName(providerId: string, credential: Credential): string {
	const record = credential as Credential & Record<string, unknown>;
	for (const field of ["email", "accountName", "account_name", "name"]) {
		const value = record[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	const claims = decodeJwtClaims(record.access);
	for (const source of [claims, recordValue(claims?.["https://api.openai.com/profile"])]) {
		if (!source) continue;
		for (const field of ["email", "emailAddress", "name", "preferred_username"]) {
			const value = source[field];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	const accountId = record.accountId;
	if (typeof accountId === "string" && accountId.trim()) return `${providerId} · ${accountId.slice(-8)}`;
	return credential.type === "api_key" ? `${providerId} API key` : `${providerId} account`;
}

function stableCredentialIdentity(providerId: string, credential: Credential): string {
	const record = credential as Credential & Record<string, unknown>;
	for (const field of ["accountId", "email"]) {
		const value = record[field];
		if (typeof value === "string" && value.trim()) return `${providerId}:${field}:${value.trim().toLowerCase()}`;
	}
	const claims = decodeJwtClaims(record.access);
	for (const field of ["email", "sub"]) {
		const value = claims?.[field];
		if (typeof value === "string" && value.trim()) return `${providerId}:claim:${value.trim().toLowerCase()}`;
	}
	return `${providerId}:credential:${createHash("sha256").update(JSON.stringify(credential)).digest("hex")}`;
}

function credential(value: unknown): Credential | undefined {
	const record = recordValue(value);
	if (!record || (record.type !== "oauth" && record.type !== "api_key")) return undefined;
	return record as unknown as Credential;
}

function parseDocument(content: string | undefined): ModelAccountDocument {
	if (!content) return { schema: MODEL_ACCOUNT_SCHEMA, accounts: [] };
	try {
		const parsed = recordValue(JSON.parse(content));
		if (parsed?.schema !== MODEL_ACCOUNT_SCHEMA || !Array.isArray(parsed.accounts)) {
			return { schema: MODEL_ACCOUNT_SCHEMA, accounts: [] };
		}
		const accounts: StoredModelAccount[] = [];
		for (const value of parsed.accounts) {
			const account = recordValue(value);
			const storedCredential = credential(account?.credential);
			if (
				!account ||
				!storedCredential ||
				typeof account.id !== "string" ||
				typeof account.ownerUserId !== "string" ||
				typeof account.providerId !== "string" ||
				typeof account.createdAt !== "string"
			)
				continue;
			accounts.push(account as unknown as StoredModelAccount);
			if (accounts.length >= MAX_ACCOUNTS) break;
		}
		return { schema: MODEL_ACCOUNT_SCHEMA, accounts };
	} catch {
		return { schema: MODEL_ACCOUNT_SCHEMA, accounts: [] };
	}
}

function openAiUsageWindows(value: unknown): ModelAccountUsageWindow[] {
	const root = recordValue(value);
	const limits = recordValue(root?.rate_limit) ?? recordValue(root?.rate_limits);
	if (!limits) return [];
	const windows: ModelAccountUsageWindow[] = [];
	for (const [id, label, raw] of [
		["primary", "Current window", recordValue(limits.primary_window) ?? recordValue(limits.primary)],
		["secondary", "Weekly", recordValue(limits.secondary_window) ?? recordValue(limits.secondary)],
	] as const) {
		const usedPercent = finitePercent(raw?.used_percent);
		if (usedPercent === undefined) continue;
		const minutes =
			typeof raw?.window_minutes === "number"
				? raw.window_minutes
				: typeof raw?.limit_window_seconds === "number"
					? raw.limit_window_seconds / 60
					: undefined;
		const resolvedLabel = minutes === 300 ? "5 hours" : minutes === 10080 ? "Weekly" : label;
		const resetAtValue = raw?.reset_at;
		const resetAt =
			typeof resetAtValue === "number"
				? new Date(resetAtValue * 1000).toISOString()
				: typeof resetAtValue === "string"
					? resetAtValue
					: undefined;
		windows.push({
			id,
			label: resolvedLabel,
			usedPercent,
			remainingPercent: 100 - usedPercent,
			...(resetAt ? { resetAt } : {}),
		});
	}
	return windows;
}

function anthropicUsageWindows(value: unknown): ModelAccountUsageWindow[] {
	const root = recordValue(value);
	if (!root) return [];
	const labels: Record<string, string> = {
		five_hour: "5 hours",
		seven_day: "Weekly",
		seven_day_opus: "Weekly Opus",
		seven_day_sonnet: "Weekly Sonnet",
	};
	const windows: ModelAccountUsageWindow[] = [];
	for (const [id, label] of Object.entries(labels)) {
		const raw = recordValue(root[id]);
		const usedPercent = finitePercent(raw?.utilization);
		if (usedPercent === undefined) continue;
		const resetAt = typeof raw?.resets_at === "string" ? raw.resets_at : undefined;
		windows.push({ id, label, usedPercent, remainingPercent: 100 - usedPercent, ...(resetAt ? { resetAt } : {}) });
	}
	return windows;
}

function applyAnthropicAccountMetadata(account: StoredModelAccount, value: unknown): void {
	const profile = recordValue(value);
	const identity = recordValue(profile?.account);
	if (!identity || account.credential.type !== "oauth") return;
	const email = typeof identity.email === "string" ? identity.email.trim() : "";
	const accountName = typeof identity.display_name === "string" ? identity.display_name.trim() : "";
	const accountId = typeof identity.uuid === "string" ? identity.uuid.trim() : "";
	if (email) account.credential.email = email;
	if (accountName) account.credential.accountName = accountName;
	if (accountId) account.credential.accountId = accountId;
}

export class ModelAccountStore implements CredentialStore {
	private readonly path: string;
	private readonly legacyAuthPath: string;
	private readonly fetch: Fetch;
	private readonly accountContext = new AsyncLocalStorage<string>();
	private readonly inFlight = new Map<string, number>();
	private readonly managedProviders = new Set<string>();
	private document: ModelAccountDocument;
	private activeOwnerUserId: string | undefined;
	private mutationChain: Promise<void> = Promise.resolve();

	constructor(path: string, legacyAuthPath: string, options: { fetch?: Fetch; ownerUserId?: string } = {}) {
		this.path = path;
		this.legacyAuthPath = legacyAuthPath;
		this.fetch = options.fetch ?? fetch;
		this.activeOwnerUserId = options.ownerUserId;
		this.document = parseDocument(existsSync(path) ? readFileSync(path, "utf-8") : undefined);
		for (const account of this.document.accounts) this.managedProviders.add(account.providerId);
		if (this.activeOwnerUserId) this.importLegacyCredentials(this.activeOwnerUserId);
	}

	setActiveOwner(ownerUserId: string | undefined): void {
		this.activeOwnerUserId = ownerUserId;
		if (ownerUserId) this.importLegacyCredentials(ownerUserId);
		this.syncLegacyCredentials();
	}

	private activeAccounts(providerId?: string): StoredModelAccount[] {
		if (!this.activeOwnerUserId) return [];
		return this.document.accounts.filter(
			(account) =>
				account.ownerUserId === this.activeOwnerUserId && (!providerId || account.providerId === providerId),
		);
	}

	private remaining(account: StoredModelAccount): number {
		if (account.rateLimitedUntil && Date.parse(account.rateLimitedUntil) > Date.now()) return 0;
		const values = account.usage?.windows.map((window) => window.remainingPercent) ?? [];
		return values.length ? Math.min(...values) : 50;
	}

	private selected(providerId: string): StoredModelAccount | undefined {
		const contextual = this.accountContext.getStore();
		if (contextual) {
			return this.activeAccounts(providerId).find((account) => account.id === contextual);
		}
		return this.activeAccounts(providerId).sort((left, right) => {
			const remaining = this.remaining(right) - this.remaining(left);
			if (remaining) return remaining;
			const load = (this.inFlight.get(left.id) ?? 0) - (this.inFlight.get(right.id) ?? 0);
			if (load) return load;
			return Date.parse(left.lastUsedAt ?? left.createdAt) - Date.parse(right.lastUsedAt ?? right.createdAt);
		})[0];
	}

	private write(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(this.document, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
			renameSync(temporary, this.path);
			chmodSync(this.path, 0o600);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	private syncLegacyCredentials(): void {
		let legacy: Record<string, unknown> = {};
		try {
			legacy = recordValue(JSON.parse(readFileSync(this.legacyAuthPath, "utf-8"))) ?? {};
		} catch {
			// The canonical compatibility file is created below.
		}
		for (const providerId of this.managedProviders) {
			const selected = this.selected(providerId);
			if (selected) legacy[providerId] = selected.credential;
			else delete legacy[providerId];
		}
		mkdirSync(dirname(this.legacyAuthPath), { recursive: true, mode: 0o700 });
		writeFileSync(this.legacyAuthPath, `${JSON.stringify(legacy, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
		chmodSync(this.legacyAuthPath, 0o600);
	}

	private importLegacyCredentials(ownerUserId: string): void {
		let legacy: Record<string, unknown>;
		try {
			legacy = recordValue(JSON.parse(readFileSync(this.legacyAuthPath, "utf-8"))) ?? {};
		} catch {
			return;
		}
		let changed = false;
		for (const [providerId, value] of Object.entries(legacy)) {
			const storedCredential = credential(value);
			if (!storedCredential) continue;
			this.managedProviders.add(providerId);
			const identity = stableCredentialIdentity(providerId, storedCredential);
			const duplicate = this.document.accounts.some(
				(account) =>
					account.ownerUserId === ownerUserId &&
					account.providerId === providerId &&
					stableCredentialIdentity(providerId, account.credential) === identity,
			);
			if (duplicate) continue;
			this.document.accounts.push({
				id: randomUUID(),
				ownerUserId,
				providerId,
				credential: storedCredential,
				createdAt: new Date().toISOString(),
			});
			changed = true;
		}
		if (changed) this.write();
	}

	async add(providerId: string, value: Credential): Promise<ModelAccountView> {
		const ownerUserId = this.activeOwnerUserId;
		if (!ownerUserId) throw new Error("Sign in to Qorpera before adding a model account");
		const identity = stableCredentialIdentity(providerId, value);
		this.managedProviders.add(providerId);
		const existing = this.activeAccounts(providerId).find(
			(account) => stableCredentialIdentity(providerId, account.credential) === identity,
		);
		if (existing) existing.credential = value;
		else {
			if (this.document.accounts.length >= MAX_ACCOUNTS) throw new Error("Too many model accounts are stored");
			this.document.accounts.push({
				id: randomUUID(),
				ownerUserId,
				providerId,
				credential: value,
				createdAt: new Date().toISOString(),
			});
		}
		this.write();
		this.syncLegacyCredentials();
		const account = existing ?? this.activeAccounts(providerId).at(-1)!;
		return this.view(account);
	}

	async remove(accountId: string): Promise<boolean> {
		const account = this.activeAccounts().find((candidate) => candidate.id === accountId);
		if (!account) return false;
		this.document.accounts = this.document.accounts.filter((candidate) => candidate.id !== accountId);
		this.write();
		this.syncLegacyCredentials();
		return true;
	}

	async removeAll(): Promise<void> {
		if (!this.activeOwnerUserId) return;
		this.document.accounts = this.document.accounts.filter(
			(account) => account.ownerUserId !== this.activeOwnerUserId,
		);
		this.write();
		this.syncLegacyCredentials();
	}

	private view(account: StoredModelAccount): ModelAccountView {
		return {
			id: account.id,
			providerId: account.providerId,
			accountName: credentialAccountName(account.providerId, account.credential),
			...(account.usage ? { usage: account.usage } : {}),
			...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
		};
	}

	views(): ModelAccountView[] {
		return this.activeAccounts().map((account) => this.view(account));
	}

	credentialProjection(): Record<string, unknown> {
		return Object.fromEntries(
			[...new Set(this.activeAccounts().map((account) => account.providerId))].flatMap((providerId) => {
				const account = this.selected(providerId);
				return account ? [[providerId, account.credential]] : [];
			}),
		);
	}

	lease(providerId: string): ModelAccountLease | undefined {
		const account = this.selected(providerId);
		if (!account) return undefined;
		this.inFlight.set(account.id, (this.inFlight.get(account.id) ?? 0) + 1);
		let released = false;
		return {
			accountId: account.id,
			run: (operation) => this.accountContext.run(account.id, operation),
			release: () => {
				if (released) return;
				released = true;
				const count = (this.inFlight.get(account.id) ?? 1) - 1;
				if (count > 0) this.inFlight.set(account.id, count);
				else this.inFlight.delete(account.id);
				account.lastUsedAt = new Date().toISOString();
				this.write();
			},
		};
	}

	async withAccount<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
		const account = this.activeAccounts().find((candidate) => candidate.id === accountId);
		if (!account) throw new Error("Model account is unavailable");
		return this.accountContext.run(account.id, operation);
	}

	markRateLimited(accountId: string): void {
		const account = this.activeAccounts().find((candidate) => candidate.id === accountId);
		if (!account) return;
		const resetAt = account.usage?.windows
			.map((window) => window.resetAt)
			.filter((value): value is string => Boolean(value))
			.sort()[0];
		account.rateLimitedUntil = resetAt ?? new Date(Date.now() + 5 * 60_000).toISOString();
		this.write();
	}

	async refreshUsage(
		tokenFor: (accountId: string, providerId: string) => Promise<string | undefined>,
	): Promise<ModelAccountView[]> {
		await Promise.all(
			this.activeAccounts().map(async (account) => {
				const refreshedAt = new Date().toISOString();
				if (account.credential.type !== "oauth") {
					account.usage = {
						status: "unavailable",
						windows: [],
						refreshedAt,
						detail: "Provider quota is not reported for API keys.",
					};
					return;
				}
				if (account.providerId !== "openai-codex" && account.providerId !== "anthropic") {
					account.usage = {
						status: "unavailable",
						windows: [],
						refreshedAt,
						detail: "This provider does not expose account usage yet.",
					};
					return;
				}
				try {
					const accessToken = await tokenFor(account.id, account.providerId);
					if (!accessToken) throw new Error("Account token is unavailable");
					let response: Response;
					if (account.providerId === "openai-codex") {
						const raw = account.credential as Credential & Record<string, unknown>;
						const accountId = typeof raw.accountId === "string" ? raw.accountId : undefined;
						response = await this.fetch("https://chatgpt.com/backend-api/wham/usage", {
							headers: {
								Accept: "application/json",
								Authorization: `Bearer ${accessToken}`,
								...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
							},
							signal: AbortSignal.timeout(10_000),
						});
					} else {
						const raw = account.credential as Credential & Record<string, unknown>;
						if (typeof raw.email !== "string" || !raw.email.trim()) {
							try {
								const profileResponse = await this.fetch(ANTHROPIC_PROFILE_URL, {
									headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
									signal: AbortSignal.timeout(10_000),
								});
								if (profileResponse.ok) {
									applyAnthropicAccountMetadata(account, (await profileResponse.json()) as unknown);
								}
							} catch {
								// Identity is display metadata; quota refresh remains useful without it.
							}
						}
						response = await this.fetch("https://api.anthropic.com/api/oauth/usage", {
							headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
							signal: AbortSignal.timeout(10_000),
						});
					}
					if (!response.ok) throw new Error(`Usage request failed (${response.status})`);
					const body = (await response.json()) as unknown;
					const windows =
						account.providerId === "openai-codex" ? openAiUsageWindows(body) : anthropicUsageWindows(body);
					account.usage = windows.length
						? { status: "available", windows, refreshedAt }
						: {
								status: "unavailable",
								windows: [],
								refreshedAt,
								detail: "The provider returned no usage windows.",
							};
					if (windows.some((window) => window.remainingPercent > 0)) account.rateLimitedUntil = undefined;
				} catch (error) {
					account.usage = {
						status: "error",
						windows: account.usage?.windows ?? [],
						refreshedAt,
						detail: error instanceof Error ? error.message : "Usage is unavailable.",
					};
				}
			}),
		);
		this.write();
		return this.views();
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.selected(providerId)?.credential;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return [...new Set(this.activeAccounts().map((account) => account.providerId))].flatMap((providerId) => {
			const account = this.selected(providerId);
			return account ? [{ providerId, type: account.credential.type }] : [];
		});
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const contextualAccountId = this.accountContext.getStore();
		const previous = this.mutationChain;
		let resolveTail: (() => void) | undefined;
		this.mutationChain = new Promise<void>((resolve) => {
			resolveTail = resolve;
		});
		return previous.then(async () => {
			try {
				options?.signal?.throwIfAborted();
				const account = contextualAccountId
					? this.activeAccounts(providerId).find((candidate) => candidate.id === contextualAccountId)
					: this.selected(providerId);
				const next = await fn(account?.credential);
				if (!account || next === undefined) return account?.credential;
				account.credential = next;
				this.write();
				this.syncLegacyCredentials();
				return next;
			} finally {
				resolveTail?.();
			}
		});
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		const contextual = this.accountContext.getStore();
		this.document.accounts = this.document.accounts.filter(
			(account) =>
				account.ownerUserId !== this.activeOwnerUserId ||
				account.providerId !== providerId ||
				(Boolean(contextual) && account.id !== contextual),
		);
		this.write();
		this.syncLegacyCredentials();
	}
}
