import { forwardMemberCompanyGateway } from "./member-company-gateway.ts";

function allowedOrigins(): readonly string[] | undefined {
	const raw = Deno.env.get("QORPERA_WEB_ORIGINS");
	if (!raw) return undefined;
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must contain one to eight origins");
	return value as string[];
}

Deno.serve((request) =>
	forwardMemberCompanyGateway(request, {
		upstreamUrl: Deno.env.get("QORPERA_MEMBER_GATEWAY_UPSTREAM_URL"),
		allowedOrigins: allowedOrigins(),
	}),
);
