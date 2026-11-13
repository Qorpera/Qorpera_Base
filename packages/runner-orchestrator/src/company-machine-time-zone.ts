/** Where a machine names its company's time zone: one word, root's file, which the machine's desktop reads at
 * `desktop start` (deploy/machine/desktop) for its clock and its backdrop by the hour. A machine without it, or with a
 * word that names no zone its image knows, shows UTC. The machine's own time zone stays UTC either way. */
export const COMPANY_MACHINE_DESKTOP_TIME_ZONE = "/etc/qorpera-machine/desktop-timezone";

/** An IANA zone name as the machine takes it: letters, digits, `_`, `+` and `-`, in at most three parts with a `/`
 * between, 64 characters at most. The machine uses the word as part of a path under /usr/share/zoneinfo, so nothing
 * else ever leaves here: no dot, no space, no line end. SQL holds the company's zone to the same shape
 * (qorpera_profiles_time_zone_shape, 20260930739000; a test holds the two together), and the machine checks the word
 * again before it reads the file. */
export const COMPANY_MACHINE_TIME_ZONE_PATTERN = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
export const COMPANY_MACHINE_TIME_ZONE_MAX_LENGTH = 64;

/**
 * The company's time zone as it is written into a machine, from what SQL lists with each placement
 * (qorpera_list_executor_machines' `timeZone`, 20260930739000): the name SQL took from a member's browser, exactly as
 * it is, when it has the shape above. SQL took it only as a name of pg_timezone_names; it came from a browser all the
 * same, so its shape is checked here again and nothing of it is trusted.
 *
 * Nothing (undefined) for a company whose zone is not known yet (null), an SQL from before the migration (no key), or
 * an answer that is not a zone's name. Nothing is written then, and the desktop's clock stays as it is.
 */
export function companyMachineDesktopTimeZone(timeZone: unknown): string | undefined {
	return typeof timeZone === "string" &&
		timeZone.length <= COMPANY_MACHINE_TIME_ZONE_MAX_LENGTH &&
		COMPANY_MACHINE_TIME_ZONE_PATTERN.test(timeZone)
		? timeZone
		: undefined;
}
