import type { Cloud } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

/**
 * Member surface for the company's websites: the password-protected sites the company's agents publish at
 * sites.qorpera.com/<slug>/. Every member lists them, with their links. Only owners and admins read or change a
 * site's password and take a site offline; the kernel refuses anyone else (42501). RPCs listed in
 * supabase/CLIENT-CONTRACT.md §2, "Company sites".
 */

export type CompanySiteState = "live" | "publishing";

export interface CompanySite {
	id: string;
	slug: string;
	/** The title the agent gave the site, or null. */
	title: string | null;
	/** The plain link a founder shares: https://sites.qorpera.com/<slug>/. */
	url: string;
	/** "publishing": the first upload has not finished, so the link does not work yet. */
	state: CompanySiteState;
	/** The Company File path the site was published from. */
	source: string;
	files: number;
	bytes: number;
	publishedAt: string | null;
	publishedBy: { agentId: string; name: string } | null;
	createdAt: string;
	passwordChangedAt: string;
}

export interface CompanySitePassword {
	siteId: string;
	password: string;
	changedAt: string;
}

/** A site's name in its link, as the kernel allows it. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const SITE_KEYS = [
	"schema",
	"id",
	"slug",
	"title",
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

/** The site's own link: https, no sign-in, query or fragment, and the site's name as its whole path. */
function siteUrl(value: unknown, slug: string): string | undefined {
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
		url.pathname === `/${slug}/` &&
		url.href === value
		? value
		: undefined;
}

/** One `qorpera.company-site/v1` row, exactly as the kernel lists it; anything else is refused. */
export function parseCompanySite(value: unknown): CompanySite {
	const input = closedRecord(value, SITE_KEYS);
	const by = input?.publishedBy === null ? null : closedRecord(input?.publishedBy, ["agentId", "name"]);
	const slug = input && typeof input.slug === "string" && SLUG.test(input.slug) ? input.slug : undefined;
	const url = slug ? siteUrl(input?.url, slug) : undefined;
	if (
		!input ||
		input.schema !== "qorpera.company-site/v1" ||
		typeof input.id !== "string" ||
		!UUID_PATTERN.test(input.id) ||
		!slug ||
		!url ||
		(input.title !== null && (typeof input.title !== "string" || !input.title.trim())) ||
		(input.state !== "live" && input.state !== "publishing") ||
		typeof input.source !== "string" ||
		!count(input.files) ||
		!count(input.bytes) ||
		(input.publishedAt !== null && typeof input.publishedAt !== "string") ||
		by === undefined ||
		(by !== null &&
			(typeof by.agentId !== "string" || !UUID_PATTERN.test(by.agentId) || typeof by.name !== "string")) ||
		typeof input.createdAt !== "string" ||
		typeof input.passwordChangedAt !== "string"
	)
		throw new Error("Invalid site.");
	return {
		id: input.id,
		slug,
		title: input.title as string | null,
		url,
		state: input.state as CompanySiteState,
		source: input.source as string,
		files: input.files as number,
		bytes: input.bytes as number,
		publishedAt: input.publishedAt as string | null,
		publishedBy: by === null ? null : { agentId: by.agentId as string, name: by.name as string },
		createdAt: input.createdAt as string,
		passwordChangedAt: input.passwordChangedAt as string,
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
