import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { CODE_SITE_RESERVED_NAMES } from "@qorpera/contracts";
import type { Cloud } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

export const NATIVE_SITE_HOST = /^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.(?:com|site)$/;

export type SiteDeploymentKind = "static" | "server" | "hybrid";
export type SiteStorageMode = "db" | "blob";
export type CustomDomainStatus = "pending_dns" | "dns_verified" | "tls_active" | "moved" | "failed";

export interface SiteCustomDomain {
	readonly id: string;
	readonly hostname: string;
	readonly isApex: boolean;
	readonly isPrimary: boolean;
	readonly status: CustomDomainStatus;
	readonly verificationToken: string;
	readonly lastCheckedAt: string | null;
	readonly verifiedAt: string | null;
	readonly tlsActiveAt: string | null;
	readonly lastError: string | null;
}

export interface SiteHostingEntry {
	readonly siteId: string;
	readonly slug: string;
	readonly isPublic: boolean;
	readonly deploymentKind: SiteDeploymentKind;
	readonly storageMode: SiteStorageMode;
	readonly liveDeploymentId: string | null;
	readonly domains: readonly SiteCustomDomain[];
}

export interface CompanySiteHostingState {
	readonly hostsDomain: string | null;
	readonly hostsEnabled: boolean;
	readonly publicEnabled: boolean;
	readonly domainsEnabled: boolean;
	readonly edgeIpv4: string | null;
	readonly edgeIpv6: string | null;
	readonly edgeCnameTarget: string | null;
	readonly sites: ReadonlyMap<string, SiteHostingEntry>;
}

export interface AddedSiteDomain {
	readonly id: string;
	readonly siteId: string;
	readonly hostname: string;
	readonly isApex: boolean;
	readonly isPrimary: boolean;
	readonly status: CustomDomainStatus;
	readonly verificationToken: string;
	readonly dns: SiteDnsSetup;
}

export interface SiteDnsSetup {
	readonly recordType: "A" | "CNAME";
	readonly ipv4: string | null;
	readonly ipv6: string | null;
	readonly cnameTarget: string | null;
	readonly txtHost: string;
	readonly txtValue: string;
}

export interface SiteDnsRecord {
	readonly type: "A" | "AAAA" | "CNAME" | "TXT";
	readonly host: string;
	readonly value: string;
}

export type SiteSlugAvailabilityReason = "available" | "current" | "taken" | "reserved" | "invalid";
export type SiteSlugValidationProblem = "too_short" | "invalid" | "reserved";

export interface SiteSlugAvailability {
	readonly siteId: string;
	readonly slug: string;
	readonly available: boolean;
	readonly reason: SiteSlugAvailabilityReason;
}

export interface UpdatedSiteSlug {
	readonly siteId: string;
	readonly slug: string;
	readonly url: string;
}

export interface WebSiteHosting {
	read(signal?: AbortSignal): Promise<CompanySiteHostingState>;
	setPublic(siteId: string, isPublic: boolean, signal?: AbortSignal): Promise<boolean>;
	checkSlug(siteId: string, slug: string, signal?: AbortSignal): Promise<SiteSlugAvailability>;
	setSlug(siteId: string, slug: string, signal?: AbortSignal): Promise<UpdatedSiteSlug>;
	addDomain(siteId: string, hostname: string, isApex: boolean, signal?: AbortSignal): Promise<AddedSiteDomain>;
	removeDomain(domainId: string, signal?: AbortSignal): Promise<boolean>;
	setPrimaryDomain(domainId: string, signal?: AbortSignal): Promise<string>;
	recheckDomain(domainId: string, signal?: AbortSignal): Promise<CustomDomainStatus>;
}

