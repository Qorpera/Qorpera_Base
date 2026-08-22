import { forwardNativeProviderLogin } from "./native-provider-login.ts";

Deno.serve((request) => {
	const upstreamUrl = Deno.env.get("QORPERA_NATIVE_PROVIDER_UPSTREAM_URL");
	if (!upstreamUrl) {
		return Response.json(
			{ error: "Native provider login is not configured" },
			{ status: 503, headers: { "cache-control": "no-store" } },
		);
	}
	return forwardNativeProviderLogin(request, { upstreamUrl });
});
