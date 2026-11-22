import { describe, expect, it } from "vitest";
import {
	codeChecksPlan,
	codeChecksWallBudget,
	expandCodeCheckNeeds,
	filterCodeChecksByPaths,
	matchCheckGlob,
	parseCheckFailureArtifacts,
	parseCodeChecksBytes,
	parseCodeChecksText,
	parseJunitXmlFailedTests,
	parseTapFailedTests,
	parseVitestJsonFailedTests,
} from "../src/cloud-code-checks.ts";

describe("cloud-code-checks canonical parser and v2 schema", () => {
	it("accepts 7 parallel 600s DAG checks by critical path and enforces 7200s total CPU cap", () => {
		const sevenParallel = parseCodeChecksText(
			JSON.stringify({
				checks: Array.from({ length: 7 }, (_, i) => ({
					name: `p${i}`,
					run: `echo ${i}`,
					timeoutSeconds: 600,
					needs: [],
				})),
			}),
		);
		expect(sevenParallel.ok).toBe(true);
		if (sevenParallel.ok) {
			expect(sevenParallel.mode).toBe("dag");
			expect(sevenParallel.criticalPathSeconds).toBe(600);
			expect(sevenParallel.totalTimeoutSeconds).toBe(4200);
		}

		const thirteenParallel = parseCodeChecksText(
			JSON.stringify({
				checks: Array.from({ length: 13 }, (_, i) => ({
					name: `p${i}`,
					run: `echo ${i}`,
					timeoutSeconds: 600,
					needs: [],
				})),
			}),
		);
		expect(thirteenParallel.ok).toBe(false);
		if (!thirteenParallel.ok) {
			expect(thirteenParallel.problems).toEqual([
				{
					at: "/checks",
					code: "TOO_LONG",
					message: "The time limits add up to 7800 s; total check CPU time may be at most 7200 s.",
				},
			]);
		}

		const longChain = parseCodeChecksText(
			JSON.stringify({
				checks: [
					{ name: "a", run: "true", timeoutSeconds: 1800, needs: [] },
					{ name: "b", run: "true", timeoutSeconds: 1800, needs: ["a"] },
					{ name: "c", run: "true", timeoutSeconds: 10, needs: ["b"] },
				],
			}),
		);
		expect(longChain.ok).toBe(false);
		if (!longChain.ok) {
			expect(longChain.problems[0]?.code).toBe("TOO_LONG");
			expect(longChain.problems[0]?.message).toContain("critical-path time limit is 3610 s");
		}

		const retryCritical = parseCodeChecksText(
			JSON.stringify({
				checks: [{ name: "flaky", run: "true", timeoutSeconds: 1800, retries: 2, needs: [] }],
			}),
		);
		expect(retryCritical.ok).toBe(false);
		if (!retryCritical.ok) {
			expect(retryCritical.problems[0]?.code).toBe("TOO_LONG");
			expect(retryCritical.problems[0]?.message).toContain("critical-path time limit is 5400 s");
		}

		const retryCpuCap = parseCodeChecksText(
			JSON.stringify({
				checks: Array.from({ length: 5 }, (_, i) => ({
					name: `p${i}`,
					run: "true",
					timeoutSeconds: 600,
					retries: 2,
					needs: [],
				})),
			}),
		);
		expect(retryCpuCap.ok).toBe(false);
		if (!retryCpuCap.ok) {
			expect(retryCpuCap.problems[0]?.code).toBe("TOO_LONG");
			expect(retryCpuCap.problems[0]?.message).toContain("add up to 9000 s");
		}

		const retryWithinCap = parseCodeChecksText(
			JSON.stringify({
				checks: [{ name: "ok", run: "true", timeoutSeconds: 1200, retries: 2, needs: [] }],
			}),
		);
		expect(retryWithinCap.ok).toBe(true);
		if (retryWithinCap.ok) {
			expect(retryWithinCap.criticalPathSeconds).toBe(3600);
			expect(retryWithinCap.totalTimeoutSeconds).toBe(3600);
		}
	});

	it("parses and validates v2 top-level and per-check fields", () => {
		const raw = JSON.stringify({
			maxParallel: 6,
			failFast: false,
			caches: [
				{
					key: `pnpm-\${hash('pnpm-lock.yaml')}`,
					paths: ["node_modules", "apps/web/.next/cache"],
					restoreKeys: ["pnpm-"],
				},
			],
			checks: [
				{
					name: "install",
					run: "pnpm install --frozen-lockfile",
					needs: [],
					exclusive: true,
					retries: 2,
					alwaysRun: true,
					env: { NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1" },
					secrets: ["NPM_TOKEN"],
				},
				{
					name: "unit",
					run: "pnpm test",
					needs: ["install"],
					paths: ["src/**/*.{ts,tsx}", "package.json"],
					pathsIgnore: ["**/*.md"],
					artifacts: {
						paths: ["reports/junit*.xml"],
						when: "on_failure",
						format: "junit",
					},
				},
			],
		});
		const parsed = parseCodeChecksBytes(new TextEncoder().encode(raw));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.maxParallel).toBe(6);
			expect(parsed.failFast).toBe(false);
			expect(parsed.caches).toEqual([
				{
					key: `pnpm-\${hash('pnpm-lock.yaml')}`,
					paths: ["node_modules", "apps/web/.next/cache"],
					restoreKeys: ["pnpm-"],
				},
			]);
			expect(parsed.checks[0]).toMatchObject({
				name: "install",
				exclusive: true,
				retries: 2,
				alwaysRun: true,
				env: { NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1" },
				secrets: ["NPM_TOKEN"],
			});
			expect(parsed.checks[1]?.artifacts).toEqual({
				paths: ["reports/junit*.xml"],
				when: "on_failure",
				format: "junit",
			});
		}

		const serverSite = parseCodeChecksText(
			JSON.stringify({
				site: {
					kind: "server",
					name: "my-app",
					title: "My App",
					dockerfile: "Dockerfile",
					port: 3000,
					healthPath: "/healthz",
					idleTimeoutSec: 300,
					memoryMb: 512,
					vcpuLimit: 1.5,
					spaFallback: null,
				},
				checks: [{ name: "test", run: "npm test" }],
			}),
		);
		expect(serverSite.ok).toBe(true);
		if (serverSite.ok) {
			expect(serverSite.site).toEqual({
				folder: ".",
				name: "my-app",
				title: "My App",
				kind: "server",
				dockerfile: "Dockerfile",
				port: 3000,
				healthPath: "/healthz",
				idleTimeoutSec: 300,
				memoryMb: 512,
				vcpuLimit: 1.5,
				spaFallback: null,
			});
		}
	});

	it("rejects invalid v2 fields including traversal, .git paths, and reserved env names", () => {
		const bad = parseCodeChecksText(
			JSON.stringify({
				maxParallel: 9,
				failFast: "no",
				caches: [
					{
						key: "../escape",
						paths: ["../outside", ".git/objects", ".qorpera", ".qorpera/checks.json"],
						restoreKeys: ["hash('../secret')"],
					},
				],
				checks: [
					{
						name: "test",
						run: "npm test",
						exclusive: 1,
						retries: 3,
						paths: ["/abs/path", "a/../b"],
						pathsIgnore: [],
						alwaysRun: "yes",
						env: { PATH: "/tmp", QORPERA_FOO: "1", GIT_DIR: "/x", LD_PRELOAD: "/x", CARGO_HOME: "/x" },
						secrets: ["QORPERA_TOKEN", "bad-name"],
						artifacts: { paths: [".git/HEAD"], when: "never", format: "xml" },
					},
				],
			}),
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			const codes = bad.problems.map((p) => `${p.code} ${p.at}`);
			expect(codes).toContain("INVALID_VALUE /maxParallel");
			expect(codes).toContain("WRONG_TYPE /failFast");
			expect(codes).toContain("INVALID_VALUE /caches/0/key");
			expect(codes).toContain("INVALID_PATH /caches/0/paths/0");
			expect(codes).toContain("INVALID_PATH /caches/0/paths/1");
			expect(codes).toContain("INVALID_PATH /caches/0/paths/2");
			expect(codes).toContain("INVALID_PATH /caches/0/paths/3");
			expect(codes).toContain("INVALID_VALUE /caches/0/restoreKeys/0");
			expect(codes).toContain("WRONG_TYPE /checks/0/exclusive");
			expect(codes).toContain("INVALID_VALUE /checks/0/retries");
			expect(codes).toContain("INVALID_PATH /checks/0/paths/0");
			expect(codes).toContain("INVALID_PATH /checks/0/paths/1");
			expect(codes).toContain("INVALID_VALUE /checks/0/pathsIgnore");
			expect(codes).toContain("WRONG_TYPE /checks/0/alwaysRun");
			expect(codes).toContain("INVALID_VALUE /checks/0/env/PATH");
			expect(codes).toContain("INVALID_VALUE /checks/0/env/QORPERA_FOO");
			expect(codes).toContain("INVALID_VALUE /checks/0/env/GIT_DIR");
			expect(codes).toContain("INVALID_VALUE /checks/0/env/LD_PRELOAD");
			expect(codes).toContain("INVALID_VALUE /checks/0/env/CARGO_HOME");
			expect(codes).toContain("INVALID_VALUE /checks/0/secrets/0");
			expect(codes).toContain("INVALID_VALUE /checks/0/secrets/1");
			expect(codes).toContain("INVALID_PATH /checks/0/artifacts/paths/0");
			expect(codes).toContain("INVALID_VALUE /checks/0/artifacts/when");
			expect(codes).toContain("INVALID_VALUE /checks/0/artifacts/format");
		}
	});
});

