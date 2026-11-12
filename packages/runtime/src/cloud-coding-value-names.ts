/* The names and repositories a coding value may have (20260928549440, 20260930693000), as the database decides them
 * (qorpera_coding_environment_name_allowed, and the repository's owner/name in lower case, as GitHub compares them):
 * checked before a member's secret card is sent (ask_member) and before an agent's vault_capture of a coding value
 * reaches the office, so the agent hears why before anything happens. The database checks them again. */

/** A coding value's repository as GitHub compares it: owner/name in lower case (20260930693000). */
export const CODING_VALUE_REPOSITORY = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_][a-z0-9_.-]{0,99}$/;
/** A coding value's name: its environment variable's name in lower case (20260928549440). */
const CODING_VALUE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CODING_VALUE_NAME_REFUSED = /^(lc|git|ld|dyld|qorpera|ssh|xdg|docker|anthropic|claude|codex|openai)_/;
/** The names a coding machine sets itself, as qorpera_coding_environment_name_allowed lists them. */
const CODING_VALUE_NAMES_RESERVED: ReadonlySet<string> = new Set([
	"home",
	"path",
	"tmpdir",
	"tmp",
	"temp",
	"user",
	"logname",
	"shell",
	"pwd",
	"oldpwd",
	"term",
	"colorterm",
	"columns",
	"lines",
	"lang",
	"language",
	"tz",
	"bash_env",
	"env",
	"ifs",
	"ps1",
	"ps2",
	"ps4",
	"prompt_command",
	"shellopts",
	"bashopts",
	"cdpath",
	"globignore",
	"hostname",
	"shlvl",
	"mail",
	"mailpath",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"ftp_proxy",
	"ssl_cert_file",
	"ssl_cert_dir",
	"node_extra_ca_certs",
]);
/** Whether a coding value may have this name: an environment variable's in lower case, never one the coding machine
 * sets itself (HOME, PATH, the proxy and certificate variables, LC_*, GIT_*, …) or that names a provider's login. */
export function codingValueNameAllowed(name: string): boolean {
	return (
		CODING_VALUE_NAME_PATTERN.test(name) &&
		!CODING_VALUE_NAME_REFUSED.test(name) &&
		!CODING_VALUE_NAMES_RESERVED.has(name)
	);
}
