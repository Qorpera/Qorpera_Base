import { CodeHostJobFailure, CodeHostRefusal } from "./code-host-jobs.ts";

// What the coding executor's log keeps of an error beyond its fixed code (C8 C4-1, 26 Oct 2026: a code host job failed
// while it made a session's worktree, and the log said only UNCLASSIFIED). A code host's error reads `CODE: detail`, git's
// own message or the paths its rule names, which no fixed code matches; its code is its own, and its detail is kept,
// made safe for a log first.

/** At most this many characters of an error's detail reach a log: its start and its end, which for git is its last word. */
const MAX_DETAIL = 500;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}(:[A-Z][A-Z0-9_]{0,63})?$/;

/** The code host's own code for one of its errors (a job's failed step, a refusal by rule), or undefined. */
export function codeHostErrorCode(error: unknown): string | undefined {
	return (error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal) && FIXED.test(error.code)
		? error.code
		: undefined;
}

/** `text` with what could carry a credential taken out: a URL's user and password, an Authorization header's value, a
 * basic or bearer credential, a GitHub token, a `token=`, `password=`, `secret=` or `key=` value, and any run of 32 or
 * more letters, digits, `-` and `_` that mixes upper and lower case and digits (a hex digest or a name in lower case
 * stays). Paths stay. */
export function redactCodingErrorText(text: string): string {
	return text
		.replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:(?:basic|bearer|token)\s+)?[^\s,;]+/gi, "$1$2[redacted]")
		.replace(/\b(basic|bearer)\s+[A-Za-z0-9+/._~=-]{8,}/gi, "$1 [redacted]")
		.replace(/\bx-access-token:[^\s@]+/gi, "x-access-token:[redacted]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "[redacted]")
		.replace(/\b([a-z_]*(?:token|password|passwd|secret|key))=[^\s&;,]+/gi, "$1=[redacted]")
		.replace(/[A-Za-z0-9_-]{32,}/g, (run) =>
			/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) ? "[redacted]" : run,
		);
}

/** What an error says beyond its fixed code, for an operator's log: a code host error's own detail (git's message, the
 * paths its rule names), else its message, or when that is a bare code its causes' (at most three deep). Made one line
 * and redacted (redactCodingErrorText), then cut to its first and last characters, MAX_DETAIL in all. Empty when it
 * says nothing beyond its code. */
export function codingErrorDetail(error: unknown): string {
	let said = "";
	for (let current = error, depth = 0; depth < 4 && !said; depth++) {
		if (typeof current === "string") said = current;
		else if (!(current instanceof Error)) break;
		else if (current instanceof CodeHostJobFailure) said = current.detail;
		else if (current instanceof CodeHostRefusal)
			said = current.message.startsWith(`${current.code}: `) ? current.message.slice(current.code.length + 2) : "";
		else if (!FIXED.test(current.message)) said = current.message;
		current = current instanceof Error ? current.cause : undefined;
	}
	const line = redactCodingErrorText(said.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " "))
		.replace(/ {2,}/g, " ")
		.trim();
	const characters = [...line];
	if (characters.length <= MAX_DETAIL) return line;
	const half = (MAX_DETAIL - 5) / 2;
	return `${characters.slice(0, Math.floor(half)).join("")} ... ${characters.slice(-Math.ceil(half)).join("")}`;
}
