import { describe, expect, it } from "vitest";
import {
	parseCloudCodingBranch,
	parseCloudCodingPullRequest,
	parseCloudCodingRepository,
	parseGitHubCodingRepository,
} from "../src/cloud-coding.ts";

const repository = () => ({ host: "github.com" as const, owner: "Qorpera", name: "app", baseBranch: "main" });
const pullRequest = () => ({
	url: "https://github.com/Qorpera/app/pull/12",
	number: 12,
	headSha: "a".repeat(40),
});

describe("coding repository and branch destinations", () => {
	it.each(["main", "release/2026.09", "qorpera/worker-1"])("accepts safe Git ref %s", (branch) => {
		expect(parseCloudCodingBranch(branch)).toBe(branch);
	});
	it.each([
		"-main",
		"main..other",
		"main^",
		"main~1",
		"@",
		"main@{1}",
		"refs//head",
		"x/.hidden",
		"x.lock",
		"x.lock/head",
		"x.",
		"x/",
		"x:y",
		"x\ny",
		"a".repeat(201),
	])("rejects unsafe Git ref %s", (baseBranch) => {
		expect(() => parseCloudCodingRepository({ ...repository(), baseBranch })).toThrow();
	});
	it.each([
		{ host: "github.com.evil.example" },
		{ host: "github.com:443" },
		{ owner: "../other" },
		{ owner: "-option" },
		{ name: "../app" },
		{ name: "app?token=secret" },
		{ name: "app.git/other" },
		{ url: "https://github.com/Qorpera/app" },
	])("rejects ambiguous repository %j", (change) => {
		expect(() => parseCloudCodingRepository({ ...repository(), ...change })).toThrow();
	});
});

describe("coding pull request contract", () => {
	it("copies and freezes a valid publication receipt", () => {
		const result = parseCloudCodingPullRequest(pullRequest(), repository());
		expect(result).toEqual(pullRequest());
		expect(Object.isFrozen(result)).toBe(true);
	});
	it.each([
		"https://github.com/Other/app/pull/12",
		"https://github.com/Qorpera/other/pull/12",
		"https://github.com/Qorpera/app/pull/13",
		"https://github.com/Qorpera/app/pull/012",
		"https://github.com/Qorpera/app/pull/12?token=secret",
		"https://github.com/Qorpera/app/pull/12#comment",
		"https://github.com@evil.example/Qorpera/app/pull/12",
		"http://github.com/Qorpera/app/pull/12",
	])("rejects PR outside the exact repository and number %s", (url) => {
		expect(() => parseCloudCodingPullRequest({ ...pullRequest(), url }, repository())).toThrow();
	});
	it.each([{ headSha: "a".repeat(7) }, { headSha: "A".repeat(40) }, { number: 0 }, { token: "secret" }])(
		"rejects ambiguous publication receipt %j",
		(change) => {
			expect(() => parseCloudCodingPullRequest({ ...pullRequest(), ...change }, repository())).toThrow();
		},
	);
});

describe("a repository kept in Qorpera (own code storage, slice 1)", () => {
	const kept = { host: "qorpera", owner: "company", name: "shop", baseBranch: "main" };
	it("names a folder: lower case only, never ending with a dot", () => {
		expect(parseCloudCodingRepository(kept)).toEqual(kept);
		expect(Object.isFrozen(parseCloudCodingRepository(kept))).toBe(true);
		expect(parseCloudCodingRepository({ ...kept, owner: "web-2", name: "shop_v2.app" }).name).toBe("shop_v2.app");
		for (const bad of [
			{ ...kept, owner: "Company" },
			{ ...kept, name: "Shop" },
			{ ...kept, name: "shop." },
			{ ...kept, owner: "-company" },
			{ ...kept, name: ".shop" },
			{ ...kept, host: "gitlab.com" },
			// One repository, one default branch (review 1544 r1 F2): never another branch of the same repository.
			{ ...kept, baseBranch: "master" },
			{ ...kept, baseBranch: "dev" },
		])
			expect(() => parseCloudCodingRepository(bad)).toThrow("INVALID_CODING_REPOSITORY");
		// GitHub's own rules are unchanged: mixed case and a trailing dot.
		expect(parseCloudCodingRepository({ ...repository(), name: "App." }).name).toBe("App.");
	});
	it("never reaches a GitHub step, and has no pull request", () => {
		expect(() => parseGitHubCodingRepository(kept)).toThrow("INVALID_CODING_REPOSITORY");
		expect(parseGitHubCodingRepository(repository())).toEqual(repository());
		expect(() =>
			parseCloudCodingPullRequest(
				{ url: "https://github.com/company/shop/pull/1", number: 1, headSha: "a".repeat(40) },
				parseCloudCodingRepository(kept),
			),
		).toThrow("INVALID_CODING_PULL_REQUEST");
	});
});
