import { CloudBankSyncs, logBankSyncPass } from "./cloud-bank-sync.ts";
import type { ChatGptPlanOAuth } from "./cloud-chatgpt-plan.ts";
import { ChatGptPlanSignIns } from "./cloud-chatgpt-plan-sign-in.ts";
import type { DigitalPostClient } from "./cloud-connector-digital-post.ts";
import type { EnableBankingClient } from "./cloud-connector-enable-banking.ts";
import {
	CloudConnectorTokenRevocations,
	CloudConnectorTokenRevoker,
	logConnectorTokenRevocationPass,
} from "./cloud-connector-token-revocation.ts";
import { CloudDigitalPostSyncs, logDigitalPostSyncPass } from "./cloud-digital-post-sync.ts";
import { CloudEventVerifications, logEventVerificationPass } from "./cloud-event-verification.ts";
import type { ModelLoginSignInHelper } from "./cloud-model-login-sign-in.ts";
import { CloudModelLoginUpkeep } from "./cloud-model-login-upkeep.ts";
import { CloudModelLoginVault, type ModelLoginRenewer } from "./cloud-model-login-vault.ts";
import { CloudModelLoginSignIns } from "./cloud-model-login-vault-sign-in.ts";
import { CloudModelLoginUsage } from "./cloud-model-login-vault-usage.ts";
import {
	CloudSecretBroker,
	type CloudSecretConnectorAdapter,
	type PostgresCloudSecretBrokerPrincipal,
} from "./cloud-secret-broker.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";
import type { DigitalPostPdfTextReader } from "./digital-post-pdf-text.ts";

/**
 * The shared vault (Vault By Default, founder decisions 2026-09-28): one broker process serves every
 * company created after its start time. It registers each new company itself (its authority row, with the
 * capability derived for it, and its switch to vault sign-in), and gives every company it serves its own
 * broker, login vault, sign-ins and usage, each on that company's own authority. Every database call
 * still names the company's authority and capability, so a request routed to the wrong company is refused
 * there. The background work of the single-company broker runs here for every company: finished sign-ins
 * are collected (often for a company whose member is signing in, now and then for all), each company's
 * upkeep pass runs in turn, and so does each company's connector token revocation queue (company delete
 * D6), once a minute, and each company's deliveries to signed hooks (W1b), every five seconds. With an
 * Enable Banking application, the companies whose bank sync is due are asked for once a minute and synced
 * in turn; with Qorpera's Digital Post certificate, so are the companies whose Digital Post sync is due
 * (RUNTIME-DIGITAL-POST.md).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A company the list does not know yet is looked up again at most this often. */
const MISSING_LOOKUP_MS = 2000;
/** After a member's sign-in poll, the company's finished sign-ins are collected often for this long. */
const SIGNING_IN_MS = 20 * 60_000;
const DEADLINE_MS = 15_000;

/** One company's services on its own authority. */
export interface CloudSecretBrokerCompanyScope {
	readonly companyId: string;
	readonly broker: CloudSecretBroker;
	readonly modelLogins: CloudModelLoginVault;
	readonly modelLoginSignIns: CloudModelLoginSignIns | undefined;
	readonly modelLoginUsage: CloudModelLoginUsage;
}

/** How a broker service finds the company a request is for. */
export interface CloudSecretBrokerCompanies {
	/** The company's services, or undefined when this vault does not serve it. */
	resolve(companyId: string, signal: AbortSignal): Promise<CloudSecretBrokerCompanyScope | undefined>;
	/** A member of the company is signing in: collect its finished sign-ins often for a while. */
	signingIn(companyId: string): void;
}

interface Served {
	readonly authorityId: string;
	readonly keyId: string;
	readonly scope: CloudSecretBrokerCompanyScope;
	readonly upkeep: CloudModelLoginUpkeep;
	readonly revocations: CloudConnectorTokenRevocations;
	readonly verifications: CloudEventVerifications;
	readonly bankSyncs: CloudBankSyncs | undefined;
	readonly digitalPostSyncs: CloudDigitalPostSyncs | undefined;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function company(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value.toLowerCase())) throw new Error("Shared vault company is invalid");
	return value.toLowerCase();
}

