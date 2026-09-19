function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function email(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(trimmed)
		? trimmed
		: undefined;
}

/** Display metadata only: claims never grant authority; only the email is projected.
 * This is called only after the official CLI confirms a successful login. */
export function nativeProviderAccountEmail(harness: "codex-cli" | "claude-code", metadata: string): string | undefined {
	try {
		const value = object(JSON.parse(metadata));
		if (harness === "claude-code") return email(value?.email);
		const tokens = object(value?.tokens);
		for (const token of [tokens?.id_token, tokens?.access_token]) {
			if (typeof token !== "string" || token.length > 64 * 1024) continue;
			const parts = token.split(".");
			if (parts.length !== 3 || !parts[1]) continue;
			try {
				const claims = object(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")));
				const accountEmail =
					email(claims?.email) ?? email(object(claims?.["https://api.openai.com/profile"])?.email);
				if (accountEmail) return accountEmail;
			} catch {
				// Missing or malformed display claims must not prevent login.
			}
		}
	} catch {
		// Never project raw CLI output or credential contents into account metadata.
	}
	return undefined;
}
