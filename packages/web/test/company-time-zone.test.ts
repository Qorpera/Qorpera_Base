// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { memberTimeZone, rememberTimeZoneRefused, timeZoneRefused } from "../src/app/company-time-zone.ts";
import { CloudApi } from "../src/cloud/api.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { parseCompanyTimeZone, parseTeam } from "../src/cloud/parse.ts";
import type { SessionInputWriter } from "../src/cloud/session-input.ts";
import type { HostedProfileTeam } from "../src/cloud/types.ts";
import { deferred, fixture, profileA, settle, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
/** What the browser reports as the device's zone, while a test stands in for it. */
let reported: { zone: string | undefined } | undefined;
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	localStorage.clear();
	reported = undefined;
	vi.restoreAllMocks();
});

/** The device's zone, as the browser reports it (nothing: a browser that reports none). */
function device(zone: string | undefined): void {
	if (reported) {
		reported.zone = zone;
		return;
	}
	const now = { zone };
	reported = now;
	const real = Intl.DateTimeFormat.prototype.resolvedOptions;
	vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
		return { ...real.call(this), timeZone: now.zone as string };
	});
}

/** A company whose team read answers `read`, with what was handed in for it. */
function company(read: HostedProfileTeam, answer: () => Promise<string> = async () => "Europe/Copenhagen") {
	const f = fixture();
	vi.mocked(f.api.getTeam).mockResolvedValue(read);
	const ensure = vi.spyOn(f.api, "ensureCompanyTimeZone").mockImplementation(answer);
	const controller = new CompanyController(f.api, profileA, userA.id, vi.fn<SessionInputWriter>());
	cleanup.push(() => controller.stop());
	return { ...f, controller, ensure };
}
const unknown: HostedProfileTeam = { ...team, timeZone: null };

describe("a company's time zone comes from a member's browser (20260930739000)", () => {
	it("hands the device's zone in once when the company has none, and keeps the company's answer", async () => {
		device("Europe/Copenhagen");
		const f = company(unknown);
		await f.controller.refreshTeam();
		await settle();
		expect(f.ensure.mock.calls).toEqual([[profileA.profileId, "Europe/Copenhagen"]]);
		expect(f.controller.store.get().team?.timeZone).toBe("Europe/Copenhagen");
		// Nothing shows, and no later read hands it in again: not while the cloud still says none, not once it says it.
		expect(f.controller.store.get().error).toBeUndefined();
		await f.controller.refreshTeam();
		vi.mocked(f.api.getTeam).mockResolvedValue({ ...team, timeZone: "Europe/Copenhagen" });
		await f.controller.refreshTeam();
		await settle();
		expect(f.ensure).toHaveBeenCalledOnce();
	});

	it("keeps the zone an earlier member's browser gave, when the cloud answers that one", async () => {
		device("America/New_York");
		const f = company(unknown, async () => "Europe/Copenhagen");
		await f.controller.refreshTeam();
		await settle();
		expect(f.ensure.mock.calls).toEqual([[profileA.profileId, "America/New_York"]]);
		expect(f.controller.store.get().team?.timeZone).toBe("Europe/Copenhagen");
	});

	it("hands in the zone the member chose to see times in, when this browser keeps one", async () => {
		device("America/New_York");
		localStorage.setItem("qorpera.web.time-zone", "Asia/Tokyo");
		expect(memberTimeZone()).toBe("Asia/Tokyo");
		const f = company(unknown, async () => "Asia/Tokyo");
		await f.controller.refreshTeam();
		await settle();
		expect(f.ensure.mock.calls).toEqual([[profileA.profileId, "Asia/Tokyo"]]);
	});

	it("asks nothing of a company that has a zone, of a cloud that says nothing of one, or for a viewer", async () => {
		device("Europe/Copenhagen");
		for (const read of [
			{ ...team, timeZone: "America/New_York" },
			// A cloud from before the migration: its team read has no such key.
			team,
			{
				...unknown,
				role: "viewer" as const,
				capabilities: { read: true as const, write: false, authorize: false, manageMembers: false },
			},
		]) {
			const f = company(read);
			await f.controller.refreshTeam();
			await f.controller.refreshTeam();
			await settle();
			expect(f.ensure).not.toHaveBeenCalled();
			expect(f.controller.store.get().team?.timeZone).toBe(read.timeZone);
		}
	});

	it("hands in nothing when the browser reports no zone, or a word that is no zone's name", async () => {
		for (const zone of [undefined, "", "Etc/Unknown\n", "../etc/passwd", "a/b/c/d", "A".repeat(65)]) {
			device(zone);
			expect(memberTimeZone()).toBeUndefined();
			const f = company(unknown);
			await f.controller.refreshTeam();
			await settle();
			expect(f.ensure).not.toHaveBeenCalled();
		}
		// The names a browser reports are taken as they are.
		for (const zone of [
			"UTC",
			"Europe/Copenhagen",
			"America/Argentina/Buenos_Aires",
			"Etc/GMT+2",
			"America/Port-au-Prince",
		]) {
			device(zone);
			expect(memberTimeZone()).toBe(zone);
		}
	});

	it("remembers a zone the cloud refused, so this browser does not hand the same word in again", async () => {
		device("Mars/Olympus_Mons");
		const refused = async () => {
			throw new CloudRpcError(
				"qorpera_ensure_company_time_zone",
				{ message: "Time zone is unknown", code: "22023" },
				400,
			);
		};
		const first = company(unknown, refused);
		await first.controller.refreshTeam();
		await first.controller.refreshTeam();
		await settle();
		expect(first.ensure).toHaveBeenCalledOnce();
		expect(first.controller.store.get().team?.timeZone).toBeNull();
		expect(first.controller.store.get().error).toBeUndefined();
		expect(timeZoneRefused(profileA.profileId, "Mars/Olympus_Mons")).toBe(true);
		// The next load of the app: the same word is not handed in again.
		const second = company(unknown, refused);
		await second.controller.refreshTeam();
		await settle();
		expect(second.ensure).not.toHaveBeenCalled();
		// Another zone (the device moved, or the member chose one) is handed in.
		device("Europe/Copenhagen");
		const third = company(unknown);
		await third.controller.refreshTeam();
		await settle();
		expect(third.ensure.mock.calls).toEqual([[profileA.profileId, "Europe/Copenhagen"]]);
	});

	it("leaves a call that failed otherwise: nothing shows, nothing is remembered, and this open asks no more", async () => {
		device("Europe/Copenhagen");
		for (const error of [
			new CloudRpcError("qorpera_ensure_company_time_zone", { message: "missing", code: "PGRST202" }, 404),
			new CloudRpcError(
				"qorpera_ensure_company_time_zone",
				{ message: "Company is unavailable", code: "42501" },
				403,
			),
			new TypeError("Failed to fetch"),
		]) {
			const f = company(unknown, async () => {
				throw error;
			});
			await f.controller.refreshTeam();
			await f.controller.refreshTeam();
			await settle();
			expect(f.ensure).toHaveBeenCalledOnce();
			expect(f.controller.store.get().error).toBeUndefined();
			expect(f.controller.store.get().accessLost).toBe(false);
			expect(f.controller.store.get().team?.timeZone).toBeNull();
			expect(timeZoneRefused(profileA.profileId, "Europe/Copenhagen")).toBe(false);
		}
	});

	it("writes nothing into a company that was closed while the answer was on its way", async () => {
		device("Europe/Copenhagen");
		const answer = deferred<string>();
		const f = company(unknown, () => answer.promise);
		await f.controller.refreshTeam();
		const set = vi.spyOn(f.controller.store, "set");
		f.controller.stop();
		answer.resolve("Europe/Copenhagen");
		await settle();
		expect(
			set.mock.calls.filter(([patch]) => typeof patch === "object" && patch !== null && "team" in patch),
		).toEqual([]);
	});

	it("keeps a refusal per company and word, and works without the browser's storage", () => {
		rememberTimeZoneRefused(profileA.profileId, "Mars/Olympus_Mons");
		expect(timeZoneRefused(profileA.profileId, "Mars/Olympus_Mons")).toBe(true);
		expect(timeZoneRefused(profileA.profileId, "Europe/Copenhagen")).toBe(false);
		expect(timeZoneRefused("11111111-1111-4111-8111-000000000099", "Mars/Olympus_Mons")).toBe(false);
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(() => rememberTimeZoneRefused(profileA.profileId, "Europe/Copenhagen")).not.toThrow();
		expect(timeZoneRefused(profileA.profileId, "Mars/Olympus_Mons")).toBe(false);
	});
});

