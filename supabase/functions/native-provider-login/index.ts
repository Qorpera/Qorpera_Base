import { forwardNativeProviderLogin } from "./native-provider-login.ts";

Deno.serve((request) => forwardNativeProviderLogin(request, {
 upstreamUrl: Deno.env.get("QORPERA_NATIVE_PROVIDER_UPSTREAM_URL"),
}));
