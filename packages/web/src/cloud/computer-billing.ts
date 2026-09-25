import type { Cloud } from "./client.ts";

export interface ComputerPlan {
	planKey: string;
	version: number;
	name: string;
	currency: "DKK";
	monthlyPriceMinor: number;
	advertisedHours: number | null;
	allowanceKind: "hours" | "calendar_month";
	activeForCheckout: boolean;
	tariffVersion: number;
}
export interface ComputerPlanCatalog {
	plans: ComputerPlan[];
	meterMode: string;
}
export interface ComputerUsage {
	meterMode: string;
	checkoutAvailable: boolean;
	portalAvailable: boolean;
	runtimeAccountingReady: boolean;
	subscriptions: { planKey: string; planVersion: number; status: string; periodStart: string; periodEnd: string }[];
	balance: { issuedUs: string; reservedUs: string; debitedUs: string; availableUs: string };
	standardComputer: { cpuMillis: number; memoryBytes: number; tariffVersion: number };
}

export function parseComputerUsage(value: unknown): ComputerUsage {
	const data = object(value),
		balance = object(data.balance),
		computer = object(data.standardComputer);
	if (
		data.schema !== "qorpera.my-computer-usage/v1" ||
		balance.unit !== "standard_computer_microsecond" ||
		typeof data.checkoutAvailable !== "boolean" ||
		typeof data.portalAvailable !== "boolean" ||
		typeof data.runtimeAccountingReady !== "boolean" ||
		!Array.isArray(data.subscriptions) ||
		data.subscriptions.length > 100
	)
		throw new Error("Computer usage is unavailable.");
	const amount = (value: unknown): string => {
		if (typeof value !== "string" || !/^\d{1,40}$/.test(value)) throw new Error("Computer usage amount is invalid.");
		return value;
	};
	return {
		meterMode: text(data.meterMode),
		checkoutAvailable: data.checkoutAvailable,
		portalAvailable: data.portalAvailable,
		runtimeAccountingReady: data.runtimeAccountingReady,
		balance: {
			issuedUs: amount(balance.issuedUs),
			reservedUs: amount(balance.reservedUs),
			debitedUs: amount(balance.debitedUs),
			availableUs: amount(balance.availableUs),
		},
		standardComputer: {
			cpuMillis: integer(computer.cpuMillis, 1),
			memoryBytes: integer(computer.memoryBytes, 1),
			tariffVersion: integer(computer.tariffVersion, 1),
		},
		subscriptions: data.subscriptions.map((item) => {
			const subscription = object(item),
				periodStart = text(subscription.periodStart),
				periodEnd = text(subscription.periodEnd);
			if (
				!Number.isFinite(Date.parse(periodStart)) ||
				!Number.isFinite(Date.parse(periodEnd)) ||
				Date.parse(periodEnd) <= Date.parse(periodStart)
			)
				throw new Error("Computer subscription period is invalid.");
			return {
				planKey: text(subscription.planKey),
				planVersion: integer(subscription.planVersion, 1),
				status: text(subscription.status),
				periodStart,
				periodEnd,
			};
		}),
	};
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Computer plan data is invalid.");
	return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error("Computer plan amount is invalid.");
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 1024)
		throw new Error("Computer plan data is invalid.");
	return value;
}
export function parseComputerPlanCatalog(value: unknown): ComputerPlanCatalog {
	const data = object(value);
	if (data.schema !== "qorpera.computer-plan-catalog/v1" || !Array.isArray(data.plans) || data.plans.length > 100)
		throw new Error("Computer plan catalog is unavailable.");
	const seen = new Set<string>();
	const plans = data.plans.map((item): ComputerPlan => {
		const plan = object(item);
		if (
			plan.currency !== "DKK" ||
			typeof plan.activeForCheckout !== "boolean" ||
			(plan.allowanceKind !== "hours" && plan.allowanceKind !== "calendar_month")
		)
			throw new Error("Computer plan data is invalid.");
		const planKey = text(plan.planKey),
			version = integer(plan.version, 1);
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(planKey) || seen.has(`${planKey}:${version}`))
			throw new Error("Computer plan identity is invalid.");
		seen.add(`${planKey}:${version}`);
		return {
			planKey,
			version,
			name: text(plan.name),
			currency: plan.currency,
			monthlyPriceMinor: integer(plan.monthlyPriceMinor),
			advertisedHours: plan.advertisedHours === null ? null : integer(plan.advertisedHours, 1),
			allowanceKind: plan.allowanceKind,
			activeForCheckout: plan.activeForCheckout,
			tariffVersion: integer(plan.tariffVersion, 1),
		};
	});
	if (plans.some((plan) => (plan.allowanceKind === "hours") !== (plan.advertisedHours !== null)))
		throw new Error("Computer plan allowance is invalid.");
	return { plans, meterMode: text(data.meterMode) };
}

export function stripeRedirect(value: unknown, action: "checkout" | "portal"): string {
	const url = new URL(text(object(value).url));
	if (
		url.protocol !== "https:" ||
		url.hostname !== (action === "checkout" ? "checkout.stripe.com" : "billing.stripe.com") ||
		url.username ||
		url.password ||
		url.port
	)
		throw new Error("Payment destination is invalid.");
	return url.href;
}

