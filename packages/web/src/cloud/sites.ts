import type { Cloud } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

/**
 * Member surface for the company's websites: the password-protected sites the company's agents publish at
 * sites.qorpera.com/<slug>/, and the private app links they share from an always-on machine (an app site, v195:
 * https://<slug>-preview.qorpera.com/, one port of the machine behind the same password). Every member lists them,
 * with their links. Only owners and admins read or change a
 * site's password and take a site offline; the kernel refuses anyone else (42501). RPCs listed in
 * supabase/CLIENT-CONTRACT.md §2, "Company sites".
 */

/** "publishing": a website's first upload has not finished; "off": an app link is not shared, or its machine is gone. */
export type CompanySiteState = "live" | "publishing" | "off";
/** "files": a website of static files (publish_site); "app": one port of a company machine (share_app). */
export type CompanySiteKind = "files" | "app";

export interface CompanySite {
	id: string;
	slug: string;
	/** The title the agent gave the site, or null. */
	title: string | null;
	kind: CompanySiteKind;
	/** The plain link a founder shares: https://sites.qorpera.com/<slug>/, or an app's own host. */
	url: string;
	/** "publishing": the first upload has not finished, so the link does not work yet; "off" (an app link): it is not
	 * shared now, or its machine was deleted. */
	state: CompanySiteState;
	/** The Company File path the site was published from. */
	source: string;
	files: number;
	bytes: number;
	publishedAt: string | null;
	publishedBy: { agentId: string; name: string } | null;
	createdAt: string;
	passwordChangedAt: string;
	/** An app link's machine by name; null for a website, or when the app's machine was deleted. */
	machine: string | null;
	/** The app's port on its machine; null for a website. */
	port: number | null;
}

export interface CompanySitePassword {
	siteId: string;
	password: string;
	changedAt: string;
}

/** A site's name in its link, as the kernel allows it. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
/** A machine's name, as an agent gives one. */
const MACHINE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SITE_KEYS = [
	"schema",
	"id",
	"slug",
	"title",
	"kind",
	"machine",
	"port",
	"url",
	"state",
	"source",
	"files",
	"bytes",
	"publishedAt",
	"publishedBy",
	"createdAt",
	"passwordChangedAt",
].sort();

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	return Object.keys(input).sort().join() === [...keys].sort().join() ? input : undefined;
}

const count = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The site's own link: https, no sign-in, query or fragment, and the site's name as its whole path; an app's, the
 * site's name at the start of its own host, with nothing after it. */
