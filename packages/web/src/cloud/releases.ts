import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import {
	array,
	boundedInteger,
	CloudShapeError,
	nonEmptyString,
	oneOf,
	record,
	SHA256_PATTERN,
	timestamp,
	uuid,
} from "./parse.ts";
import { SITE_HOST } from "./sites.ts";

/* A member's calls for What's new (migration 20260930729000_code_releases, own code storage step 4): for each project
 * of the company kept in Qorpera that makes a website, the version that is live, the changes ready to go live, and the
 * two writes, put it live and go back. Every member reads; owners and admins write (the kernel refuses anyone else,
 * 42501). Nothing builds after a yes: the version was made and kept when its change went in. The page sends back what
 * it drew (the live version, the change and a token over every change it showed), and a page that moved meanwhile is
 * answered `moved`, with nothing changed. RPCs listed in supabase/CLIENT-CONTRACT.md §2.
 *
 * From step 5.1 (migration 20260930756000): Look first, `qorpera_open_site_preview`, a one-time link to the ready
 * version on the site's next host (owners and admins, only while sites have addresses of their own: the read says so
 * with `preview`), and a write refused for a site Qorpera took down (`refused`, `SITE_TAKEN_DOWN`). */

/** One change ready to go live that a customer will notice: its one line, and its picture in the company folder. `key`
 * tells the changes apart and is never shown. */
export interface CodeReleaseChange {
	readonly key: number;
	readonly notice: string;
	/** A picture file of the company folder (the change's copy under code/…/changes/, or the folder file it named). */
	readonly picture: string | null;
	readonly at: string;
	/** It went live once before and a Go back took it off again. */
	readonly wasLive: boolean;
}

/** What a yes puts live: every change after the live one up to `change`, with the token over what the page shows. */
export interface CodeReleaseReady {
	readonly change: number;
	readonly token: string;
	/** The agent behind the newest change, who hears Not yet; null for a member's own change. */
	readonly agent: string | null;
	/** The changes a customer will notice, newest first (at most 20). */
	readonly changes: readonly CodeReleaseChange[];
	/** The others: changes behind the scenes. */
	readonly quiet: number;
}

export interface CodeReleaseLive {
	readonly version: number;
	/** release: a member put a ready version live. back: a member put the version before it live again. */
	readonly kind: "release" | "back";
	readonly since: string;
	/** The member who said go (a user id), or null. */
	readonly by: string | null;
}

/** One project's site in What's new. */
export interface CodeReleaseSite {
	readonly owner: string;
	readonly name: string;
	/** The site, made at the first upload: null before. */
	readonly site: { readonly slug: string; readonly url: string; readonly title: string | null } | null;
	readonly live: CodeReleaseLive | null;
	/** The version Go back puts live; null when none is kept. */
	readonly back: { readonly version: number } | null;
	readonly ready: CodeReleaseReady | null;
	/** Changes in the project that are not ready yet. */
	readonly waiting: number;
	/** Why the newest version could not be prepared (the kernel's code), or null. */
	readonly problem: string | null;
	/** No upload will try that change again until a newer one is saved (five failures). A read from before the key reads
	 * as false. */
	readonly givenUp: boolean;
}

export interface CodeReleases {
	/** The member may put a version live and go back: owners and admins. */
	readonly canRelease: boolean;
	/** The member may look at a ready version before it goes live (Look first): owners and admins, while sites have
	 * addresses of their own. A read without the key (hosts off, or a kernel before step 5.1) reads as false. */
	readonly preview: boolean;
	readonly sites: readonly CodeReleaseSite[];
}

/** A write's answer: the version is live, the page moved and nothing changed, or the kernel refused it and nothing
 * changed (`code`: why, such as SITE_TAKEN_DOWN for a site Qorpera took down). */
export type CodeReleaseAnswer =
	| { readonly state: "live"; readonly version: number }
	| { readonly state: "moved" }
	| { readonly state: "refused"; readonly code: string };

/** Look first's answer (`qorpera.site-preview/v1`): `open` with the one-time link to the ready version on the site's next
 * host (used once, at once, and never kept); `moved` when that version is no longer the one ready; `gone` when Qorpera
 * took the site down; `off` while sites have no addresses of their own. */
