import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acceptReviewedCloudCompanyExecution,
	bindCloudCompanyExecution,
	createCloudCompanyExecutionCheckout,
	discardCleanCloudCompanyExecution,
	listRecoverableCloudCompanyExecutions,
	promoteCloudCompanyExecution,
	quarantineCloudCompanyExecution,
	recoverableCloudCompanyExecutions,
	rejectReviewedCloudCompanyExecution,
} from "../src/cloud-company-execution.ts";

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "20000000-0000-4000-8000-000000000002";
const CLAIMANT_ID = "30000000-0000-4000-8000-000000000003";
const roots: string[] = [];

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgSign=false", "-C", root, ...args], {
		encoding: "utf-8",
		windowsHide: true,
	}).trim();
}

function fixture(): { userData: string; companyRoot: string } {
	const base = mkdtempSync(join(tmpdir(), "qorpera-company-execution-"));
	roots.push(base);
	const userData = join(base, "user-data");
	const companyRoot = join(base, "company");
	mkdirSync(companyRoot, { recursive: true });
	git(companyRoot, "init");
	writeFileSync(join(companyRoot, "analysis.md"), "base\n", "utf-8");
	writeFileSync(join(companyRoot, "operations.md"), "base\n", "utf-8");
	writeFileSync(join(companyRoot, ".gitignore"), "*.tmp\n", "utf-8");
	git(companyRoot, "add", "--all");
	git(companyRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
	return { userData, companyRoot };
}

function commitCanonical(companyRoot: string, path: string, contents: string): void {
	writeFileSync(join(companyRoot, path), contents, "utf-8");
	git(companyRoot, "add", "--", path);
	git(
		companyRoot,
		"-c",
		"user.name=Founder",
		"-c",
		"user.email=founder@example.com",
		"commit",
		"-m",
		"canonical edit",
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloud Company File execution checkouts", () => {
	it("promotes a settled proposal without overwriting a concurrent unrelated canonical change", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({ userData, profileId: PROFILE_ID, companyRoot });
		bindCloudCompanyExecution(checkout, { kind: "turn", id: EXECUTION_ID, claimantId: CLAIMANT_ID });
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "agent\n", "utf-8");
		writeFileSync(join(checkout.checkoutRoot, "research.tmp"), "ignored but company-owned\n", "utf-8");
		commitCanonical(companyRoot, "operations.md", "founder\n");

		await expect(promoteCloudCompanyExecution(checkout)).resolves.toMatchObject({ status: "promoted" });
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("agent\n");
		expect(readFileSync(join(companyRoot, "operations.md"), "utf-8")).toBe("founder\n");
		expect(readFileSync(join(companyRoot, "research.tmp"), "utf-8")).toBe("ignored but company-owned\n");
	});

	it("retains a same-path conflict as a reviewable proposal without changing canonical bytes", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({ userData, profileId: PROFILE_ID, companyRoot });
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "agent\n", "utf-8");
		commitCanonical(companyRoot, "analysis.md", "founder\n");

		await expect(promoteCloudCompanyExecution(checkout)).resolves.toMatchObject({ status: "requires_review" });
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("founder\n");
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(1);
		const [review] = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		if (!review) throw new Error("reviewable execution was not listed");
		writeFileSync(join(review.checkoutRoot, "analysis.md"), "reviewed combined result\n", "utf-8");
		await acceptReviewedCloudCompanyExecution(review);
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("reviewed combined result\n");
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(0);
	});

	it("quarantines crash output without exposing it in the canonical Company File", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({ userData, profileId: PROFILE_ID, companyRoot });
		bindCloudCompanyExecution(checkout, { kind: "wake", id: EXECUTION_ID, claimantId: CLAIMANT_ID });
		writeFileSync(join(checkout.checkoutRoot, "analysis.md"), "partial\n", "utf-8");

		await expect(quarantineCloudCompanyExecution(checkout)).resolves.toMatchObject({
			proposalHead: expect.any(String),
		});
		expect(readFileSync(join(companyRoot, "analysis.md"), "utf-8")).toBe("base\n");
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(1);
		const [review] = listRecoverableCloudCompanyExecutions(userData, PROFILE_ID);
		if (!review) throw new Error("quarantined execution was not listed");
		await rejectReviewedCloudCompanyExecution(review);
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(0);
	});

	it("removes an owned clean checkout", async () => {
		const { userData, companyRoot } = fixture();
		const checkout = createCloudCompanyExecutionCheckout({ userData, profileId: PROFILE_ID, companyRoot });
		await discardCleanCloudCompanyExecution(checkout);
		expect(recoverableCloudCompanyExecutions(userData, PROFILE_ID)).toBe(0);
		expect(() => readFileSync(checkout.statePath, "utf-8")).toThrow();
	});
});
