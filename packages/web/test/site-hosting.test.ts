// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Cloud } from "../src/cloud/client.ts";
import { parseSitePreviewAnswer } from "../src/cloud/releases.ts";
import {
	cleanSiteSlugInput,
	createWebSiteHosting,
	dnsRecordFound,
	dnsShop,
	isApexHostname,
	NATIVE_SITE_HOST,
	parseAddedSiteDomain,
	parseCompanySiteHostingState,
	parseDomainCheck,
	parseSiteSlugAvailability,
	parseUpdatedSiteSlug,
	registrableDomain,
	type SiteDnsSetup,
	shopHostname,
	siteDnsRecords,
	validateCustomDomainInput,
	validateSiteSlugInput,
} from "../src/cloud/site-hosting.ts";
import { createWebSites, parseCompanySite, parseSiteMemberPass, siteOfLink } from "../src/cloud/sites.ts";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const DOMAIN_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";

describe("site-hosting", () => {
	it("matches both qorpera.site and qorpera.com own and next hosts", () => {
		expect(NATIVE_SITE_HOST.exec("nordic-shop.qorpera.site")?.[1]).toBe("nordic-shop");
		expect(NATIVE_SITE_HOST.exec("nordic-shop--next.qorpera.site")?.[2]).toBe("--next");
		expect(NATIVE_SITE_HOST.exec("nordic-shop.qorpera.com")?.[1]).toBe("nordic-shop");
		expect(NATIVE_SITE_HOST.exec("nordic-shop.example.dk")).toBeNull();

		const parsed = parseCompanySite({
			schema: "qorpera.company-site/v1",
			id: SITE_ID,
			slug: "nordic-shop",
			title: "Nordic Shop",
			kind: "files",
			machine: null,
			port: null,
			url: "https://nordic-shop.qorpera.site/",
			state: "live",
			source: "code/company/nordic-shop",
			files: 10,
			bytes: 2048,
			publishedAt: "2026-11-21T19:00:00Z",
			publishedBy: null,
			createdAt: "2026-11-21T18:00:00Z",
			passwordChangedAt: "2026-11-21T18:00:00Z",
		});
		expect(parsed.url).toBe("https://nordic-shop.qorpera.site/");
		expect(siteOfLink([parsed], "https://nordic-shop.qorpera.site/pricing")).toEqual(parsed);

		const ticket = "A".repeat(43);
		expect(
			parseSitePreviewAnswer(
				{
					schema: "qorpera.site-preview/v1",
					state: "open",
					url: `https://nordic-shop--next.qorpera.site/.qorpera/enter?t=${ticket}`,
				},
				"nordic-shop",
			),
		).toEqual({
			state: "open",
			url: `https://nordic-shop--next.qorpera.site/.qorpera/enter?t=${ticket}`,
		});

		expect(
			parseSiteMemberPass(
				{
					schema: "qorpera.site-member-pass/v1",
					state: "open",
					host: "nordic-shop.qorpera.site",
					pass: ticket,
					expiresAt: "2026-11-21T21:00:00Z",
					action: "https://nordic-shop.qorpera.site/__qorpera/member",
				},
				"nordic-shop",
			),
		).toMatchObject({ state: "open", host: "nordic-shop.qorpera.site" });
	});

	it("validates custom domain inputs and detects apex vs subdomain", () => {
		expect(validateCustomDomainInput("minbutik.dk")).toBeUndefined();
		expect(validateCustomDomainInput("www.minbutik.dk")).toBeUndefined();
		expect(validateCustomDomainInput("bad.qorpera.site")).toBeDefined();
		expect(validateCustomDomainInput("bad.qorpera.com")).toBeDefined();
		expect(validateCustomDomainInput("93.164.62.162")).toBeDefined();
		expect(isApexHostname("minbutik.dk")).toBe(true);
		expect(isApexHostname("www.minbutik.dk")).toBe(false);
	});

	it("writes each line's hostname the way a shop's form wants it, relative to the bought domain", () => {
		const dns = (hostname: string, recordType: "A" | "CNAME"): SiteDnsSetup => ({
			recordType,
			ipv4: "93.164.62.162",
			ipv6: null,
			cnameTarget: "edge.qorpera.site",
			txtHost: `_qorpera.${hostname}`,
			txtValue: "qorpera-verify=abc",
		});
		expect(siteDnsRecords("namah.dk", dns("namah.dk", "A"))).toEqual([
			{ type: "A", host: "", value: "93.164.62.162" },
			{ type: "TXT", host: "_qorpera", value: "qorpera-verify=abc" },
		]);
		expect(siteDnsRecords("www.namah.dk", dns("www.namah.dk", "CNAME"))).toEqual([
			{ type: "CNAME", host: "www", value: "edge.qorpera.site" },
			{ type: "TXT", host: "_qorpera.www", value: "qorpera-verify=abc" },
		]);
		expect(siteDnsRecords("shop.eu.namah.dk", dns("shop.eu.namah.dk", "CNAME")).map((record) => record.host)).toEqual(
			["shop.eu", "_qorpera.shop.eu"],
		);
		expect(registrableDomain(" WWW.Namah.DK. ")).toBe("namah.dk");
		expect(registrableDomain("www.shop.co.uk")).toBe("shop.co.uk");
		expect(registrableDomain("shop.com.au")).toBe("shop.com.au");
		expect(registrableDomain("co.uk")).toBe("co.uk");
		expect(isApexHostname("shop.co.uk")).toBe(true);
		expect(isApexHostname("www.shop.co.uk")).toBe(false);
		expect(siteDnsRecords("www.shop.co.uk", dns("www.shop.co.uk", "CNAME")).map((record) => record.host)).toEqual([
			"www",
			"_qorpera.www",
		]);
		expect(siteDnsRecords("shop.co.uk", dns("shop.co.uk", "A")).map((record) => record.host)).toEqual([
			"",
			"_qorpera",
		]);
		expect(shopHostname("_qorpera.namah.dk.", "namah.dk")).toBe("_qorpera");
		expect(shopHostname("other.example", "namah.dk")).toBe("other.example");
	});

	it("reads the router's last check in today's one-word form, the full form, and junk", () => {
		expect(parseDomainCheck(null)).toEqual({ reason: null, txtOnWrongName: false, nameServers: [] });
		expect(parseDomainCheck("txt_verification_missing")).toEqual({
			reason: "txt_verification_missing",
			txtOnWrongName: false,
			nameServers: [],
		});
		expect(
			parseDomainCheck(" dns_routing_and_txt_missing  txt_on_wrong_name ns=NS01.one.com.,ns02.one.com later_token "),
		).toEqual({
			reason: "dns_routing_and_txt_missing",
			txtOnWrongName: true,
			nameServers: ["ns01.one.com", "ns02.one.com"],
		});
		expect(parseDomainCheck("domain_not_found ns=")).toEqual({
			reason: "domain_not_found",
			txtOnWrongName: false,
			nameServers: [],
		});
		expect(parseDomainCheck("txt_on_wrong_name apex_a_record_mismatch")).toEqual({
			reason: null,
			txtOnWrongName: false,
			nameServers: [],
		});
		expect(parseDomainCheck("ok ns=bad..host,<script>,ns1.simply.com").nameServers).toEqual(["ns1.simply.com"]);
		expect(parseDomainCheck("").reason).toBeNull();
	});

	it("names the shop from its name servers, and no shop when none matches", () => {
		expect(dnsShop(["ns01.one.com", "ns02.one.com"])).toBe("one.com");
		expect(dnsShop(["ns1.simply.com"])).toBe("Simply.com");
		expect(dnsShop(["ns41.domaincontrol.com"])).toBe("GoDaddy");
		expect(dnsShop(["ada.ns.cloudflare.com"])).toBe("Cloudflare");
		expect(dnsShop(["dns1.registrar-servers.com"])).toBe("Namecheap");
		expect(dnsShop(["ns-1.gandi.net"])).toBe("Gandi");
		expect(dnsShop(["ns1.dns-parking.com"])).toBe("Hostinger");
		expect(dnsShop(["ns1.dandomain.dk"])).toBe("DanDomain");
		expect(dnsShop(["ns1045.ui-dns.de"])).toBe("IONOS");
		expect(dnsShop(["ns-cloud-a1.googledomains.com"])).toBe("Squarespace");
		expect(dnsShop(["ns1.notone.com", "ns.example.net"])).toBeNull();
		expect(dnsShop(["ns.example.net", "ns2.one.com"])).toBe("one.com");
		expect(dnsShop([])).toBeNull();
	});

	it("counts a line as found only from the reason that says so", () => {
		const a = { type: "A", host: "", value: "x" } as const;
		const txt = { type: "TXT", host: "_qorpera", value: "y" } as const;
		expect([a, txt].map((record) => dnsRecordFound(record, "txt_verification_missing"))).toEqual([true, false]);
		expect([a, txt].map((record) => dnsRecordFound(record, "apex_a_record_mismatch"))).toEqual([false, true]);
		expect([a, txt].map((record) => dnsRecordFound(record, "cname_record_mismatch"))).toEqual([false, false]);
		expect([a, txt].map((record) => dnsRecordFound(record, "dns_routing_and_txt_missing"))).toEqual([false, false]);
		expect([a, txt].map((record) => dnsRecordFound(record, null))).toEqual([false, false]);
	});

	it("validates site subdomain inputs against the kernel slug rules", () => {
		expect(cleanSiteSlugInput("  My-Shop  ")).toBe("my-shop");
		expect(validateSiteSlugInput("my-shop")).toBeUndefined();
		expect(validateSiteSlugInput("a1b")).toBeUndefined();
		expect(validateSiteSlugInput("ab")).toBe("too_short");
		expect(validateSiteSlugInput("bad--slug")).toBe("invalid");
		expect(validateSiteSlugInput("-leading")).toBe("invalid");
		expect(validateSiteSlugInput("trailing-")).toBe("invalid");
		expect(validateSiteSlugInput("bad_slug")).toBe("invalid");
		expect(validateSiteSlugInput("a".repeat(49))).toBe("invalid");
		expect(validateSiteSlugInput("shop")).toBe("reserved");
		expect(validateSiteSlugInput("my-preview")).toBe("reserved");
		expect(validateSiteSlugInput("qorpera-fans")).toBe("reserved");
	});

	it("parses hosting state and performs visibility and domain RPCs", async () => {
		const rpc = vi.fn(async (name: string) => {
			if (name === "qorpera_company_site_hosting") {
				return {
					schema: "qorpera.company-site-hosting/v1",
					hostsDomain: "qorpera.site",
					hostsEnabled: true,
					publicEnabled: true,
					domainsEnabled: true,
					edgeIpv4: "93.164.62.162",
					edgeIpv6: null,
					edgeCnameTarget: "sites.qorpera.site",
					sites: [
						{
							siteId: SITE_ID,
							slug: "nordic-shop",
							isPublic: true,
							deploymentKind: "hybrid",
							storageMode: "blob",
							liveDeploymentId: DEPLOYMENT_ID,
							domains: [
								{
									id: DOMAIN_ID,
									hostname: "minbutik.dk",
									isApex: true,
									isPrimary: true,
									status: "tls_active",
									verificationToken: "a".repeat(32),
									lastCheckedAt: "2026-11-21T20:00:00Z",
									verifiedAt: "2026-11-21T19:55:00Z",
									tlsActiveAt: "2026-11-21T19:56:00Z",
									lastError: null,
								},
							],
						},
					],
				};
			}
			if (name === "qorpera_set_company_site_public") {
				return { schema: "qorpera.company-site-visibility/v1", siteId: SITE_ID, isPublic: true };
			}
			if (name === "qorpera_check_company_site_slug") {
				return {
					schema: "qorpera.company-site-slug-check/v1",
					siteId: SITE_ID,
					slug: "fresh-shop",
					available: true,
					reason: "available",
				};
			}
			if (name === "qorpera_set_company_site_slug") {
				return {
					schema: "qorpera.company-site-slug/v1",
					siteId: SITE_ID,
					slug: "fresh-shop",
					url: "https://fresh-shop.qorpera.site/",
				};
			}
			if (name === "qorpera_add_company_site_domain") {
				return {
					schema: "qorpera.company-site-domain/v1",
					id: DOMAIN_ID,
					siteId: SITE_ID,
					hostname: "minbutik.dk",
					isApex: true,
					isPrimary: false,
					status: "pending_dns",
					verificationToken: "b".repeat(32),
					dns: {
						recordType: "A",
						ipv4: "93.164.62.162",
						ipv6: null,
						cnameTarget: "sites.qorpera.site",
						txtHost: "_qorpera.minbutik.dk",
						txtValue: `qorpera-verify=${"b".repeat(32)}`,
					},
				};
			}
			if (name === "qorpera_set_primary_site_domain") {
				return {
					schema: "qorpera.company-site-domain-primary/v1",
					id: DOMAIN_ID,
					siteId: SITE_ID,
					hostname: "minbutik.dk",
				};
			}
			if (name === "qorpera_recheck_company_site_domain") {
				return {
					schema: "qorpera.company-site-domain-recheck/v1",
					id: DOMAIN_ID,
					hostname: "minbutik.dk",
					status: "pending_dns",
				};
			}
			return { schema: "qorpera.company-site-domain-remove/v1", id: DOMAIN_ID, removed: true };
		});

		const client = createWebSiteHosting({ rpc } as unknown as Cloud, { profileId: COMPANY_ID });
		const state = await client.read();
		expect(state.hostsDomain).toBe("qorpera.site");
		expect(state.edgeIpv4).toBe("93.164.62.162");
		expect(state.sites.get(SITE_ID)?.domains[0]?.hostname).toBe("minbutik.dk");

		expect(await client.setPublic(SITE_ID, true)).toBe(true);
		expect(await client.checkSlug(SITE_ID, "  Fresh-Shop  ")).toEqual({
			siteId: SITE_ID,
			slug: "fresh-shop",
			available: true,
			reason: "available",
		});
		expect(await client.setSlug(SITE_ID, "  Fresh-Shop  ")).toEqual({
			siteId: SITE_ID,
			slug: "fresh-shop",
			url: "https://fresh-shop.qorpera.site/",
		});
		const added = await client.addDomain(SITE_ID, "MinButik.dk.", true);
		expect(added.hostname).toBe("minbutik.dk");
		expect(added.dns.recordType).toBe("A");
		expect(added.dns.ipv4).toBe("93.164.62.162");
		expect(await client.recheckDomain(DOMAIN_ID)).toBe("pending_dns");
		expect(await client.setPrimaryDomain(DOMAIN_ID)).toBe("minbutik.dk");
		expect(await client.removeDomain(DOMAIN_ID)).toBe(true);

		expect(() => parseCompanySiteHostingState({ schema: "wrong" })).toThrow();
		expect(() => parseAddedSiteDomain({ schema: "wrong" })).toThrow();
		expect(() => parseSiteSlugAvailability({ schema: "wrong" }, SITE_ID)).toThrow();
		expect(() => parseUpdatedSiteSlug({ schema: "wrong" }, SITE_ID)).toThrow();
		expect(() =>
			parseUpdatedSiteSlug(
				{
					schema: "qorpera.company-site-slug/v1",
					siteId: SITE_ID,
					slug: "fresh-shop",
					url: "http://evil.example/",
				},
				SITE_ID,
			),
		).toThrow();
	});

	it("forwards AbortSignal to site hosting and company site RPCs", async () => {
		const seenSignals: (AbortSignal | undefined)[] = [];
		const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>, signal?: AbortSignal) => {
			seenSignals.push(signal);
			if (name === "qorpera_company_site_hosting") {
				return {
					schema: "qorpera.company-site-hosting/v1",
					hostsDomain: "qorpera.site",
					hostsEnabled: true,
					publicEnabled: true,
					domainsEnabled: true,
					edgeIpv4: "93.164.62.162",
					edgeIpv6: null,
					edgeCnameTarget: "sites.qorpera.site",
					sites: [],
				};
			}
			if (name === "qorpera_set_company_site_public") {
				return { schema: "qorpera.company-site-visibility/v1", siteId: SITE_ID, isPublic: true };
			}
			if (name === "qorpera_check_company_site_slug") {
				return {
					schema: "qorpera.company-site-slug-check/v1",
					siteId: SITE_ID,
					slug: "fresh-shop",
					available: true,
					reason: "available",
				};
			}
			if (name === "qorpera_set_company_site_slug") {
				return {
					schema: "qorpera.company-site-slug/v1",
					siteId: SITE_ID,
					slug: "fresh-shop",
					url: "https://fresh-shop.qorpera.site/",
				};
			}
			if (name === "qorpera_add_company_site_domain") {
				return {
					schema: "qorpera.company-site-domain/v1",
					id: DOMAIN_ID,
					siteId: SITE_ID,
					hostname: "minbutik.dk",
					isApex: true,
					isPrimary: false,
					status: "pending_dns",
					verificationToken: "b".repeat(32),
					dns: {
						recordType: "A",
						ipv4: "93.164.62.162",
						ipv6: null,
						cnameTarget: "sites.qorpera.site",
						txtHost: "_qorpera.minbutik.dk",
						txtValue: `qorpera-verify=${"b".repeat(32)}`,
					},
				};
			}
			if (name === "qorpera_recheck_company_site_domain") {
				return {
					schema: "qorpera.company-site-domain-recheck/v1",
					id: DOMAIN_ID,
					hostname: "minbutik.dk",
					status: "pending_dns",
				};
			}
			if (name === "qorpera_set_primary_site_domain") {
				return {
					schema: "qorpera.company-site-domain-primary/v1",
					id: DOMAIN_ID,
					siteId: SITE_ID,
					hostname: "minbutik.dk",
				};
			}
			if (name === "qorpera_remove_company_site_domain") {
				return { schema: "qorpera.company-site-domain-remove/v1", id: DOMAIN_ID, removed: true };
			}
			if (name === "qorpera_list_company_sites") return [];
			if (name === "qorpera_site_member_pass") {
				return {
					schema: "qorpera.site-member-pass/v1",
					state: "open",
					host: "nordic-shop.qorpera.site",
					pass: "A".repeat(43),
					expiresAt: "2026-11-21T21:00:00Z",
					action: "https://nordic-shop.qorpera.site/__qorpera/member",
				};
			}
			if (name === "qorpera_company_site_password") {
				return {
					schema: "qorpera.company-site-password/v1",
					siteId: SITE_ID,
					password: "secret",
					changedAt: "2026-11-21T20:00:00Z",
				};
			}
			return {
				schema: "qorpera.company-site-access/v1",
				sites: [],
			};
		});
		const ac = new AbortController();
		const hosting = createWebSiteHosting({ rpc } as unknown as Cloud, { profileId: COMPANY_ID });
		const sites = createWebSites({ rpc } as unknown as Cloud, { profileId: COMPANY_ID });
		await hosting.read(ac.signal);
		await hosting.setPublic(SITE_ID, true, ac.signal);
		await hosting.checkSlug(SITE_ID, "fresh-shop", ac.signal);
		await hosting.setSlug(SITE_ID, "fresh-shop", ac.signal);
		await hosting.addDomain(SITE_ID, "minbutik.dk", false, ac.signal);
		await hosting.recheckDomain(DOMAIN_ID, ac.signal);
		await hosting.setPrimaryDomain(DOMAIN_ID, ac.signal);
		await hosting.removeDomain(DOMAIN_ID, ac.signal);
		await sites.list(ac.signal);
		await sites.memberPass({ id: SITE_ID, slug: "nordic-shop" }, ac.signal);
		await sites.password(SITE_ID, ac.signal);
		await sites.access(ac.signal);

		expect(seenSignals).toHaveLength(12);
		expect(seenSignals.every((sig) => sig instanceof AbortSignal && !sig.aborted)).toBe(true);

		const inFlightAc = new AbortController();
		let pendingHostingSignal: AbortSignal | undefined;
		let pendingAccessSignal: AbortSignal | undefined;
		rpc.mockImplementation((name: string, _args?: Record<string, unknown>, signal?: AbortSignal) => {
			if (name === "qorpera_company_site_hosting") pendingHostingSignal = signal;
			if (name === "qorpera_company_site_access") pendingAccessSignal = signal;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(signal.reason ?? new DOMException("aborted", "AbortError")),
					{
						once: true,
					},
				);
			});
		});
		const pendingHosting = hosting.read(inFlightAc.signal);
		const pendingAccess = sites.access(inFlightAc.signal);
		await Promise.resolve();
		expect(pendingHostingSignal).toBeInstanceOf(AbortSignal);
		expect(pendingAccessSignal).toBeInstanceOf(AbortSignal);
		expect(pendingHostingSignal?.aborted).toBe(false);
		expect(pendingAccessSignal?.aborted).toBe(false);
		inFlightAc.abort(new DOMException("caller aborted", "AbortError"));
		expect(pendingHostingSignal?.aborted).toBe(true);
		expect(pendingAccessSignal?.aborted).toBe(true);
		await expect(pendingHosting).rejects.toThrow();
		await expect(pendingAccess).rejects.toThrow();
	});
});