interface CheckoutAttempt {
	requestId: string;
	expiresAt?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Member credentials only. An uncertain checkout keeps its durable identity
 * through explicit retries and page reloads; it is never retried automatically. */
export class ComputerBillingClient {
	readonly #cloud: Cloud;
	readonly #memberId: string;
	readonly #signal: AbortSignal;
	readonly #assertCurrent: () => void;
	readonly #fetch: typeof fetch;
	readonly #storage: Pick<Storage, "getItem" | "setItem">;
	constructor(
		cloud: Cloud,
		memberId: string,
		signal: AbortSignal,
		assertCurrent: () => void,
		options: { fetch?: typeof fetch; storage?: Pick<Storage, "getItem" | "setItem"> } = {},
	) {
		this.#cloud = cloud;
		this.#memberId = memberId;
		this.#signal = signal;
		this.#assertCurrent = assertCurrent;
		this.#fetch = options.fetch ?? fetch;
		this.#storage = options.storage ?? {
			getItem: (key) => sessionStorage.getItem(key),
			setItem: (key, value) => sessionStorage.setItem(key, value),
		};
	}
	#assert(): void {
		this.#signal.throwIfAborted();
		this.#assertCurrent();
	}
	async catalog(): Promise<ComputerPlanCatalog> {
		this.#assert();
		const value = await this.#cloud.rpc("qorpera_computer_plan_catalog");
		this.#assert();
		return parseComputerPlanCatalog(value);
	}
	async usage(): Promise<ComputerUsage> {
		this.#assert();
		const value = await this.#cloud.rpc("qorpera_my_computer_usage");
		this.#assert();
		return parseComputerUsage(value);
	}
	async #command(action: "checkout" | "portal", body: Record<string, unknown>): Promise<Record<string, unknown>> {
		this.#assert();
		let { data, error } = await this.#cloud.supabase.auth.getSession();
		this.#assert();
		if (error || !data.session || data.session.user.id !== this.#memberId)
			throw new Error("Sign in to manage your computer plan.");
		if (data.session.expires_at !== undefined && data.session.expires_at * 1000 <= Date.now() + 30000) {
			({ data, error } = await this.#cloud.supabase.auth.refreshSession());
			this.#assert();
		}
		if (error || !data.session || data.session.user.id !== this.#memberId)
			throw new Error("Sign in to manage your computer plan.");
		const response = await this.#fetch(`${this.#cloud.config.projectUrl}/functions/v1/computer-billing/${action}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${data.session.access_token}`,
				apikey: this.#cloud.config.publishableKey,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.any([this.#signal, AbortSignal.timeout(20000)]),
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
		});
		this.#assert();
		if (!response.ok) throw new Error("Computer billing is unavailable. Refresh the plan status before retrying.");
		const value: unknown = await response.json();
		this.#assert();
		return object(value);
	}
	async checkout(offer: ComputerPlan): Promise<string> {
		const current = (await this.catalog()).plans.find(
			(plan) => plan.planKey === offer.planKey && plan.version === offer.version,
		);
		if (
			!current?.activeForCheckout ||
			current.monthlyPriceMinor !== offer.monthlyPriceMinor ||
			current.tariffVersion !== offer.tariffVersion ||
			current.advertisedHours !== offer.advertisedHours ||
			current.allowanceKind !== offer.allowanceKind
		)
			throw new Error("This computer plan is not open for checkout. Refresh the plan status.");
		const key = `qorpera.computer-checkout/v1:${this.#memberId}:${offer.planKey}:${offer.version}`;
		let attempt: CheckoutAttempt | undefined;
		const saved = this.#storage.getItem(key);
		if (saved) {
			const value = object(JSON.parse(saved));
			if (
				typeof value.requestId !== "string" ||
				!UUID.test(value.requestId) ||
				(value.expiresAt !== undefined &&
					(typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))))
			)
				throw new Error("Saved checkout identity is invalid. Contact support before starting another purchase.");
			attempt = {
				requestId: value.requestId,
				...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
			};
		}
		if (!attempt || (attempt.expiresAt && Date.parse(attempt.expiresAt) <= Date.now()))
			attempt = { requestId: crypto.randomUUID() };
		this.#storage.setItem(key, JSON.stringify(attempt));
		const result = await this.#command("checkout", {
			planKey: offer.planKey,
			version: offer.version,
			requestId: attempt.requestId,
		});
		const url = stripeRedirect(result, "checkout");
		if (typeof result.expiresAt === "string" && Number.isFinite(Date.parse(result.expiresAt))) {
			this.#storage.setItem(key, JSON.stringify({ ...attempt, expiresAt: result.expiresAt }));
			if (Date.parse(result.expiresAt) <= Date.now())
				throw new Error("This checkout expired. Refresh and try again.");
		}
		return url;
	}
	async portal(): Promise<string> {
		return stripeRedirect(await this.#command("portal", {}), "portal");
	}
}
