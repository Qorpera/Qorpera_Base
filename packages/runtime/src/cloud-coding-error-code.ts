/** A loggable code for a coding-session error. Only fixed identifiers pass:
 * `CODE` or `CODE:REASON`, the fixed LXD client messages with an optional HTTP
 * status, abort/timeout by name, and a Node system error's errno code. Anything
 * else (free text that could carry a path, repository content or a credential)
 * becomes UNCLASSIFIED. Used by the executor's log and the guest's refusal line. */
export function codingErrorCode(error: unknown): string {
	const fixed = fixedCode(error);
	if (fixed) return fixed;
	if (!error || typeof error !== "object") return "UNCLASSIFIED";
	const { name, code, cause } = error as { name?: unknown; code?: unknown; cause?: unknown };
	// An abort carries its coded reason as the cause (timers, fetch wrappers).
	if (name === "AbortError" || name === "TimeoutError") return fixedCode(cause) ?? name;
	if (typeof code === "string" && /^E[A-Z0-9]{1,30}$/.test(code)) return `ERRNO:${code}`;
	return "UNCLASSIFIED";
}
function fixedCode(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : "";
	if (/^[A-Z][A-Z0-9_]{2,80}(:[A-Z][A-Z0-9_]{0,63})?$/.test(message)) return message;
	if (/^LXD [A-Za-z ]{1,60}( \(\d{3}\))?$/.test(message)) return message;
	return undefined;
}