describe("DAG budget, transitive needs, and path filtering", () => {
	it("computes DAG makespan accounting for parallelism, exclusive steps, and retries", () => {
		const checks = [
			{ name: "install", run: "npm ci", timeoutSeconds: 100, cwd: ".", needs: [], exclusive: true },
			{ name: "a", run: "a", timeoutSeconds: 200, cwd: ".", needs: ["install"] },
			{ name: "b", run: "b", timeoutSeconds: 200, cwd: ".", needs: ["install"], retries: 1 },
			{ name: "c", run: "c", timeoutSeconds: 200, cwd: ".", needs: ["install"] },
		];
		const plan = codeChecksPlan(checks)!;
		const budget2 = codeChecksWallBudget(checks, plan, 2);
		expect(budget2.wallSeconds).toBe(500);
		const budget4 = codeChecksWallBudget(checks, plan, 4);
		expect(budget4.wallSeconds).toBe(500);
	});

	it("expands transitive needs in original check order", () => {
		const checks = [
			{ name: "install", run: "npm ci", timeoutSeconds: 60, cwd: ".", needs: [] },
			{ name: "lint", run: "npm run lint", timeoutSeconds: 60, cwd: ".", needs: ["install"] },
			{ name: "test", run: "npm test", timeoutSeconds: 60, cwd: ".", needs: ["install"] },
			{ name: "build", run: "npm run build", timeoutSeconds: 60, cwd: ".", needs: ["lint", "test"] },
			{ name: "extra", run: "echo extra", timeoutSeconds: 60, cwd: ".", needs: [] },
		];
		const expanded = expandCodeCheckNeeds(checks, ["build"]);
		expect(expanded.selected.map((c) => c.name)).toEqual(["install", "lint", "test", "build"]);
		expect(expanded.autoIncluded).toEqual(["install", "lint", "test"]);
	});

	it("matches globs and enforces checks-file and unavailable-diff bypass safety invariants", () => {
		expect(matchCheckGlob("packages/**/src/*.{ts,tsx}", "packages/web/src/app.tsx")).toBe(true);
		expect(matchCheckGlob("packages/**/src/*.{ts,tsx}", "packages/web/src/app.css")).toBe(false);
		expect(matchCheckGlob("src/a?c/[0-9].txt", "src/abc/5.txt")).toBe(true);
		expect(matchCheckGlob("src/a?c/[!0-9].txt", "src/abc/5.txt")).toBe(false);

		const checks = [
			{
				name: "web",
				run: "npm test",
				timeoutSeconds: 60,
				cwd: ".",
				paths: ["web/**"],
				pathsIgnore: ["web/**/*.md"],
			},
			{ name: "api", run: "npm test", timeoutSeconds: 60, cwd: ".", paths: ["api/**"] },
			{ name: "always", run: "npm run smoke", timeoutSeconds: 60, cwd: ".", paths: ["api/**"], alwaysRun: true },
			{ name: "global", run: "npm run lint", timeoutSeconds: 60, cwd: "." },
		];

		const docsOnly = filterCodeChecksByPaths(checks, ["web/README.md"], false);
		expect([...docsOnly.entries()]).toEqual([
			["web", "paths_unmatched"],
			["api", "paths_unmatched"],
		]);

		const webCode = filterCodeChecksByPaths(checks, ["web/src/index.ts"], false);
		expect([...webCode.entries()]).toEqual([["api", "paths_unmatched"]]);

		const quotedWeb = filterCodeChecksByPaths(checks, ['web/a"b".html'], false);
		expect([...quotedWeb.entries()]).toEqual([["api", "paths_unmatched"]]);

		expect(filterCodeChecksByPaths(checks, ["web/README.md"], true).size).toBe(0);
		expect(filterCodeChecksByPaths(checks, undefined, false).size).toBe(0);
		expect(filterCodeChecksByPaths(checks, [".qorpera/checks.json", "web/README.md"], false).size).toBe(0);
	});
});