export type SitePreviewAnswer =
	| { readonly state: "open"; readonly url: string }
	| { readonly state: "moved" | "gone" | "off" };

/** What the page drew, sent with Put it live: the live version (null before the first), the change and the token. */
export interface CodeReleaseShown {
	readonly live: number | null;
	readonly change: number;
	readonly token: string;
}

/** What the page drew, sent with Go back: the live version and the version Go back named. */
export interface CodeReleaseBackShown {
	readonly live: number;
	readonly to: number;
}

export interface CodeReleaseCalls {
	list(signal: AbortSignal): Promise<CodeReleases>;
	putLive(owner: string, name: string, shown: CodeReleaseShown, signal: AbortSignal): Promise<CodeReleaseAnswer>;
	goBack(owner: string, name: string, shown: CodeReleaseBackShown, signal: AbortSignal): Promise<CodeReleaseAnswer>;
	/** Look first: a one-time link to the version of the ready change the page drew, on its site's next host. */
	openPreview(owner: string, name: string, shown: SitePreviewShown, signal: AbortSignal): Promise<SitePreviewAnswer>;
}

/** What the page drew, sent with Look first: the ready change, and the site's name in its link (the link answered must
 * be that site's next host). */
export interface SitePreviewShown {
	readonly change: number;
	readonly slug: string;
}

/** One call's deadline: a few index reads, or a handful of row updates under one lock. */
const CALL_MS = 15_000;
const MAX = Number.MAX_SAFE_INTEGER;

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
	return value === null ? null : parse(value);
}

/** A site's own link: https, nothing but a host and a path. */
function siteUrl(value: unknown): string {
	const text = nonEmptyString(value, "site link", 2048);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new CloudShapeError("site link");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new CloudShapeError("site link");
	return text;
}

/** A path of the company folder: relative, with no empty, `.` or `..` part. */
function folderPath(value: unknown): string {
	const path = nonEmptyString(value, "change picture", 1024);
	if (path.split("/").some((part) => !part || part === "." || part === ".."))
		throw new CloudShapeError("change picture");
	return path;
}

function parseChange(value: unknown): CodeReleaseChange {
	const input = record(value, "ready change");
	if (typeof input.wasLive !== "boolean") throw new CloudShapeError("ready change");
	return {
		key: boundedInteger(input.key, "ready change", 1, MAX),
		notice: nonEmptyString(input.notice, "change notice", 1000),
		picture: nullable(input.picture, folderPath),
		at: timestamp(input.at, "change time"),
		wasLive: input.wasLive,
	};
}

function parseSite(value: unknown): CodeReleaseSite {
	const input = record(value, "release site");
	return {
		owner: nonEmptyString(input.owner, "release owner", 256),
		name: nonEmptyString(input.name, "release name", 256),
		site: nullable(input.site, (site) => {
			const item = record(site, "release site link");
			return {
				slug: nonEmptyString(item.slug, "site name", 64),
				url: siteUrl(item.url),
				title: nullable(item.title, (title) => nonEmptyString(title, "site title", 256)),
			};
		}),
		live: nullable(input.live, (live) => {
			const item = record(live, "live version");
			return {
				version: boundedInteger(item.version, "live version", 1, MAX),
				kind: oneOf(item.kind, ["release", "back"], "live version kind"),
				since: timestamp(item.since, "live since"),
				by: nullable(item.by, (by) => uuid(by, "live by")),
			};
		}),
		back: nullable(input.back, (back) => ({
			version: boundedInteger(record(back, "back version").version, "back version", 1, MAX),
		})),
		ready: nullable(input.ready, (ready) => {
			const item = record(ready, "ready version");
			if (typeof item.token !== "string" || !SHA256_PATTERN.test(item.token))
				throw new CloudShapeError("ready token");
			return {
				change: boundedInteger(item.change, "ready change", 1, MAX),
				token: item.token,
				agent: nullable(item.agent, (agent) => uuid(agent, "ready agent")),
				changes: array(item.changes, "ready changes").map(parseChange),
				quiet: boundedInteger(item.quiet, "ready quiet", 0, MAX),
			};
		}),
		waiting: boundedInteger(input.waiting, "waiting changes", 0, MAX),
		problem: nullable(input.problem, (problem) => nonEmptyString(problem, "site problem", 120)),
		// Lenient: absent (a kernel before the key) or anything but true is not given up.
		givenUp: input.givenUp === true,
	};
}

