import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostJob,
	type CodeHostShell,
	startCodeArea,
	undoCodeChange,
} from "../src/code-host-jobs.ts";
import {
	CodeHostChangeConflict,
	cherryPickChangeUnits,
	composePreviewTree,
	ensureSurfaceStarterRepository,
	inspectChangeRange,
	rebaseSessionChanges,
} from "../src/code-host-surfaces.ts";
import { readSurfacePreviewRecipe } from "../src/surface-preview-runner.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile);
const GIT = "/usr/bin/git";
const roots: string[] = [];

// WHY: macOS keeps coreutils in /bin, lacks GNU mv -T, and ships Apple Git 2.39; adapt only in this test shell.
function crossPlatformLocalShell(log: CodeHostCommand[]): CodeHostShell {
	const inner = localShell(log);
	return {
		run(command, signal) {
			let argv = [...command.argv];
			const bin = argv[0];
			if (bin?.startsWith("/usr/bin/") && !existsSync(bin)) {
				const alt = `/bin/${bin.slice("/usr/bin/".length)}`;
				if (existsSync(alt)) argv[0] = alt;
			}
			if (process.platform === "darwin") {
				if (argv[0] === GIT && argv.includes("--ref-format=files")) {
					argv = argv.filter((arg) => arg !== "--ref-format=files");
				}
				if (
					(argv[0] === "/bin/sh" || argv[0] === "/usr/bin/sh") &&
					argv[1] === "-c" &&
					typeof argv[2] === "string"
				) {
					argv[2] = argv[2].replaceAll("mv -fT ", "mv -f ");
				}
			}
			return inner.run({ ...command, argv }, signal);
		},
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

async function keptFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-surfaces-")));
	roots.push(root);
	const companyRoot = join(root, "folder");
	const scratchRoot = join(root, "scratch");
	await mkdir(companyRoot, { recursive: true });
	await mkdir(scratchRoot, { recursive: true });
	const log: CodeHostCommand[] = [];
	const job: CodeHostJob = {
		shell: crossPlatformLocalShell(log),
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const repository = { host: "qorpera" as const, owner: "thetaband", name: "website", baseBranch: "main" };
	const started = await startCodeArea(job, { repository });
	const code = join(companyRoot, "code/thetaband/website");
	const repo = join(code, "repo.git");
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Session",
		GIT_AUTHOR_EMAIL: "session@example.invalid",
		GIT_COMMITTER_NAME: "Session",
		GIT_COMMITTER_EMAIL: "session@example.invalid",
	};

	const git = async (cwd: string, ...args: string[]) => (await exec(GIT, args, { cwd, env })).stdout.trim();
	const startSession = async (baseSha = started.baseSha) => {
		const workerId = randomUUID();
		await addCodeWorktree(job, { repository, workerId, baseSha });
		const worktree = join(code, "worktrees", workerId);
		const commit = async (files: Record<string, string>, message: string) => {
			for (const [filePath, content] of Object.entries(files)) {
				await mkdir(dirname(join(worktree, filePath)), { recursive: true });
				await writeFile(join(worktree, filePath), content);
			}
			await git(worktree, "add", "--all");
			await git(worktree, "commit", "--quiet", "-m", message);
			return git(worktree, "rev-parse", "HEAD");
		};
		return { workerId, worktree, commit };
	};

	return { job, repository, baseSha: started.baseSha, code, repo, git, startSession };
}

describe("code-host surfaces multi-change engine", () => {
	it("cherry-picks one ChangeUnit from a multi-change session, rebases sibling ChangeUnit, and supports undo", async () => {
		const f = await keptFixture();
		const s = await f.startSession();
		const c1Id = randomUUID();
		const c2Id = randomUUID();

		const c1Head = await s.commit({ "faq.html": "<section>Danish FAQ</section>\n" }, "Add FAQ");
		const c2Head = await s.commit({ "hero.css": ".hero { padding: 48px; }\n" }, "Tune hero padding");

		const range1 = await inspectChangeRange(f.job, {
			repository: f.repository,
			workerId: s.workerId,
			parentSha: f.baseSha,
			headSha: c1Head,
		});
		expect(range1.affectedPaths).toEqual(["faq.html"]);
		expect(range1.diffStats).toEqual({ filesChanged: 1, additions: 1, deletions: 0 });

		const landed1 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: f.baseSha,
			changes: [{ changeId: c1Id, parentSha: f.baseSha, headSha: c1Head, title: "Add Danish FAQ" }],
		});
		expect(landed1.mainBefore).toBe(f.baseSha);
		expect(landed1.diff.paths).toEqual(["faq.html"]);
		expect(await readFile(join(f.code, "main/faq.html"), "utf8")).toBe("<section>Danish FAQ</section>\n");
		expect(await exists(join(f.code, "main/hero.css"))).toBe(false);

		const rebased = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: s.workerId,
			ontoSha: landed1.mainAfter,
			updateBranchRef: true,
			remainingChanges: [{ changeId: c2Id, parentSha: c1Head, headSha: c2Head, title: "Tune hero padding" }],
		});
		expect(rebased.status).toBe("clean");
		if (rebased.status !== "clean") throw new Error("expected clean rebase");
		expect(rebased.rebasedChanges).toHaveLength(1);
		const rebasedC2 = rebased.rebasedChanges[0]!;
		expect(rebasedC2.parentSha).toBe(landed1.mainAfter);

		const landed2 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: landed1.mainAfter,
			changes: [
				{
					changeId: c2Id,
					parentSha: rebasedC2.parentSha,
					headSha: rebasedC2.headSha,
					title: "Tune hero padding",
				},
			],
		});
		expect(await readFile(join(f.code, "main/hero.css"), "utf8")).toBe(".hero { padding: 48px; }\n");

		const undone = await undoCodeChange(f.job, {
			repository: f.repository,
			requestId: randomUUID(),
			change: { n: 2, mainBefore: landed2.mainBefore, mainAfter: landed2.mainAfter },
			andLater: true,
			message: "Undo Tune hero padding",
		});
		expect(undone.state).toBe("undone");
		expect(await exists(join(f.code, "main/hero.css"))).toBe(false);
		expect(await readFile(join(f.code, "main/faq.html"), "utf8")).toBe("<section>Danish FAQ</section>\n");
	}, 20_000);

	it("rebases clean peer sessions and reports exact conflict paths on overlapping peer sessions", async () => {
		const f = await keptFixture();
		const seed = await f.startSession();
		const seededHead = await seed.commit({ "pricing.html": "<h1>1.995 kr.</h1>\n" }, "Seed pricing");
		const initial = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seededHead, title: "Seed pricing" }],
		});

		const sessionA = await f.startSession(initial.mainAfter);
		const sessionB = await f.startSession(initial.mainAfter);
		const sessionC = await f.startSession(initial.mainAfter);

		const headA = await sessionA.commit({ "pricing.html": "<h1>1.895 kr. inkl. moms</h1>\n" }, "Update price A");
		const headB = await sessionB.commit({ "footer.html": "<footer>Thetaband ApS</footer>\n" }, "Add footer");
		const headC = await sessionC.commit({ "pricing.html": "<h1>2.195 kr.</h1>\n" }, "Update price C");

		const landedA = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: initial.mainAfter, headSha: headA, title: "Update price A" }],
		});

		const rebasedB = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: sessionB.workerId,
			ontoSha: landedA.mainAfter,
			remainingChanges: [
				{ changeId: randomUUID(), parentSha: initial.mainAfter, headSha: headB, title: "Add footer" },
			],
		});
		expect(rebasedB.status).toBe("clean");

		const conflictId = randomUUID();
		const rebasedC = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: sessionC.workerId,
			ontoSha: landedA.mainAfter,
			remainingChanges: [
				{ changeId: conflictId, parentSha: initial.mainAfter, headSha: headC, title: "Update price C" },
			],
		});
		expect(rebasedC.status).toBe("conflicted");
		if (rebasedC.status !== "conflicted") throw new Error("expected conflict");
		expect(rebasedC.conflictedChangeId).toBe(conflictId);
		expect(rebasedC.conflictPaths).toEqual(["pricing.html"]);

		await expect(
			cherryPickChangeUnits(f.job, {
				repository: f.repository,
				changes: [{ changeId: conflictId, parentSha: initial.mainAfter, headSha: headC, title: "Update price C" }],
			}),
		).rejects.toThrow(CodeHostChangeConflict);
	}, 20_000);

	it("composes an exploration plus multiple toggled ChangeUnits without mutating main and detects toggle conflicts", async () => {
		const f = await keptFixture();
		const seed = await f.startSession();
		const seededHead = await seed.commit({ "index.html": "<main>Base</main>\n" }, "Base site");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seededHead, title: "Base site" }],
		});

		const exploreAftenlys = await f.startSession(base.mainAfter);
		const aftenlysHead = await exploreAftenlys.commit({ "theme.css": ":root { --bg: #141210; }\n" }, "Aftenlys");

		const sessFaq = await f.startSession(base.mainAfter);
		const faqId = randomUUID();
		const faqHead = await sessFaq.commit({ "faq.html": "<dl>FAQ</dl>\n" }, "FAQ");

		const sessFooter = await f.startSession(base.mainAfter);
		const footerId = randomUUID();
		const footerHead = await sessFooter.commit({ "footer.html": "<footer>DK</footer>\n" }, "Footer");

		const preview = await composePreviewTree(f.job, {
			repository: f.repository,
			baseSha: base.mainAfter,
			exploration: { sessionId: exploreAftenlys.workerId, baseSha: base.mainAfter, headSha: aftenlysHead },
			changes: [
				{ changeId: faqId, parentSha: base.mainAfter, headSha: faqHead },
				{ changeId: footerId, parentSha: base.mainAfter, headSha: footerHead },
			],
			previewRefId: "ab12cd34",
		});

		expect(preview.status).toBe("ready");
		if (preview.status !== "ready") throw new Error("expected ready composite preview");
		expect(preview.appliedChangeIds).toEqual([faqId, footerId]);
		expect(preview.previewRef).toBe("refs/qorpera/previews/ab12cd34");

		const previewFiles = (await f.git(f.repo, "--git-dir=.", "ls-tree", "--name-only", preview.compositeTreeSha))
			.split("\n")
			.sort();
		expect(previewFiles).toEqual(["faq.html", "footer.html", "index.html", "theme.css"]);
		expect(await f.git(f.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(base.mainAfter);

		const sessHero1 = await f.startSession(base.mainAfter);
		const hero1Id = randomUUID();
		const hero1Head = await sessHero1.commit({ "index.html": "<main>Headline A</main>\n" }, "Headline A");

		const sessHero2 = await f.startSession(base.mainAfter);
		const hero2Id = randomUUID();
		const hero2Head = await sessHero2.commit({ "index.html": "<main>Headline B</main>\n" }, "Headline B");

		const conflicted = await composePreviewTree(f.job, {
			repository: f.repository,
			baseSha: base.mainAfter,
			changes: [
				{ changeId: hero1Id, parentSha: base.mainAfter, headSha: hero1Head },
				{ changeId: hero2Id, parentSha: base.mainAfter, headSha: hero2Head },
			],
		});
		expect(conflicted.status).toBe("conflicted");
		if (conflicted.status !== "conflicted") throw new Error("expected preview conflict");
		expect(conflicted.appliedChangeIds).toEqual([hero1Id]);
		expect(conflicted.conflictingChangeId).toBe(hero2Id);
		expect(conflicted.conflictPaths).toEqual(["index.html"]);
	}, 20_000);

	it("auto-scaffolds greenfield starter repositories idempotently with fast preview checks.json", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-starter-")));
		roots.push(root);
		const companyRoot = join(root, "folder");
		const scratchRoot = join(root, "scratch");
		await mkdir(companyRoot, { recursive: true });
		await mkdir(scratchRoot, { recursive: true });
		const log: CodeHostCommand[] = [];
		const job: CodeHostJob = {
			shell: crossPlatformLocalShell(log),
			layout: { companyRoot, scratchRoot, git: GIT },
			signal: new AbortController().signal,
		};
		const repository = { host: "qorpera" as const, owner: "surfaces", name: "website", baseBranch: "main" };

		const created = await ensureSurfaceStarterRepository(job, {
			repository,
			title: "Thetaband & Co",
			slug: "website",
		});
		expect(created.status).toBe("created");
		expect(created.mainSha).toMatch(/^[0-9a-f]{40}$/);

		const mainDir = join(companyRoot, "code/surfaces/website/main");
		const html = await readFile(join(mainDir, "index.html"), "utf8");
		const identityCss = await readFile(join(mainDir, "qorpera-identity.css"), "utf8");
		const css = await readFile(join(mainDir, "styles.css"), "utf8");
		const checksText = await readFile(join(mainDir, ".qorpera/checks.json"), "utf8");
		expect(html).toContain("Thetaband &amp; Co");
		expect(html).toContain('<link rel="stylesheet" href="./qorpera-identity.css" />');
		expect(html).toContain('<link rel="stylesheet" href="./styles.css" />');
		expect(html.indexOf("./qorpera-identity.css")).toBeLessThan(html.indexOf("./styles.css"));
		expect(identityCss).toContain(":root {");
		expect(identityCss).toContain("--q-color-surface: #ffffff;");
		expect(identityCss).toContain("--q-color-ink: #161615;");
		expect(identityCss).toContain("--q-color-muted: #6b6966;");
		expect(identityCss).toContain("--q-color-accent: #d76f45;");
		expect(identityCss).toContain("--q-font-heading:");
		expect(identityCss).toContain("--q-font-body:");
		expect(css).toContain("var(--q-color-surface)");
		expect(css).toContain("var(--q-color-ink)");
		expect(css).toContain("var(--q-color-accent)");
		expect(css).toContain("var(--q-color-muted)");
		expect(css).toContain("var(--q-font-body)");
		expect(css).toContain("var(--q-font-heading)");
		expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
		expect(readSurfacePreviewRecipe(checksText)).toEqual({ kind: "none" });

		const repeated = await ensureSurfaceStarterRepository(job, { repository, title: "Ignored" });
		expect(repeated.status).toBe("existing");
		expect(repeated.mainSha).toBe(created.mainSha);

		const preview = await composePreviewTree(job, {
			repository,
			baseSha: created.mainSha,
			changes: [],
			previewRefId: "11223344",
		});
		expect(preview.status).toBe("ready");
	}, 20_000);
});