function siteUrl(value: unknown, slug: string, kind: CompanySiteKind): string | undefined {
	if (typeof value !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	return url.protocol === "https:" &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		(kind === "files"
			? url.pathname === `/${slug}/`
			: url.pathname === "/" && url.hostname.startsWith(slug) && /^[-.]/.test(url.hostname.slice(slug.length))) &&
		url.href === value
		? value
		: undefined;
}

/** One `qorpera.company-site/v1` row, exactly as the kernel lists it; anything else is refused. */
export function parseCompanySite(value: unknown): CompanySite {
	const input = closedRecord(value, SITE_KEYS);
	const by = input?.publishedBy === null ? null : closedRecord(input?.publishedBy, ["agentId", "name"]);
	const slug = input && typeof input.slug === "string" && SLUG.test(input.slug) ? input.slug : undefined;
	const kind = input?.kind === "files" || input?.kind === "app" ? (input.kind as CompanySiteKind) : undefined;
	const url = slug && kind ? siteUrl(input?.url, slug, kind) : undefined;
	if (
		!input ||
		input.schema !== "qorpera.company-site/v1" ||
		typeof input.id !== "string" ||
		!UUID_PATTERN.test(input.id) ||
		!slug ||
		!url ||
		(input.title !== null && (typeof input.title !== "string" || !input.title.trim())) ||
		(input.state !== "live" && input.state !== (kind === "app" ? "off" : "publishing")) ||
		typeof input.source !== "string" ||
		!count(input.files) ||
		!count(input.bytes) ||
		(input.publishedAt !== null && typeof input.publishedAt !== "string") ||
		by === undefined ||
		(by !== null &&
			(typeof by.agentId !== "string" || !UUID_PATTERN.test(by.agentId) || typeof by.name !== "string")) ||
		typeof input.createdAt !== "string" ||
		typeof input.passwordChangedAt !== "string" ||
		// A website names no machine or port; an app link names its port, and its machine unless it was deleted.
		(kind === "files"
			? input.machine !== null || input.port !== null
			: (input.machine !== null && (typeof input.machine !== "string" || !MACHINE.test(input.machine))) ||
				typeof input.port !== "number" ||
				!Number.isSafeInteger(input.port) ||
				input.port < 1 ||
				input.port > 65535)
	)
		throw new Error("Invalid site.");
	return {
		id: input.id,
		slug,
		title: input.title as string | null,
		kind: kind as CompanySiteKind,
		url,
		state: input.state as CompanySiteState,
		source: input.source as string,
		files: input.files as number,
		bytes: input.bytes as number,
		publishedAt: input.publishedAt as string | null,
		publishedBy: by === null ? null : { agentId: by.agentId as string, name: by.name as string },
		createdAt: input.createdAt as string,
		passwordChangedAt: input.passwordChangedAt as string,
		machine: input.machine as string | null,
		port: input.port as number | null,
	};
}

/** A site's password as the kernel gives it to an owner or admin. */
export function parseCompanySitePassword(value: unknown, siteId: string): CompanySitePassword {
	const input = closedRecord(value, ["schema", "siteId", "password", "changedAt"]);
	if (
		!input ||
		input.schema !== "qorpera.company-site-password/v1" ||
		input.siteId !== siteId ||
		typeof input.password !== "string" ||
		!input.password ||
		typeof input.changedAt !== "string"
	)
		throw new Error("Invalid site password.");
	return { siteId, password: input.password as string, changedAt: input.changedAt as string };
}

export interface WebSites {
	/** The company's sites, newest published first. */
	list(signal?: AbortSignal): Promise<CompanySite[]>;
	/** An owner's or admin's read of a site's password. */
	password(siteId: string, signal?: AbortSignal): Promise<CompanySitePassword>;
	/** Sets a site's password (null: a new random one). Every visitor then enters the new one. */
	setPassword(siteId: string, password: string | null, signal?: AbortSignal): Promise<CompanySitePassword>;
	/** Takes a site offline: its link, files, password and visitors' sessions go. False when it was already gone. */
	unpublish(siteId: string, signal?: AbortSignal): Promise<boolean>;
}

export function createWebSites(cloud: Cloud, company: { profileId: string }): WebSites {
	if (!UUID_PATTERN.test(company.profileId)) throw new Error("Invalid company for sites.");
	const site = (siteId: string) => {
		if (!UUID_PATTERN.test(siteId)) throw new Error("Invalid site.");
		return siteId;
	};
	return {
		async list(signal) {
			signal?.throwIfAborted();
			const value = await cloud.rpc("qorpera_list_company_sites", { p_profile_id: company.profileId });
			if (!Array.isArray(value)) throw new Error("Invalid sites.");
			return value.map(parseCompanySite);
		},
		async password(siteId, signal) {
			signal?.throwIfAborted();
			const id = site(siteId);
			return parseCompanySitePassword(await cloud.rpc("qorpera_company_site_password", { p_site_id: id }), id);
		},
		async setPassword(siteId, password, signal) {
			signal?.throwIfAborted();
			const id = site(siteId);
			if (password !== null && typeof password !== "string") throw new Error("Invalid site password.");
			return parseCompanySitePassword(
				await cloud.rpc("qorpera_set_company_site_password", { p_site_id: id, p_password: password }),
				id,
			);
		},
		async unpublish(siteId, signal) {
			signal?.throwIfAborted();
			const id = site(siteId);
			const input = closedRecord(await cloud.rpc("qorpera_unpublish_company_site", { p_site_id: id }), [
				"schema",
				"siteId",
				"removed",
			]);
			if (
				!input ||
				input.schema !== "qorpera.company-site-unpublish/v1" ||
				input.siteId !== id ||
				typeof input.removed !== "boolean"
			)
				throw new Error("Invalid site.");
			return input.removed as boolean;
		},
	};
}