const HOSTING_TIMEOUT_MS = 10_000;
const DOMAIN_STATUSES = new Set<CustomDomainStatus>(["pending_dns", "dns_verified", "tls_active", "moved", "failed"]);
const SLUG_AVAILABILITY_REASONS = new Set<SiteSlugAvailabilityReason>([
	"available",
	"current",
	"taken",
	"reserved",
	"invalid",
]);
const DEPLOYMENT_KINDS = new Set<SiteDeploymentKind>(["static", "server", "hybrid"]);
const STORAGE_MODES = new Set<SiteStorageMode>(["db", "blob"]);
const FQDN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SITE_SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const SITE_SLUG_RESERVED = new Set(CODE_SITE_RESERVED_NAMES.split(" "));

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function parseCustomDomain(value: unknown): SiteCustomDomain | undefined {
	const item = asRecord(value);
	if (
		!item ||
		typeof item.id !== "string" ||
		!UUID_PATTERN.test(item.id) ||
		typeof item.hostname !== "string" ||
		typeof item.isApex !== "boolean" ||
		typeof item.isPrimary !== "boolean" ||
		typeof item.status !== "string" ||
		!DOMAIN_STATUSES.has(item.status as CustomDomainStatus) ||
		typeof item.verificationToken !== "string"
	) {
		return undefined;
	}
	return {
		id: item.id,
		hostname: item.hostname,
		isApex: item.isApex,
		isPrimary: item.isPrimary,
		status: item.status as CustomDomainStatus,
		verificationToken: item.verificationToken,
		lastCheckedAt: nullableString(item.lastCheckedAt),
		verifiedAt: nullableString(item.verifiedAt),
		tlsActiveAt: nullableString(item.tlsActiveAt),
		lastError: nullableString(item.lastError),
	};
}

export function siteDnsRecords(hostname: string, dns: SiteDnsSetup): SiteDnsRecord[] {
	const records: SiteDnsRecord[] = [];
	if (dns.recordType === "A" && dns.ipv4) {
		records.push({ type: "A", host: "@", value: dns.ipv4 });
		if (dns.ipv6) records.push({ type: "AAAA", host: "@", value: dns.ipv6 });
	} else if (dns.cnameTarget) {
		records.push({ type: "CNAME", host: hostname, value: dns.cnameTarget });
	}
	records.push({ type: "TXT", host: dns.txtHost, value: dns.txtValue });
	return records;
}

export function domainDnsSetup(state: CompanySiteHostingState, domain: SiteCustomDomain): SiteDnsSetup {
	return {
		recordType: domain.isApex ? "A" : "CNAME",
		ipv4: state.edgeIpv4,
		ipv6: state.edgeIpv6,
		cnameTarget: state.edgeCnameTarget,
		txtHost: `_qorpera.${domain.hostname}`,
		txtValue: `qorpera-verify=${domain.verificationToken}`,
	};
}

export function isApexHostname(hostname: string): boolean {
	const cleaned = hostname.trim().toLowerCase().replace(/\.$/, "");
	return cleaned.split(".").length === 2;
}

export function cleanSiteSlugInput(slug: string): string {
	return slug.trim().toLowerCase();
}

export function validateSiteSlugInput(slug: string): SiteSlugValidationProblem | undefined {
	const cleaned = cleanSiteSlugInput(slug);
	if (/[^a-z0-9-]/.test(cleaned) || cleaned.includes("--") || cleaned.startsWith("-") || cleaned.endsWith("-")) {
		return "invalid";
	}
	if (cleaned.length < 3) return "too_short";
	if (cleaned.length > 48 || !SITE_SLUG_SHAPE.test(cleaned)) return "invalid";
	if (cleaned.endsWith("-preview") || cleaned.includes("qorpera") || SITE_SLUG_RESERVED.has(cleaned)) {
		return "reserved";
	}
	return undefined;
}

export function validateCustomDomainInput(hostname: string): string | undefined {
	const cleaned = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (cleaned.length < 4 || cleaned.length > 253 || !FQDN_PATTERN.test(cleaned)) {
		return "Enter a valid domain name such as example.dk or www.example.dk.";
	}
	if (/^[0-9.]+$/.test(cleaned)) {
		return "IP addresses cannot be added as custom domains.";
	}
	if (/(?:^|\.)qorpera\.(?:com|site)$/.test(cleaned)) {
		return "Platform domains cannot be added as custom domains.";
	}
	return undefined;
}