function servedEntry(value: unknown): { companyId: string; authorityId: string; keyId: string } {
	const input = record(value, "Shared vault company");
	if (typeof input.keyId !== "string" || !KEY_ID.test(input.keyId)) throw new Error("Shared vault company is invalid");
	return { companyId: company(input.companyId), authorityId: company(input.authorityId), keyId: input.keyId };
}

export class SharedCloudSecretBrokerCompanies implements CloudSecretBrokerCompanies {
	readonly #principal: Pick<
		PostgresCloudSecretBrokerPrincipal,
		"companies" | "register" | "authority" | "eventVerificationsDue" | "bankSyncsDue" | "digitalPostSyncsDue"
	>;
	readonly #keyring: CloudSecretKeyring;
	readonly #adapters: readonly CloudSecretConnectorAdapter[];
	readonly #helper: (ModelLoginSignInHelper & ModelLoginRenewer) | undefined;
	readonly #chatGptPlan: ChatGptPlanOAuth | undefined;
	readonly #revoker: Pick<CloudConnectorTokenRevoker, "revoke">;
	readonly #bank: Pick<EnableBankingClient, "balances" | "transactions"> | undefined;
	readonly #digitalPost: Pick<DigitalPostClient, "available" | "letter" | "receipt"> | undefined;
	readonly #digitalPostPdfText: DigitalPostPdfTextReader | undefined;
	readonly #refreshEveryMs: number;
	readonly #collectEveryMs: number;
	readonly #sweepEveryMs: number;
	readonly #upkeepEveryMs: number;
	readonly #revokeEveryMs: number;
	readonly #verifyEveryMs: number;
	readonly #bankEveryMs: number;
	readonly #digitalPostEveryMs: number;
	readonly #now: () => number;
	readonly #served = new Map<string, Served>();
	readonly #signingIn = new Map<string, number>();
	#lastLookup = Number.NEGATIVE_INFINITY;
	#lastSweep = Number.NEGATIVE_INFINITY;
	#refreshing: Promise<void> | undefined;
	readonly #timers = new Set<ReturnType<typeof setTimeout>>();
	#running = new Set<Promise<void>>();
	readonly #closing = new AbortController();
	#started = false;
	#closed = false;

	constructor(options: {
		principal: Pick<
			PostgresCloudSecretBrokerPrincipal,
			"companies" | "register" | "authority" | "eventVerificationsDue" | "bankSyncsDue" | "digitalPostSyncsDue"
		>;
		keyring: CloudSecretKeyring;
		adapters: readonly CloudSecretConnectorAdapter[];
		/** The login helper on this host: renewals and members' sign-ins. Absent, nothing renews or signs in. */
		helper?: ModelLoginSignInHelper & ModelLoginRenewer;
		/** OpenAI's side of ChatGPT plan logins (built switched off). Absent, no plan sign-in starts and no
		 * plan login is renewed or ended. */
		chatGptPlan?: ChatGptPlanOAuth;
		/** Cancels queued connector tokens at Google and GitHub; by default without a GitHub client. */
		revoker?: Pick<CloudConnectorTokenRevoker, "revoke">;
		/** Enable Banking: absent, no company's bank is synced. */
		bank?: Pick<EnableBankingClient, "balances" | "transactions">;
		/** Digital Post with Qorpera's certificate: absent, no company's Digital Post is fetched. */
		digitalPost?: Pick<DigitalPostClient, "available" | "letter" | "receipt">;
		/** Reads PDF-only letters' text; absent, they are kept without it. */
		digitalPostPdfText?: DigitalPostPdfTextReader;
		refreshEveryMs?: number;
		collectEveryMs?: number;
		sweepEveryMs?: number;
		upkeepEveryMs?: number;
		revokeEveryMs?: number;
		verifyEveryMs?: number;
		bankEveryMs?: number;
		digitalPostEveryMs?: number;
		now?: () => number;
	}) {
		this.#principal = options.principal;
		this.#keyring = options.keyring;
		this.#adapters = options.adapters;
		this.#helper = options.helper;
		this.#chatGptPlan = options.chatGptPlan;
		this.#revoker = options.revoker ?? new CloudConnectorTokenRevoker();
		this.#bank = options.bank;
		this.#digitalPost = options.digitalPost;
		this.#digitalPostPdfText = options.digitalPostPdfText;
		this.#refreshEveryMs = options.refreshEveryMs ?? 10_000;
		this.#collectEveryMs = options.collectEveryMs ?? 2000;
		this.#sweepEveryMs = options.sweepEveryMs ?? 30_000;
		this.#upkeepEveryMs = options.upkeepEveryMs ?? 5 * 60_000;
		this.#revokeEveryMs = options.revokeEveryMs ?? 60_000;
		this.#verifyEveryMs = options.verifyEveryMs ?? 5000;
		this.#bankEveryMs = options.bankEveryMs ?? 60_000;
		this.#digitalPostEveryMs = options.digitalPostEveryMs ?? 60_000;
		this.#now = options.now ?? Date.now;
	}

