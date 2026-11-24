// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { SitesView } from "../src/app/views/settings-sites.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { parseSitePreviewAnswer } from "../src/cloud/releases.ts";
import {
	createWebSiteHosting,
	isApexHostname,
	NATIVE_SITE_HOST,
	parseAddedSiteDomain,
	parseCompanySiteHostingState,
	validateCustomDomainInput,
	type WebSiteHosting,
} from "../src/cloud/site-hosting.ts";
import {
	type CompanySite,
	createWebSites,
	parseCompanySite,
	parseSiteMemberPass,
	siteOfLink,
} from "../src/cloud/sites.ts";
import { settle } from "./fixtures.ts";

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
		const added = await client.addDomain(SITE_ID, "MinButik.dk.", true);
		expect(added.hostname).toBe("minbutik.dk");
		expect(added.dns.recordType).toBe("A");
		expect(added.dns.ipv4).toBe("93.164.62.162");
		expect(await client.recheckDomain(DOMAIN_ID)).toBe("pending_dns");
		expect(await client.setPrimaryDomain(DOMAIN_ID)).toBe("minbutik.dk");
		expect(await client.removeDomain(DOMAIN_ID)).toBe(true);

		expect(() => parseCompanySiteHostingState({ schema: "wrong" })).toThrow();
		expect(() => parseAddedSiteDomain({ schema: "wrong" })).toThrow();
	});

	it("renders public badge, custom domains, visibility toggle, and apex DNS guide in SitesView", async () => {
		const site: CompanySite = {
			id: SITE_ID,
			slug: "nordic-shop",
			title: "Nordic Shop",
			kind: "files",
			url: "https://nordic-shop.qorpera.com/",
			state: "live",
			source: "code/company/nordic-shop",
			files: 12,
			bytes: 4096,
			publishedAt: "2026-11-21T19:00:00Z",
			publishedBy: null,
			createdAt: "2026-11-21T18:00:00Z",
			passwordChangedAt: "2026-11-21T18:00:00Z",
			machine: null,
			port: null,
		};
		const setPublic = vi.fn(async () => false);
		const addDomain = vi.fn(async () => ({
			id: DOMAIN_ID,
			siteId: SITE_ID,
			hostname: "nybutik.dk",
			isApex: true,
			isPrimary: false,
			status: "pending_dns" as const,
			verificationToken: "c".repeat(32),
			dns: {
				recordType: "A" as const,
				ipv4: "93.164.62.162",
				ipv6: null,
				cnameTarget: "sites.qorpera.site",
				txtHost: "_qorpera.nybutik.dk",
				txtValue: `qorpera-verify=${"c".repeat(32)}`,
			},
		}));
		const setPrimaryDomain = vi.fn(async () => "www.minbutik.dk");
		const removeDomain = vi.fn(async () => true);
		const recheckDomain = vi.fn(async () => "pending_dns" as const);
		const PENDING_DOMAIN_ID = "55555555-5555-4555-8555-555555555555";
		const hosting: WebSiteHosting = {
			read: vi.fn(async () => ({
				hostsDomain: "qorpera.site",
				hostsEnabled: true,
				publicEnabled: true,
				domainsEnabled: true,
				edgeIpv4: "93.164.62.162",
				edgeIpv6: null,
				edgeCnameTarget: "sites.qorpera.site",
				sites: new Map([
					[
						SITE_ID,
						{
							siteId: SITE_ID,
							slug: "nordic-shop",
							isPublic: true,
							deploymentKind: "hybrid" as const,
							storageMode: "blob" as const,
							liveDeploymentId: DEPLOYMENT_ID,
							domains: [
								{
									id: DOMAIN_ID,
									hostname: "www.minbutik.dk",
									isApex: false,
									isPrimary: false,
									status: "dns_verified" as const,
									verificationToken: "a".repeat(32),
									lastCheckedAt: null,
									verifiedAt: "2026-11-21T19:00:00Z",
									tlsActiveAt: null,
									lastError: null,
								},
								{
									id: PENDING_DOMAIN_ID,
									hostname: "ny.minbutik.dk",
									isApex: false,
									isPrimary: false,
									status: "pending_dns" as const,
									verificationToken: "d".repeat(32),
									lastCheckedAt: null,
									verifiedAt: null,
									tlsActiveAt: null,
									lastError: null,
								},
							],
						},
					],
				]),
			})),
			setPublic,
			addDomain,
			removeDomain,
			setPrimaryDomain,
			recheckDomain,
		};

		const ac = new AbortController();
		const view = new SitesView(
			{
				list: async () => [site],
				password: async () => ({ siteId: SITE_ID, password: "pw", changedAt: site.passwordChangedAt }),
				setPassword: async () => ({ siteId: SITE_ID, password: "pw", changedAt: site.passwordChangedAt }),
				unpublish: async () => true,
			},
			ac.signal,
			{ hosting },
		);
		document.body.append(view.el);
		await settle();

		expect(view.el.querySelector(`[data-site-public="${SITE_ID}"]`)?.textContent).toBe("Live");
		expect(view.el.querySelector('[data-site-kind="hybrid"]')?.textContent).toBe("Hybrid");
		const chip = view.el.querySelector('[data-domain="www.minbutik.dk"]');
		expect(chip?.textContent).toContain("DNS verified");
		expect(chip?.querySelector<HTMLAnchorElement>("a.site-domain-link")?.href).toBe("https://www.minbutik.dk/");

		const pendingChip = view.el.querySelector('[data-domain="ny.minbutik.dk"]');
		const pendingButtons = [...(pendingChip?.querySelectorAll("button") ?? [])];
		pendingButtons.find((b) => b.textContent === "Check DNS")?.click();
		await settle();
		expect(recheckDomain).toHaveBeenCalledWith(PENDING_DOMAIN_ID, expect.any(AbortSignal));

		const buttons = [...(view.el.querySelector('[data-domain="www.minbutik.dk"]')?.querySelectorAll("button") ?? [])];
		buttons.find((b) => b.textContent === "Set as primary")?.click();
		await settle();
		expect(setPrimaryDomain).toHaveBeenCalledWith(DOMAIN_ID, expect.any(AbortSignal));

		const more = view.el.querySelector<HTMLButtonElement>(`[data-focus-key="site-more:${SITE_ID}"]`);
		more?.click();
		await settle();
		const menuItems = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		menuItems.find((b) => b.textContent?.includes("Custom domain"))?.click();
		await settle();

		const input = document.querySelector<HTMLInputElement>(".sites-question-input");
		expect(input).not.toBeNull();
		if (input) input.value = "nybutik.dk";
		const form = document.querySelector<HTMLFormElement>("form.sites-question");
		form?.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();

		expect(addDomain).toHaveBeenCalledWith(SITE_ID, "nybutik.dk", true, expect.any(AbortSignal));
		expect(document.querySelector(".site-dns-guide")?.textContent).toContain("93.164.62.162");
		expect(document.querySelector(".site-dns-guide")?.textContent).toContain("_qorpera.nybutik.dk");

		ac.abort();
		document.body.innerHTML = "";
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
			if (name === "qorpera_company_site_password" || name === "qorpera_set_company_site_password") {
				return {
					schema: "qorpera.company-site-password/v1",
					siteId: SITE_ID,
					password: "secret",
					changedAt: "2026-11-21T20:00:00Z",
				};
			}
			if (name === "qorpera_unpublish_company_site") {
				return { schema: "qorpera.company-site-unpublish/v1", siteId: SITE_ID, removed: true };
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
		await hosting.addDomain(SITE_ID, "minbutik.dk", false, ac.signal);
		await hosting.recheckDomain(DOMAIN_ID, ac.signal);
		await hosting.setPrimaryDomain(DOMAIN_ID, ac.signal);
		await hosting.removeDomain(DOMAIN_ID, ac.signal);
		await sites.list(ac.signal);
		await sites.memberPass({ id: SITE_ID, slug: "nordic-shop" }, ac.signal);
		await sites.password(SITE_ID, ac.signal);
		await sites.setPassword(SITE_ID, "secret", ac.signal);
		await sites.unpublish(SITE_ID, ac.signal);
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