export function parseCompanySiteHostingState(value: unknown): CompanySiteHostingState {
	const input = asRecord(value);
	if (input?.schema !== "qorpera.company-site-hosting/v1" || !Array.isArray(input.sites)) {
		throw new Error("Invalid site hosting state.");
	}
	const sites = new Map<string, SiteHostingEntry>();
	for (const rawEntry of input.sites) {
		const entry = asRecord(rawEntry);
		if (
			!entry ||
			typeof entry.siteId !== "string" ||
			!UUID_PATTERN.test(entry.siteId) ||
			typeof entry.slug !== "string" ||
			typeof entry.isPublic !== "boolean" ||
			typeof entry.deploymentKind !== "string" ||
			!DEPLOYMENT_KINDS.has(entry.deploymentKind as SiteDeploymentKind) ||
			typeof entry.storageMode !== "string" ||
			!STORAGE_MODES.has(entry.storageMode as SiteStorageMode)
		) {
			continue;
		}
		const domains: SiteCustomDomain[] = [];
		if (Array.isArray(entry.domains)) {
			for (const rawDomain of entry.domains) {
				const parsed = parseCustomDomain(rawDomain);
				if (parsed) domains.push(parsed);
			}
		}
		sites.set(entry.siteId, {
			siteId: entry.siteId,
			slug: entry.slug,
			isPublic: entry.isPublic,
			deploymentKind: entry.deploymentKind as SiteDeploymentKind,
			storageMode: entry.storageMode as SiteStorageMode,
			liveDeploymentId:
				typeof entry.liveDeploymentId === "string" && UUID_PATTERN.test(entry.liveDeploymentId)
					? entry.liveDeploymentId
					: null,
			domains,
		});
	}
	return {
		hostsDomain: nullableString(input.hostsDomain),
		hostsEnabled: input.hostsEnabled === true,
		publicEnabled: input.publicEnabled === true,
		domainsEnabled: input.domainsEnabled === true,
		edgeIpv4: nullableString(input.edgeIpv4),
		edgeIpv6: nullableString(input.edgeIpv6),
		edgeCnameTarget: nullableString(input.edgeCnameTarget),
		sites,
	};
}

export function parseAddedSiteDomain(value: unknown): AddedSiteDomain {
	const input = asRecord(value);
	const dns = asRecord(input?.dns);
	if (
		!input ||
		input.schema !== "qorpera.company-site-domain/v1" ||
		typeof input.id !== "string" ||
		!UUID_PATTERN.test(input.id) ||
		typeof input.siteId !== "string" ||
		!UUID_PATTERN.test(input.siteId) ||
		typeof input.hostname !== "string" ||
		typeof input.isApex !== "boolean" ||
		typeof input.isPrimary !== "boolean" ||
		typeof input.status !== "string" ||
		!DOMAIN_STATUSES.has(input.status as CustomDomainStatus) ||
		typeof input.verificationToken !== "string" ||
		!dns ||
		(dns.recordType !== "A" && dns.recordType !== "CNAME") ||
		typeof dns.txtHost !== "string" ||
		typeof dns.txtValue !== "string"
	) {
		throw new Error("Invalid site domain response.");
	}
	return {
		id: input.id,
		siteId: input.siteId,
		hostname: input.hostname,
		isApex: input.isApex,
		isPrimary: input.isPrimary,
		status: input.status as CustomDomainStatus,
		verificationToken: input.verificationToken,
		dns: {
			recordType: dns.recordType,
			ipv4: nullableString(dns.ipv4),
			ipv6: nullableString(dns.ipv6),
			cnameTarget: nullableString(dns.cnameTarget),
			txtHost: dns.txtHost,
			txtValue: dns.txtValue,
		},
	};
}

export function parseSiteSlugAvailability(value: unknown, siteId: string): SiteSlugAvailability {
	const input = asRecord(value);
	if (
		!input ||
		input.schema !== "qorpera.company-site-slug-check/v1" ||
		input.siteId !== siteId ||
		typeof input.slug !== "string" ||
		typeof input.available !== "boolean" ||
		typeof input.reason !== "string" ||
		!SLUG_AVAILABILITY_REASONS.has(input.reason as SiteSlugAvailabilityReason)
	) {
		throw new Error("Invalid site address check response.");
	}
	return {
		siteId: input.siteId,
		slug: input.slug,
		available: input.available,
		reason: input.reason as SiteSlugAvailabilityReason,
	};
}

export function parseUpdatedSiteSlug(value: unknown, siteId: string): UpdatedSiteSlug {
	const input = asRecord(value);
	if (
		!input ||
		input.schema !== "qorpera.company-site-slug/v1" ||
		input.siteId !== siteId ||
		typeof input.slug !== "string" ||
		validateSiteSlugInput(input.slug) !== undefined ||
		typeof input.url !== "string"
	) {
		throw new Error("Invalid site address response.");
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(input.url);
	} catch {
		throw new Error("Invalid site address response.");
	}
	if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
		throw new Error("Invalid site address response.");
	}
	return {
		siteId: input.siteId,
		slug: input.slug,
		url: input.url,
	};
}

