import { timeZonePreference } from "../ui/preferences.ts";

/* A company's time zone comes from a member's browser, once (migration 20260930739000; Jonas, 12 Nov 2026: "Yes, from
 * the browser"). The cloud keeps one IANA zone name per company, and an agent's desktop computer shows its clock in
 * it. There is no setting to fill in: when a company opens whose zone the cloud does not know, the app of a member who
 * may act for it hands in the zone it shows times in. Nothing shows in the app. */

/** A zone name as the cloud takes it, and a machine after it: letters, digits, `_`, `+` and `-`, in at most three
 * parts with a `/` between, 64 characters at most (qorpera_ensure_company_time_zone). */
const ZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/** The zone this member's app shows times in: the choice saved in this browser (Account, Time zone), else the
 * device's as the browser reports it. Nothing when the browser reports none, or a word that is no zone's name: a
 * company's zone is taken once, so never a stand-in for it. */
export function memberTimeZone(): string | undefined {
	let zone: unknown = timeZonePreference();
	if (zone === "system") {
		try {
			zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		} catch {
			return undefined;
		}
	}
	return typeof zone === "string" && zone.length <= 64 && ZONE.test(zone) ? zone : undefined;
}

/** A zone the cloud refused for a company is remembered in this browser, so a later load does not hand the same word
 * in again (the cloud's own names decide: a browser may know a zone the database does not). */
const refusedKey = (profileId: string) => `qorpera.web.company-time-zone-refused.${profileId}`;

export function timeZoneRefused(profileId: string, zone: string): boolean {
	try {
		return localStorage.getItem(refusedKey(profileId)) === zone;
	} catch {
		return false;
	}
}

export function rememberTimeZoneRefused(profileId: string, zone: string): void {
	try {
		localStorage.setItem(refusedKey(profileId), zone);
	} catch {
		// A browser that keeps nothing asks again at its next load, once.
	}
}
