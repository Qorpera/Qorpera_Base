import { randomUUID } from "node:crypto";

const INFERENCE_PATHS = [
	/\/v1\/messages$/,
	/\/v1\/responses$/,
	/\/codex\/responses$/,
	/\/v1\/chat\/completions$/,
	/\/(?:v1|v1beta)\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/,
];

function codexPlaceholder(handle: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: handle },
	})}.${Buffer.from(handle).toString("base64url")}`;
}

export function brokerCredentialProjection(
	sourceCredentials: Record<string, unknown>,
	ambientProviders: string[],
	allowedProviders: ReadonlySet<string>,
): { credentials: Record<string, unknown>; handles: Map<string, string> } {
	const credentials: Record<string, unknown> = {};
	const handles = new Map<string, string>();
	for (const provider of new Set([...Object.keys(sourceCredentials), ...ambientProviders])) {
		if (!allowedProviders.has(provider)) continue;
		const source = sourceCredentials[provider];
		const sourceType = source && typeof source === "object" ? (source as { type?: unknown }).type : undefined;
		if (sourceType !== "api_key" && sourceType !== "oauth" && !ambientProviders.includes(provider)) continue;
		const handleId = `qorpera-model-${randomUUID()}`;
		const handle = provider === "openai-codex" ? codexPlaceholder(handleId) : handleId;
		handles.set(handle, provider);
		credentials[provider] =
			sourceType === "oauth"
				? {
						type: "oauth",
						access: handle,
						refresh: `disabled-${handleId}`,
						expires: Date.now() + 24 * 60 * 60 * 1000,
					}
				: { type: "api_key", key: handle };
	}
	return { credentials, handles };
}

export function isScopedInferenceTarget(
	baseUrls: readonly string[],
	target: URL,
	allowedDomains: ReadonlySet<string>,
): boolean {
	if (target.protocol !== "https:" || (target.port && target.port !== "443")) return false;
	if (!allowedDomains.has(target.hostname.toLowerCase().replace(/\.$/, ""))) return false;
	if (!INFERENCE_PATHS.some((pattern) => pattern.test(target.pathname))) return false;
	return baseUrls.some((base) => {
		try {
			const parsed = new URL(base);
			const path = parsed.pathname.replace(/\/$/, "");
			return (
				parsed.origin === target.origin &&
				(path === "" || target.pathname.startsWith(`${path}/`) || target.pathname === path)
			);
		} catch {
			return false;
		}
	});
}
