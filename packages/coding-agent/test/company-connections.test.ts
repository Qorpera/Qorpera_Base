/**
 * Company connections state (Build 3): founder-bound destinations and
 * secrets, kernel-side dereferencing, and the RFC 6749 refresh lifecycle.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bindCompanySecret,
	bindNetworkDestination,
	type CompanySecret,
	type CompanySecretStore,
	companyConnectionsPath,
	createScheduledJob,
	DEFAULT_SCHEDULED_JOB_ID,
	deleteScheduledJob,
	destinationAllowed,
	disableWebhook,
	enableWebhook,
	findStaffScheduledJob,
	persistWebhookPort,
	readCompanyConnections,
	readScheduledJobs,
	readWebhookBinding,
	removeCompanySecret,
	removeNetworkDestination,
	resolveCompanySecret,
	scheduledJobIntervalMinutes,
	setCompanySecretStore,
	suspendScheduledJob,
	updateScheduledJob,
	upsertStaffScheduledJob,
} from "../src/core/company-connections.ts";

let root: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-connections-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
	process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-home");
	setCompanySecretStore(undefined);
});

afterEach(() => {
	setCompanySecretStore(undefined);
	if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
	else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("network destinations", () => {
	it("binds, lists, and removes destinations; rejects invalid hosts", () => {
		bindNetworkDestination(root, "API.Example.com", "the API");
		bindNetworkDestination(root, "hooks.example.com:8443");
		expect(readCompanyConnections(root).destinations.map((destination) => destination.host)).toEqual([
			"api.example.com",
			"hooks.example.com:8443",
		]);
		expect(() => bindNetworkDestination(root, "https://api.example.com")).toThrow(/Invalid destination/);
		expect(removeNetworkDestination(root, "api.example.com")).toBe(true);
		expect(removeNetworkDestination(root, "api.example.com")).toBe(false);
	});

	it("allows only HTTPS to exactly bound hosts", () => {
		bindNetworkDestination(root, "api.example.com");
		bindNetworkDestination(root, "alt.example.com:8443");
		expect(destinationAllowed(root, new URL("https://api.example.com/v1/things?q=1"))).toBe(true);
		expect(destinationAllowed(root, new URL("http://api.example.com/v1"))).toBe(false);
		expect(destinationAllowed(root, new URL("https://sub.api.example.com/"))).toBe(false);
		expect(destinationAllowed(root, new URL("https://api.example.com:8443/"))).toBe(false);
		expect(destinationAllowed(root, new URL("https://alt.example.com:8443/"))).toBe(true);
		expect(destinationAllowed(root, new URL("https://evil.example.net/"))).toBe(false);
	});
});

describe("secrets", () => {
	it("binds and lists names only, never values", () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "raw-value" });
		const listed = readCompanyConnections(root);
		expect(listed.secretNames).toEqual(["api-key"]);
		expect(JSON.stringify(listed)).not.toContain("raw-value");
		expect(removeCompanySecret(root, "api-key")).toBe(true);
		expect(removeCompanySecret(root, "api-key")).toBe(false);
		expect(() => bindCompanySecret(root, "bad name!", { kind: "static", value: "x" })).toThrow(/Invalid secret name/);
	});

	it("migrates legacy plaintext secrets into an installed trusted store", async () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "legacy-raw-value" });
		const path = companyConnectionsPath(root);
		expect(readFileSync(path, "utf-8")).toContain("legacy-raw-value");
		const stored = new Map<string, CompanySecret>();
		const store: CompanySecretStore = {
			list: () => [...stored.keys()].sort(),
			get: (_root, name) => stored.get(name),
			put: (_root, name, secret) => stored.set(name, secret),
			remove: (_root, name) => stored.delete(name),
		};
		setCompanySecretStore(store);

		expect(readCompanyConnections(root).secretNames).toEqual(["api-key"]);
		expect(readFileSync(path, "utf-8")).not.toContain("legacy-raw-value");
		expect(await resolveCompanySecret(root, "api-key")).toBe("legacy-raw-value");
	});

	it("resolves static secrets and non-expired oauth2 secrets without network", async () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "raw-value" });
		bindCompanySecret(root, "oauth", {
			kind: "oauth2",
			accessToken: "live-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://auth.example.com/token",
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		});
		const failingFetch: typeof fetch = () => {
			throw new Error("no network expected");
		};
		expect(await resolveCompanySecret(root, "api-key", failingFetch)).toBe("raw-value");
		expect(await resolveCompanySecret(root, "oauth", failingFetch)).toBe("live-token");
		await expect(resolveCompanySecret(root, "missing", failingFetch)).rejects.toThrow(/Unknown secret reference/);
	});

	it("refreshes expired oauth2 secrets through the token endpoint and persists the rotation", async () => {
		bindCompanySecret(root, "oauth", {
			kind: "oauth2",
			accessToken: "stale-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://auth.example.com/token",
			clientId: "client-a",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		const seen: Array<{ url: string; body: string }> = [];
		const fakeFetch: typeof fetch = async (url, init) => {
			seen.push({ url: String(url), body: String(init?.body) });
			return new Response(
				JSON.stringify({ access_token: "fresh-token", refresh_token: "refresh-2", expires_in: 3600 }),
				{ status: 200 },
			);
		};
		expect(await resolveCompanySecret(root, "oauth", fakeFetch)).toBe("fresh-token");
		expect(seen.length).toBe(1);
		expect(seen[0].url).toBe("https://auth.example.com/token");
		expect(seen[0].body).toContain("grant_type=refresh_token");
		expect(seen[0].body).toContain("refresh_token=refresh-1");
		expect(seen[0].body).toContain("client_id=client-a");
		// Rotation persisted: the store now carries the new pair, and the next
		// resolve needs no network until the new expiry.
		const stored = readFileSync(companyConnectionsPath(root), "utf-8");
		expect(stored).toContain("fresh-token");
		expect(stored).toContain("refresh-2");
		expect(stored).not.toContain("stale-token");
		const failingFetch: typeof fetch = () => {
			throw new Error("no network expected");
		};
		expect(await resolveCompanySecret(root, "oauth", failingFetch)).toBe("fresh-token");
	});

	it("refreshes a Nordea-style grant with signed public headers, header credentials, and token rotation", async () => {
		bindCompanySecret(root, "nordea", {
			kind: "oauth2",
			accessToken: "stale-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://api.nordeaopenbanking.com/business/v5/authorize/token",
			clientId: "sandbox-client-id",
			clientSecret: "sandbox-client-secret",
			clientAuthentication: {
				kind: "headers",
				clientIdHeader: "X-IBM-Client-Id",
				clientSecretHeader: "X-IBM-Client-Secret",
			},
			tokenHeaders: {
				Signature: "SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX",
				"X-Nordea-Originating-Host": "$" + "{url_host}",
				"X-Nordea-Originating-Date": "$" + "{http_date}",
				Digest: "$" + "{body_sha256_digest}",
			},
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		const seenRefreshTokens: string[] = [];
		const fakeFetch: typeof fetch = async (url, init) => {
			const body = String(init?.body);
			const form = new URLSearchParams(body);
			const headers = new Headers(init?.headers);
			seenRefreshTokens.push(form.get("refresh_token") ?? "");
			expect(String(url)).toBe("https://api.nordeaopenbanking.com/business/v5/authorize/token");
			expect(form.get("client_id")).toBeNull();
			expect(form.get("client_secret")).toBeNull();
			expect(headers.get("X-IBM-Client-Id")).toBe("sandbox-client-id");
			expect(headers.get("X-IBM-Client-Secret")).toBe("sandbox-client-secret");
			expect(headers.get("Signature")).toBe("SKIP_SIGNATURE_VALIDATION_FOR_SANDBOX");
			expect(headers.get("X-Nordea-Originating-Host")).toBe("api.nordeaopenbanking.com");
			expect(headers.get("X-Nordea-Originating-Date")).not.toBe("");
			expect(headers.get("Digest")).toBe(`SHA-256=${createHash("sha256").update(body).digest("base64")}`);
			const rotation = seenRefreshTokens.length + 1;
			return new Response(
				JSON.stringify({ access_token: `access-${rotation}`, refresh_token: `refresh-${rotation}`, expires_in: 0 }),
				{ status: 200 },
			);
		};

		expect(await resolveCompanySecret(root, "nordea", fakeFetch)).toBe("access-2");
		expect(await resolveCompanySecret(root, "nordea", fakeFetch)).toBe("access-3");
		expect(seenRefreshTokens).toEqual(["refresh-1", "refresh-2"]);
	});

	it("fails closed when the token endpoint rejects the refresh", async () => {
		bindCompanySecret(root, "oauth", {
			kind: "oauth2",
			accessToken: "stale-token",
			refreshToken: "refresh-1",
			tokenUrl: "https://auth.example.com/token",
			expiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		const rejectingFetch: typeof fetch = async () => new Response("denied", { status: 400 });
		await expect(resolveCompanySecret(root, "oauth", rejectingFetch)).rejects.toThrow(/refresh failed/);
	});
});

describe("agent routines", () => {
	const staffAgentId = "6ba7b810-9dad-4d1d-80b4-00c04fd430c8";
	const schedule = (intervalMinutes: number) => [{ kind: "schedule" as const, intervalMinutes }];

	it("migrates the founder-bound wake into a named scheduled job", () => {
		const path = companyConnectionsPath(root);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				root,
				destinations: [],
				secrets: {},
				wake: { intervalMinutes: 10, enabled: true },
			})}\n`,
			"utf-8",
		);
		const jobs = readScheduledJobs(root);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			id: DEFAULT_SCHEDULED_JOB_ID,
			title: "Company orchestration",
			enabled: true,
			effort: "high",
		});
		expect(scheduledJobIntervalMinutes(jobs[0])).toBe(10);
		expect(jobs[0].prompt).toContain("owned artifacts");
		expect(Object.hasOwn(jobs[0], "staffAgentId")).toBe(false);
	});

	it("persists explicit staff ownership and supports returning a job to Unassigned", () => {
		const job = createScheduledJob(root, {
			title: "Morning digest",
			prompt: "Prepare the founder's morning digest.",
			triggers: schedule(60),
			staffAgentId,
		});
		expect(readScheduledJobs(root)).toEqual([job]);
		expect(job.staffAgentId).toBe(staffAgentId);
		expect(job.effort).toBe("high");

		const unassigned = updateScheduledJob(root, job.id, { staffAgentId: null });
		expect(Object.hasOwn(unassigned, "staffAgentId")).toBe(false);
		expect(Object.hasOwn(readScheduledJobs(root)[0], "staffAgentId")).toBe(false);
	});

	it("idempotently creates and updates an agent-owned routine by stable key", () => {
		const created = upsertStaffScheduledJob(root, staffAgentId, "weekly-financial-review", {
			title: "Weekly financial review",
			prompt: "Refresh the financial-health artifact.",
			triggers: schedule(7 * 24 * 60),
		});
		expect(created).toMatchObject({
			agentKey: "weekly-financial-review",
			staffAgentId,
			effort: "high",
			enabled: true,
		});
		const updated = upsertStaffScheduledJob(root, staffAgentId, "weekly-financial-review", {
			title: "Weekly cash review",
			prompt: "Refresh cash, burn, and runway.",
			triggers: schedule(24 * 60),
			effort: "xhigh",
		});
		expect(updated.id).toBe(created.id);
		expect(updated).toMatchObject({ title: "Weekly cash review", effort: "xhigh" });
		expect(scheduledJobIntervalMinutes(updated)).toBe(24 * 60);
		expect(readScheduledJobs(root)).toHaveLength(1);
		expect(findStaffScheduledJob(root, staffAgentId, "weekly-financial-review")?.id).toBe(created.id);
	});

	it("scopes the same routine key independently to each agent", () => {
		const otherStaffAgentId = "7ca7b810-9dad-4d1d-80b4-00c04fd430c9";
		const input = {
			title: "Daily review",
			prompt: "Review owned measures.",
			triggers: schedule(24 * 60),
		};
		const first = upsertStaffScheduledJob(root, staffAgentId, "daily-review", input);
		const second = upsertStaffScheduledJob(root, otherStaffAgentId, "daily-review", input);
		expect(first.id).not.toBe(second.id);
		expect(readScheduledJobs(root)).toHaveLength(2);
	});

	it("runs every routine in the cloud and migrates retired placements on read", () => {
		const job = createScheduledJob(root, {
			title: "Cloud digest",
			prompt: "Prepare the digest in the hosted environment.",
			triggers: schedule(60),
		});
		expect(job.placement).toBe("cloud");
		expect(updateScheduledJob(root, job.id, { placement: "cloud" }).placement).toBe("cloud");
		for (const retired of ["local", "requires-local", "invalid"]) {
			expect(() => updateScheduledJob(root, job.id, { placement: retired as "cloud" })).toThrow(/placement/);
		}

		const path = join(root, ".qorpera", "routines", `${job.id}.json`);
		const state = JSON.parse(readFileSync(path, "utf-8")) as { placement?: string };
		delete state.placement;
		writeFileSync(path, JSON.stringify(state), "utf-8");
		expect(readScheduledJobs(root)[0].placement).toBe("cloud");
		expect(readScheduledJobs(root)[0].publication).toEqual({ mode: "automatic" });
		for (const retired of ["local", "requires-local"]) {
			writeFileSync(path, JSON.stringify({ ...state, placement: retired }), "utf-8");
			expect(readScheduledJobs(root)[0].placement).toBe("cloud");
		}
	});

	it("preserves founder-set placement across agent routine upserts", () => {
		const created = upsertStaffScheduledJob(root, staffAgentId, "weekly-digest", {
			title: "Weekly digest",
			prompt: "Prepare the digest.",
			triggers: schedule(7 * 24 * 60),
		});
		updateScheduledJob(root, created.id, { placement: "cloud" });
		const upserted = upsertStaffScheduledJob(root, staffAgentId, "weekly-digest", {
			title: "Weekly digest v2",
			prompt: "Prepare the improved digest.",
			triggers: schedule(24 * 60),
		});
		expect(upserted.placement).toBe("cloud");
		expect(
			upsertStaffScheduledJob(root, staffAgentId, "weekly-digest", {
				title: "Weekly digest v3",
				prompt: "Prepare the digest again.",
				triggers: schedule(24 * 60),
				placement: "cloud",
			}).placement,
		).toBe("cloud");
	});

	it("publishes operational routines automatically unless reviewers are explicitly configured", () => {
		const reviewer = "7ca7b810-9dad-4d1d-80b4-00c04fd430c9";
		const created = upsertStaffScheduledJob(root, staffAgentId, "directional-analysis", {
			title: "Directional analysis",
			prompt: "Prepare the recommendation.",
			triggers: schedule(24 * 60),
		});
		expect(created.publication).toEqual({ mode: "automatic" });
		const reviewed = updateScheduledJob(root, created.id, {
			publication: { mode: "review", reviewerStaffIds: [reviewer] },
		});
		expect(reviewed.publication).toEqual({ mode: "review", reviewerStaffIds: [reviewer] });
		expect(
			upsertStaffScheduledJob(root, staffAgentId, "directional-analysis", {
				title: "Directional analysis v2",
				prompt: "Prepare the revised recommendation.",
				triggers: schedule(24 * 60),
			}).publication,
		).toEqual(reviewed.publication);
	});

	it("migrates existing scheduled jobs to high effort", () => {
		createScheduledJob(root, {
			title: "Morning digest",
			prompt: "Prepare the founder's morning digest.",
			triggers: schedule(60),
			effort: "low",
		});
		const path = join(root, ".qorpera", "routines", `${readScheduledJobs(root)[0].id}.json`);
		const state = JSON.parse(readFileSync(path, "utf-8")) as { effort?: string };
		delete state.effort;
		writeFileSync(path, JSON.stringify(state), "utf-8");

		expect(readScheduledJobs(root)[0].effort).toBe("high");
	});

	it("rejects invalid staff ownership without guessing an assignment", () => {
		expect(() =>
			createScheduledJob(root, {
				title: "Morning digest",
				prompt: "Prepare the founder's morning digest.",
				triggers: schedule(60),
				staffAgentId: "staff-night-shift",
			}),
		).toThrow(/staffAgentId must be a lowercase UUID v4/);
		expect(readScheduledJobs(root)).toEqual([]);
	});

	it("fails closed on invalid persisted staff ownership", () => {
		createScheduledJob(root, {
			title: "Morning digest",
			prompt: "Prepare the founder's morning digest.",
			triggers: schedule(60),
			staffAgentId,
		});
		const path = join(root, ".qorpera", "routines", `${readScheduledJobs(root)[0].id}.json`);
		const state = JSON.parse(readFileSync(path, "utf-8")) as { staffAgentId?: string };
		state.staffAgentId = "not-a-staff-identity";
		writeFileSync(path, JSON.stringify(state), "utf-8");

		expect(() => readScheduledJobs(root)).toThrow(/staffAgentId must be a lowercase UUID v4/);
	});

	it("creates, edits, pauses, resumes, and deletes independent scheduled jobs", () => {
		const job = createScheduledJob(root, {
			title: "Reliability sweep",
			prompt: "Inspect the reliability dashboard and repair the highest-impact issue.",
			triggers: schedule(15),
		});
		expect(readScheduledJobs(root)).toEqual([job]);
		expect(job.effort).toBe("high");
		const paused = updateScheduledJob(root, job.id, { enabled: false, triggers: schedule(30), effort: "low" });
		expect(paused.enabled).toBe(false);
		expect(paused.effort).toBe("low");
		expect(scheduledJobIntervalMinutes(paused)).toBe(30);
		const resumed = updateScheduledJob(root, job.id, { enabled: true, title: "Reliability review" });
		expect(resumed).toMatchObject({ enabled: true, title: "Reliability review" });
		expect(() => createScheduledJob(root, { title: "Too fast", prompt: "Run", triggers: schedule(1) })).toThrow(
			/ceiling/,
		);
		expect(deleteScheduledJob(root, job.id)).toBe(true);
		expect(deleteScheduledJob(root, job.id)).toBe(false);
		expect(readScheduledJobs(root)).toEqual([]);
	});

	it("persists advanced interval windows with calendar filters", () => {
		const job = createScheduledJob(root, {
			title: "Office-hours review",
			prompt: "Review the queue during office hours.",
			triggers: [
				{
					kind: "schedule",
					intervalMinutes: 30,
					months: [2, 5],
					weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
					windowStart: "09:00",
					windowEnd: "17:00",
					timeZone: "Europe/Copenhagen",
				},
			],
		});
		expect(readScheduledJobs(root)[0].triggers[0]).toMatchObject({
			intervalMinutes: 30,
			months: [2, 5],
			weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
			windowStart: "09:00",
			windowEnd: "17:00",
			timeZone: "Europe/Copenhagen",
		});
		expect(() =>
			updateScheduledJob(root, job.id, {
				triggers: [
					{
						kind: "schedule",
						intervalMinutes: 30,
						windowStart: "17:00",
						windowEnd: "09:00",
						timeZone: "Europe/Copenhagen",
					},
				],
			}),
		).toThrow(/windowStart/);
		expect(() =>
			updateScheduledJob(root, job.id, {
				triggers: [
					{
						kind: "schedule",
						intervalMinutes: 30,
						windowStart: "09:00",
						windowEnd: "17:00",
						timeZone: "auto",
					},
				],
			}),
		).toThrow(/IANA timezone/);
	});

	it("persists an anchored weekday interval", () => {
		const startAt = "2026-08-24T09:00:00.000Z";
		const job = createScheduledJob(root, {
			title: "Weekday review",
			prompt: "Review the weekday queue.",
			triggers: [
				{
					kind: "schedule",
					intervalMinutes: 24 * 60,
					startAt,
					weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
					localTime: "09:00",
					timeZone: "Europe/Copenhagen",
				},
			],
		});
		expect(job.triggers[0]).toMatchObject({
			intervalMinutes: 24 * 60,
			startAt,
			weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
			localTime: "09:00",
			timeZone: "Europe/Copenhagen",
		});
		expect(readScheduledJobs(root)[0].triggers[0]).toEqual(job.triggers[0]);
	});

	it("keeps a kernel suspension until the founder explicitly resumes the job", () => {
		const job = createScheduledJob(root, {
			title: "Reliability sweep",
			prompt: "Inspect reliability.",
			triggers: schedule(15),
		});
		suspendScheduledJob(root, job.id, "3 consecutive wake failures");
		expect(updateScheduledJob(root, job.id, { title: "Reliability review" }).suspendedReason).toContain("failures");
		expect(updateScheduledJob(root, job.id, { enabled: true }).suspendedReason).toBeUndefined();
	});
});

describe("webhook binding (optional kernel module)", () => {
	it("is off by default; enable mints a stable token; disable keeps it for re-enable", () => {
		expect(readWebhookBinding(root)).toBeUndefined();
		const first = enableWebhook(root, 4900);
		expect(first.enabled).toBe(true);
		expect(first.port).toBe(4900);
		expect(first.token.length).toBeGreaterThan(10);
		expect(disableWebhook(root)).toBe(true);
		expect(readWebhookBinding(root)?.enabled).toBe(false);
		// Re-enabling keeps the token AND the port: bound provider URLs stay valid.
		const reEnabled = enableWebhook(root);
		expect(reEnabled.token).toBe(first.token);
		expect(reEnabled.port).toBe(4900);
		expect(() => enableWebhook(root, 99_999_999)).toThrow(/Invalid webhook port/);
	});

	it("persists the port the kernel actually bound", () => {
		enableWebhook(root);
		expect(readWebhookBinding(root)?.port).toBeUndefined();
		expect(persistWebhookPort(root, 51_234)?.port).toBe(51_234);
		expect(readWebhookBinding(root)?.port).toBe(51_234);
		// A disabled binding is left alone: nothing should listen for it.
		disableWebhook(root);
		expect(persistWebhookPort(root, 52_000)?.port).toBe(51_234);
		expect(readWebhookBinding(root)?.port).toBe(51_234);
	});
});