describe("structured failure artifact parsers", () => {
	it("parses JUnit XML failures and errors with entities and CDATA", () => {
		const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="math.test.ts" file="/home/qorpera-200001/.qorpera-checks/001/src/tests/math.test.ts">
    <testcase classname="math" name="adds" />
    <testcase classname="math" name="divides &amp; rounds" line="42">
      <failure message="Expected 2 &lt; 1">stack line</failure>
    </testcase>
    <testcase name="throws">
      <error><![CDATA[TypeError: boom\n  at foo.ts:10]]></error>
    </testcase>
  </testsuite>
</testsuites>`;
		expect(parseJunitXmlFailedTests(xml)).toEqual([
			{
				suite: "math",
				name: "divides & rounds",
				file: "tests/math.test.ts",
				line: 42,
				message: "Expected 2 < 1",
			},
			{
				suite: "math.test.ts",
				name: "throws",
				file: "tests/math.test.ts",
				message: "TypeError: boom | at foo.ts:10",
			},
		]);
	});

	it("parses TAP failures with YAML blocks and skips TODO/SKIP", () => {
		const tap = [
			"TAP version 14",
			"# Subtest: auth suite",
			"ok 1 - passes",
			"not ok 2 - rejects bad token",
			"  ---",
			"  message: 'Expected 401'",
			"  at: src/auth.test.ts:19:5",
			"  ...",
			"not ok 3 - skipped # SKIP not ready",
			"not ok 4 - plain comment fail",
			"  # failed on line 8",
		].join("\n");
		expect(parseTapFailedTests(tap)).toEqual([
			{
				suite: "auth suite",
				name: "rejects bad token",
				file: "src/auth.test.ts",
				line: 19,
				message: "Expected 401",
			},
			{
				suite: "auth suite",
				name: "plain comment fail",
				message: "failed on line 8",
			},
		]);
	});

	it("parses Vitest JSON failures and aggregates across formats", () => {
		const vitestJson = JSON.stringify({
			testResults: [
				{
					name: "/home/u/.qorpera-checks/001/src/packages/app/cart.test.ts",
					assertionResults: [
						{ status: "passed", title: "ok" },
						{
							status: "failed",
							ancestorTitles: ["Cart", "totals"],
							title: "applies discount",
							location: { line: 88 },
							failureMessages: ["AssertionError: expected 90 to be 80\n    at cart.test.ts:88"],
						},
					],
				},
			],
		});
		expect(parseVitestJsonFailedTests(vitestJson)).toEqual([
			{
				suite: "Cart > totals",
				name: "applies discount",
				file: "packages/app/cart.test.ts",
				line: 88,
				message: "AssertionError: expected 90 to be 80 | at cart.test.ts:88",
			},
		]);
		expect(
			parseCheckFailureArtifacts([
				{ format: "raw", content: "ignored" },
				{ format: "vitest-json", content: vitestJson },
			]),
		).toHaveLength(1);
	});
});
