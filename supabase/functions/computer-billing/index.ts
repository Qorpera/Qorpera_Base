import { preferredServiceKey, sha256Hex } from "../_shared/http-guards.ts";
import { createPostgrestClient } from "../_shared/postgrest-rpc.ts";
import {
	type BillingStore,
	BillingStoreError,
	createStripeApi,
	handleComputerBilling,
	type MemberAuth,
} from "./computer-billing.ts";

function required(name: string): string {
	const value = Deno.env.get(name)?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

function serviceKey(): string {
	const key = preferredServiceKey((name) => Deno.env.get(name));
	if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
	return key;
}

function allowedOrigins(): string[] {
	const value: unknown = JSON.parse(Deno.env.get("QORPERA_WEB_ORIGINS") ?? "[]");
	if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must list up to eight origins");
	return value as string[];
}

const stripeKey = required("QORPERA_STRIPE_SECRET_KEY");
const billingKey = required("QORPERA_COMPUTER_BILLING_KEY");
const returnUrl = required("QORPERA_BILLING_RETURN_URL");
if (!new URL(returnUrl).protocol.startsWith("https")) throw new Error("QORPERA_BILLING_RETURN_URL must use HTTPS");
const supabase = createPostgrestClient(required("SUPABASE_URL"), serviceKey(), { timeoutMs: 15_000 });

const store: BillingStore = {
	async call(method, args) {
		const { data, error } = await supabase.rpc("qorpera_computer_billing", {
			p_key: billingKey,
			p_method: method,
			p_args: args,
		});
		if (error) throw new BillingStoreError(error.code ?? undefined, error.message);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new BillingStoreError(undefined, `Billing ${method} answered without an object`);
		return data as Record<string, unknown>;
	},
};

const goodWill: BillingStore = {
	async call(method, args) {
		const { data, error } = await supabase.rpc("qorpera_good_will_billing", {
			p_key: billingKey,
			p_method: method,
			p_args: args,
		});
		if (error) throw new BillingStoreError(error.code ?? undefined, error.message);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new BillingStoreError(undefined, `Good will ${method} answered without an object`);
		return data as Record<string, unknown>;
	},
};

const MEMBER_AUTH_CACHE_TTL_MS = 5_000;
const MEMBER_AUTH_CACHE_MAX = 256;
const memberAuthCache = new Map<string, { readonly id: string; readonly email: string; readonly expiresAt: number }>();

function jwtExpiryMs(token: string): number | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

const auth: MemberAuth = {
	async member(token) {
		const now = Date.now();
		const key = await sha256Hex(token);
		const cached = memberAuthCache.get(key);
		if (cached) {
			if (cached.expiresAt > now) return { id: cached.id, email: cached.email };
			memberAuthCache.delete(key);
		}
		const { data, error } = await supabase.auth.getUser(token);
		if (error || !data.user?.id || !data.user.email) return null;
		const expMs = jwtExpiryMs(token);
		const expiresAt = expMs === null ? now + MEMBER_AUTH_CACHE_TTL_MS : Math.min(now + MEMBER_AUTH_CACHE_TTL_MS, expMs);
		if (expiresAt > now) {
			if (memberAuthCache.size >= MEMBER_AUTH_CACHE_MAX) {
				const oldest = memberAuthCache.keys().next().value;
				if (oldest !== undefined) memberAuthCache.delete(oldest);
			}
			memberAuthCache.set(key, { id: data.user.id, email: data.user.email, expiresAt });
		}
		return { id: data.user.id, email: data.user.email };
	},
};

const options = {
	// A live key bills for real; any other key is Stripe's test mode and only makes dry-run hours.
	livemode: /^(sk|rk)_live_/.test(stripeKey),
	webhookSecret: required("QORPERA_STRIPE_WEBHOOK_SECRET"),
	returnUrl,
	portalConfiguration: Deno.env.get("QORPERA_STRIPE_PORTAL_CONFIGURATION")?.trim() || undefined,
	allowedOrigins: allowedOrigins(),
	billingKey,
};
const stripe = createStripeApi(stripeKey);

Deno.serve((request) => handleComputerBilling(request, { store, goodWill, stripe, auth, options }));