/** The `qorpera.code-releases/v1` read. A key it does not know is left alone; every value it reads is checked. */
export function parseCodeReleases(value: unknown): CodeReleases {
	const input = record(value, "releases");
	if (input.schema !== "qorpera.code-releases/v1" || typeof input.canRelease !== "boolean")
		throw new CloudShapeError("releases");
	return {
		canRelease: input.canRelease,
		// Lenient: absent while sites have no addresses of their own (and before step 5.1); only true opens Look first.
		preview: input.preview === true,
		sites: array(input.sites, "releases").map(parseSite),
	};
}

/** The `qorpera.code-release/v1` answer of both writes. */
export function parseCodeReleaseAnswer(value: unknown): CodeReleaseAnswer {
	const input = record(value, "release answer");
	if (input.schema !== "qorpera.code-release/v1") throw new CloudShapeError("release answer");
	const state = oneOf(input.state, ["live", "moved", "refused"], "release answer");
	if (state === "refused") return { state, code: nonEmptyString(input.code, "release refusal", 64) };
	return state === "moved" ? { state } : { state, version: boundedInteger(input.version, "release version", 1, MAX) };
}

/** Look first's one-time ticket, as the kernel makes it: 32 random bytes, base64url without padding. */
const TICKET = /^\?t=[A-Za-z0-9_-]{43}$/;

/** The `qorpera.site-preview/v1` answer. An open link must be exactly `https://<slug>--next.qorpera.com/.qorpera/enter?t=`
 * and a ticket, for the site the page drew (by the one host rule SQL, site-serve and the web share): the web never sends
 * a tab anywhere else. Nothing of the link goes into an error. */
export function parseSitePreviewAnswer(value: unknown, slug: string): SitePreviewAnswer {
	const input = record(value, "look first answer");
	if (input.schema !== "qorpera.site-preview/v1") throw new CloudShapeError("look first answer");
	const state = oneOf(input.state, ["open", "moved", "gone", "off"], "look first answer");
	if (state !== "open") return { state };
	const link = typeof input.url === "string" ? input.url : "";
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		throw new CloudShapeError("look first link");
	}
	const host = SITE_HOST.exec(url.hostname);
	// The whole link, written out as it must be: no port, sign-in, other path or fragment (not even an empty one).
	if (
		host?.[1] !== slug ||
		host[2] !== "--next" ||
		!TICKET.test(url.search) ||
		link !== `https://${url.hostname}/.qorpera/enter${url.search}`
	)
		throw new CloudShapeError("look first link");
	return { state, url: link };
}

export function codeReleaseCalls(cloud: Cloud, profileId: string): CodeReleaseCalls {
	const call = (name: string, args: Record<string, unknown>, signal: AbortSignal) =>
		withCloudDeadline(() => cloud.rpc(name, { p_profile_id: profileId, ...args }), CALL_MS, signal);
	return {
		list: async (signal) => parseCodeReleases(await call("qorpera_list_code_releases", {}, signal)),
		putLive: async (owner, name, shown, signal) =>
			parseCodeReleaseAnswer(
				await call(
					"qorpera_put_code_release_live",
					{
						p_owner: owner,
						p_name: name,
						p_shown: { live: shown.live, change: shown.change, token: shown.token },
					},
					signal,
				),
			),
		goBack: async (owner, name, shown, signal) =>
			parseCodeReleaseAnswer(
				await call(
					"qorpera_code_release_back",
					{ p_owner: owner, p_name: name, p_shown: { live: shown.live, to: shown.to } },
					signal,
				),
			),
		openPreview: async (owner, name, shown, signal) =>
			parseSitePreviewAnswer(
				await call("qorpera_open_site_preview", { p_owner: owner, p_name: name, p_change: shown.change }, signal),
				shown.slug,
			),
	};
}