describe("the cloud's words about a company's time zone", () => {
	const wire = {
		profile_id: profileA.profileId,
		role: "contributor",
		capabilities: { read: true, write: true, authorize: false },
		members: [],
		invitations: [],
	};

	it("reads the team's zone: a name, none yet, or a cloud that says nothing of it", () => {
		expect(parseTeam({ ...wire, time_zone: "Europe/Copenhagen" }).timeZone).toBe("Europe/Copenhagen");
		expect(parseTeam({ ...wire, time_zone: null }).timeZone).toBeNull();
		expect("timeZone" in parseTeam(wire)).toBe(false);
		// Anything else is no answer about it: the company is not asked for one.
		for (const value of ["", 7, {}, [], true])
			expect("timeZone" in parseTeam({ ...wire, time_zone: value })).toBe(false);
	});

	it("reads the answer of a hand-in, and refuses one without a zone", () => {
		expect(
			parseCompanyTimeZone({ schema: "qorpera.company-time-zone/v1", timeZone: "Europe/Copenhagen", taken: true }),
		).toBe("Europe/Copenhagen");
		for (const value of [null, "Europe/Copenhagen", [], {}, { timeZone: null }, { timeZone: "" }, { timeZone: 7 }])
			expect(() => parseCompanyTimeZone(value)).toThrow("invalid company time zone");
	});

	it("calls the cloud with the company and the word", async () => {
		const rpc = vi.fn(async () => ({
			schema: "qorpera.company-time-zone/v1",
			timeZone: "Europe/Copenhagen",
			taken: false,
		}));
		const api = new CloudApi({ rpc } as unknown as Cloud);
		expect(await api.ensureCompanyTimeZone(profileA.profileId, "America/New_York")).toBe("Europe/Copenhagen");
		expect(rpc.mock.calls).toEqual([
			["qorpera_ensure_company_time_zone", { p_profile_id: profileA.profileId, p_time_zone: "America/New_York" }],
		]);
		expect(() => api.ensureCompanyTimeZone("not-a-company", "Europe/Copenhagen")).toThrow(
			"Profile id must be a UUID",
		);
	});
});