	async resolve(companyId: string, signal: AbortSignal): Promise<CloudSecretBrokerCompanyScope | undefined> {
		const id = company(companyId);
		const known = this.#served.get(id);
		if (known) return known.scope;
		// A refresh already running (the first one after a start included) may serve it: wait for that one.
		const running = this.#refreshing;
		if (running) {
			await running.catch(() => undefined);
			return this.#served.get(id)?.scope;
		}
		// A company created a moment ago may not be on the list yet: look again, but not on every request.
		if (this.#now() - this.#lastLookup < MISSING_LOOKUP_MS) return undefined;
		this.#lastLookup = this.#now();
		await this.refresh(signal);
		return this.#served.get(id)?.scope;
	}

	signingIn(companyId: string): void {
		this.#signingIn.set(company(companyId), this.#now() + SIGNING_IN_MS);
	}

	/** One refresh: registers the new companies, serves every registered one, drops the rest. */
	refresh(signal: AbortSignal): Promise<void> {
		this.#refreshing ??= this.#refresh(signal).finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #refresh(signal: AbortSignal): Promise<void> {
		const answer = record(await this.#principal.companies(signal), "Shared vault companies");
		if (
			answer.schema !== "qorpera.broker-principal-companies/v1" ||
			!Array.isArray(answer.registered) ||
			!Array.isArray(answer.unregistered)
		)
			throw new Error("Shared vault companies are invalid");
		if (typeof answer.keyId !== "string" || !KEY_ID.test(answer.keyId))
			throw new Error("Shared vault companies are invalid");
		const registered = answer.registered.map(servedEntry);
		// Registering switches the company to vault sign-in: only a vault that holds the principal's key
		// (and so can serve it) registers anyone.
		if (answer.unregistered.length > 0 && !this.#keyring.has(answer.keyId)) {
			console.error("Shared vault: this vault does not hold the principal's key; it registers no company.");
		} else {
			for (const waiting of answer.unregistered) {
				// Out of time: the next refresh registers the rest.
				if (signal.aborted) break;
				try {
					const done = record(
						await this.#principal.register(company(waiting), signal),
						"Shared vault registration",
					);
					if (done.schema !== "qorpera.broker-principal-registration/v1")
						throw new Error("Shared vault registration is invalid");
					registered.push(servedEntry(done));
				} catch {
					// Another copy of the vault registered it first, or it gained a vault of its own: the next
					// refresh lists it as it is. Only the fact is logged.
					console.error("Shared vault: a company's registration was refused; the next refresh looks again.");
				}
			}
		}
		const listed = new Set<string>();
		for (const entry of registered) {
			listed.add(entry.companyId);
			const known = this.#served.get(entry.companyId);
			if (known && known.authorityId === entry.authorityId && known.keyId === entry.keyId) continue;
			if (known) this.#drop(entry.companyId, known);
			// A key this vault cannot derive would strand every login the company seals: serve it only
			// once the vault holds that master key.
			if (!this.#keyring.has(entry.keyId)) continue;
			this.#served.set(entry.companyId, this.#serve(entry));
		}
		for (const [companyId, served] of [...this.#served]) if (!listed.has(companyId)) this.#drop(companyId, served);
	}

	/** Stops serving a company; its upkeep pass, if one runs, ends after the renewal in hand. */
	#drop(companyId: string, served: Served): void {
		this.#served.delete(companyId);
		this.#signingIn.delete(companyId);
		const closing: Promise<void> = served.upkeep.close().finally(() => {
			this.#running.delete(closing);
		});
		this.#running.add(closing);
	}

	#serve(entry: { companyId: string; authorityId: string; keyId: string }): Served {
		const authority = this.#principal.authority(entry.companyId, entry.authorityId);
		const helper = this.#helper;
		const plan = this.#chatGptPlan;
		const modelLogins = new CloudModelLoginVault({
			authority,
			keyring: this.#keyring,
			...(helper ? { renewer: helper } : {}),
			...(plan ? { chatGptPlan: plan } : {}),
		});
		return {
			authorityId: entry.authorityId,
			keyId: entry.keyId,
			scope: {
				companyId: entry.companyId,
				broker: new CloudSecretBroker({ authority, keyring: this.#keyring, adapters: this.#adapters }),
				modelLogins,
				modelLoginSignIns:
					helper || plan
						? new CloudModelLoginSignIns({
								authority,
								keyring: this.#keyring,
								...(helper ? { helper } : {}),
								...(plan
									? { plan: new ChatGptPlanSignIns({ oauth: plan, authority, keyring: this.#keyring }) }
									: {}),
							})
						: undefined,
				modelLoginUsage: new CloudModelLoginUsage({ authority, keyring: this.#keyring }),
			},
			// Its timer never runs: the shared upkeep loop runs each company's pass in turn.
			upkeep: new CloudModelLoginUpkeep({ vault: modelLogins }),
			revocations: new CloudConnectorTokenRevocations({ authority, keyring: this.#keyring, revoker: this.#revoker }),
			verifications: new CloudEventVerifications({ authority, keyring: this.#keyring }),
			bankSyncs: this.#bank
				? new CloudBankSyncs({ authority, keyring: this.#keyring, bank: this.#bank })
				: undefined,
			digitalPostSyncs: this.#digitalPost
				? new CloudDigitalPostSyncs({
						authority,
						keyring: this.#keyring,
						post: this.#digitalPost,
						...(this.#digitalPostPdfText ? { pdfText: this.#digitalPostPdfText } : {}),
					})
				: undefined,
		};
	}

	/** Finished sign-ins: every pass for a company whose member is signing in, every sweep for all. */
	async collect(): Promise<void> {
		const now = this.#now();
		const sweep = now - this.#lastSweep >= this.#sweepEveryMs;
		if (sweep) this.#lastSweep = now;
		for (const [companyId, until] of this.#signingIn) if (until <= now) this.#signingIn.delete(companyId);
		for (const served of this.#served.values()) {
			if (this.#closed) return;
			const signIns = served.scope.modelLoginSignIns;
			if (signIns && (sweep || this.#signingIn.has(served.scope.companyId))) await signIns.collect();
		}
	}

	/** Each company's upkeep pass in turn (accounts, switch-off, idle renewals). */
	async upkeep(): Promise<void> {
		for (const served of [...this.#served.values()]) {
			if (this.#closed) return;
			// A company dropped since the pass began is not worked on.
			if (this.#served.get(served.scope.companyId) === served) await served.upkeep.pass();
		}
	}

	/** Each company's queued connector tokens in turn. */
	async revokeTokens(): Promise<void> {
		for (const served of [...this.#served.values()]) {
			if (this.#closed) return;
			if (this.#served.get(served.scope.companyId) === served)
				await logConnectorTokenRevocationPass(served.revocations, this.#closing.signal);
		}
	}

	/** The deliveries to signed hooks of each company that has some due, in turn: one call asks which. */
	async verifyEvents(): Promise<void> {
		if (this.#closed) return;
		const answer = record(
			await this.#principal.eventVerificationsDue(
				AbortSignal.any([this.#closing.signal, AbortSignal.timeout(DEADLINE_MS)]),
			),
			"Shared vault event verifications",
		);
		if (
			answer.schema !== "qorpera.broker-principal-event-verifications/v1" ||
			!Array.isArray(answer.companyIds) ||
			answer.companyIds.length > 1000
		)
			throw new Error("Shared vault event verifications are invalid");
		for (const companyId of new Set(answer.companyIds.map(company))) {
			if (this.#closed) return;
			const served = this.#served.get(companyId);
			if (served) await logEventVerificationPass(served.verifications, this.#closing.signal);
		}
	}

	/** The bank syncs of each company that has one due, in turn: one call asks which. */
	async syncBanks(): Promise<void> {
		if (this.#closed || !this.#bank) return;
		const answer = record(
			await this.#principal.bankSyncsDue(AbortSignal.any([this.#closing.signal, AbortSignal.timeout(DEADLINE_MS)])),
			"Shared vault bank syncs",
		);
		if (
			answer.schema !== "qorpera.broker-principal-bank-syncs/v1" ||
			!Array.isArray(answer.companyIds) ||
			answer.companyIds.length > 1000
		)
			throw new Error("Shared vault bank syncs are invalid");
		for (const companyId of new Set(answer.companyIds.map(company))) {
			if (this.#closed) return;
			const syncs = this.#served.get(companyId)?.bankSyncs;
			if (syncs) await logBankSyncPass(syncs, this.#closing.signal);
		}
	}

	/** The Digital Post syncs of each served company that has one due, in turn: one call asks which. */
	async syncDigitalPost(): Promise<void> {
		if (this.#closed || !this.#digitalPost) return;
		const answer = record(
			await this.#principal.digitalPostSyncsDue(
				AbortSignal.any([this.#closing.signal, AbortSignal.timeout(DEADLINE_MS)]),
			),
			"Shared vault Digital Post syncs",
		);
		if (
			answer.schema !== "qorpera.broker-principal-digital-post-syncs/v1" ||
			!Array.isArray(answer.companyIds) ||
			answer.companyIds.length > 1000
		)
			throw new Error("Shared vault Digital Post syncs are invalid");
		for (const companyId of new Set(answer.companyIds.map(company))) {
			if (this.#closed) return;
			const syncs = this.#served.get(companyId)?.digitalPostSyncs;
			if (syncs) await logDigitalPostSyncPass(syncs, this.#closing.signal);
		}
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		this.#loop(() => this.refresh(AbortSignal.timeout(DEADLINE_MS)), this.#refreshEveryMs, 0);
		this.#loop(() => this.collect(), this.#collectEveryMs, this.#collectEveryMs);
		// A random start, so both copies of the vault and a restart spread their renewals.
		this.#loop(() => this.upkeep(), this.#upkeepEveryMs, 30_000 + Math.floor(Math.random() * this.#upkeepEveryMs));
		this.#loop(
			() => this.revokeTokens(),
			this.#revokeEveryMs,
			15_000 + Math.floor(Math.random() * this.#revokeEveryMs),
		);
		this.#loop(
			() => this.verifyEvents(),
			this.#verifyEveryMs,
			2000 + Math.floor(Math.random() * this.#verifyEveryMs),
		);
		if (this.#bank)
			this.#loop(() => this.syncBanks(), this.#bankEveryMs, 20_000 + Math.floor(Math.random() * this.#bankEveryMs));
		if (this.#digitalPost)
			this.#loop(
				() => this.syncDigitalPost(),
				this.#digitalPostEveryMs,
				20_000 + Math.floor(Math.random() * this.#digitalPostEveryMs),
			);
	}

	#loop(work: () => Promise<void>, everyMs: number, firstMs: number): void {
		const schedule = (delayMs: number): void => {
			const timer = setTimeout(() => {
				this.#timers.delete(timer);
				if (this.#closed) return;
				const running = work()
					.catch(() => {
						console.error("Shared vault: a background pass failed; the next one tries again.");
					})
					.finally(() => {
						this.#running.delete(running);
						if (!this.#closed) schedule(everyMs);
					});
				this.#running.add(running);
			}, delayMs);
			this.#timers.add(timer);
		};
		schedule(firstMs);
	}

	/** Stops every loop; a company's upkeep pass in hand ends after its current renewal (and its save),
	 * which the unit's stop timeout waits for. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#closing.abort();
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		await Promise.all([...[...this.#served.values()].map((served) => served.upkeep.close()), ...this.#running]);
	}
}
