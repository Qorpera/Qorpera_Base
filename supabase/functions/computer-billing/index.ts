import { handleComputerBilling, type ComputerBillingOptions } from "./computer-billing.ts";

Deno.serve(async (request: Request) => {
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
	if (!supabaseUrl || !serviceKey) return Response.json({ error: "Computer billing is not configured" }, { status: 503 });
	let pricePlans: ComputerBillingOptions["pricePlans"];
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("QORPERA_STRIPE_PRICE_PLANS") ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid price configuration");
		pricePlans = {};
		for (const [key, entry] of Object.entries(parsed)) {
			if (!/^price_[A-Za-z0-9]+$/.test(key) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid price configuration");
			const value = entry as Record<string, unknown>;
			if (typeof value.planKey !== "string" || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version <= 0) throw new Error("Invalid price configuration");
			pricePlans[key] = { planKey: value.planKey, version: value.version };
		}
	} catch {
		return Response.json({ error: "Computer billing configuration is invalid" }, { status: 503 });
	}
	return handleComputerBilling(request, {
		stripeSecretKey: Deno.env.get("QORPERA_STRIPE_SECRET_KEY") ?? "",
		webhookSecret: Deno.env.get("QORPERA_STRIPE_WEBHOOK_SECRET") ?? "",
		returnUrl: Deno.env.get("QORPERA_BILLING_RETURN_URL") ?? "",
		portalConfigurationId: Deno.env.get("QORPERA_STRIPE_PORTAL_CONFIGURATION") ?? "",
		liveMode: Deno.env.get("QORPERA_STRIPE_LIVE_MODE") === "true",
		pricePlans,
		fetch,
		now: Date.now,
		authenticate: async (token) => {
			const response = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
			if (!response.ok) return null;
			const user: unknown = await response.json();
			return user && typeof user === "object" && "id" in user && typeof user.id === "string" ? user.id : null;
		},
		rpc: async (name, args) => {
			const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
				method: "POST", headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, "content-type": "application/json" },
				body: JSON.stringify(args), signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) throw new Error("Billing database unavailable");
			return response.status === 204 ? null : response.json();
		},
	});
});