export function createWebSiteHosting(cloud: Cloud, company: { profileId: string }): WebSiteHosting {
	if (!UUID_PATTERN.test(company.profileId)) throw new Error("Invalid company for site hosting.");
	return {
		async read(signal) {
			signal?.throwIfAborted();
			const raw = await withCloudDeadline(
				(deadline) => cloud.rpc("qorpera_company_site_hosting", { p_profile_id: company.profileId }, deadline),
				HOSTING_TIMEOUT_MS,
				signal,
			);
			return parseCompanySiteHostingState(raw);
		},
		async setPublic(siteId, isPublic, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(siteId)) throw new Error("Invalid site.");
			const raw = asRecord(
				await withCloudDeadline(
					(deadline) =>
						cloud.rpc("qorpera_set_company_site_public", { p_site_id: siteId, p_public: isPublic }, deadline),
					HOSTING_TIMEOUT_MS,
					signal,
				),
			);
			if (
				raw?.schema !== "qorpera.company-site-visibility/v1" ||
				raw.siteId !== siteId ||
				typeof raw.isPublic !== "boolean"
			) {
				throw new Error("Invalid visibility response.");
			}
			return raw.isPublic;
		},
		async checkSlug(siteId, slug, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(siteId)) throw new Error("Invalid site.");
			const cleaned = cleanSiteSlugInput(slug);
			const raw = await withCloudDeadline(
				(deadline) =>
					cloud.rpc("qorpera_check_company_site_slug", { p_site_id: siteId, p_slug: cleaned }, deadline),
				HOSTING_TIMEOUT_MS,
				signal,
			);
			return parseSiteSlugAvailability(raw, siteId);
		},
		async setSlug(siteId, slug, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(siteId)) throw new Error("Invalid site.");
			const cleaned = cleanSiteSlugInput(slug);
			if (validateSiteSlugInput(cleaned) !== undefined) throw new Error("Invalid site address.");
			const raw = await withCloudDeadline(
				(deadline) =>
					cloud.rpc("qorpera_set_company_site_slug", { p_site_id: siteId, p_slug: cleaned }, deadline),
				HOSTING_TIMEOUT_MS,
				signal,
			);
			return parseUpdatedSiteSlug(raw, siteId);
		},
		async addDomain(siteId, hostname, isApex, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(siteId)) throw new Error("Invalid site.");
			const problem = validateCustomDomainInput(hostname);
			if (problem) throw new Error(problem);
			const raw = await withCloudDeadline(
				(deadline) =>
					cloud.rpc(
						"qorpera_add_company_site_domain",
						{
							p_site_id: siteId,
							p_hostname: hostname.trim().toLowerCase().replace(/\.$/, ""),
							p_is_apex: isApex,
						},
						deadline,
					),
				HOSTING_TIMEOUT_MS,
				signal,
			);
			return parseAddedSiteDomain(raw);
		},
		async removeDomain(domainId, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(domainId)) throw new Error("Invalid domain.");
			const raw = asRecord(
				await withCloudDeadline(
					(deadline) => cloud.rpc("qorpera_remove_company_site_domain", { p_domain_id: domainId }, deadline),
					HOSTING_TIMEOUT_MS,
					signal,
				),
			);
			if (raw?.schema !== "qorpera.company-site-domain-remove/v1" || typeof raw.removed !== "boolean") {
				throw new Error("Invalid domain removal response.");
			}
			return raw.removed;
		},
		async setPrimaryDomain(domainId, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(domainId)) throw new Error("Invalid domain.");
			const raw = asRecord(
				await withCloudDeadline(
					(deadline) => cloud.rpc("qorpera_set_primary_site_domain", { p_domain_id: domainId }, deadline),
					HOSTING_TIMEOUT_MS,
					signal,
				),
			);
			if (raw?.schema !== "qorpera.company-site-domain-primary/v1" || typeof raw.hostname !== "string") {
				throw new Error("Invalid primary domain response.");
			}
			return raw.hostname;
		},
		async recheckDomain(domainId, signal) {
			signal?.throwIfAborted();
			if (!UUID_PATTERN.test(domainId)) throw new Error("Invalid domain.");
			const raw = asRecord(
				await withCloudDeadline(
					(deadline) => cloud.rpc("qorpera_recheck_company_site_domain", { p_domain_id: domainId }, deadline),
					HOSTING_TIMEOUT_MS,
					signal,
				),
			);
			if (
				raw?.schema !== "qorpera.company-site-domain-recheck/v1" ||
				typeof raw.status !== "string" ||
				!DOMAIN_STATUSES.has(raw.status as CustomDomainStatus)
			) {
				throw new Error("Invalid domain recheck response.");
			}
			return raw.status as CustomDomainStatus;
		},
	};
}
