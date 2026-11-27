import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostJob,
	CodeHostRefusal,
	type CodeHostShell,
	startCodeArea,
	undoCodeChange,
} from "../src/code-host-jobs.ts";
import {
	CodeHostChangeConflict,
	cherryPickChangeUnits,
	composePreviewTree,
	discardSurfaceSessionWorktree,
	ensureSurfaceStarterRepository,
	inspectChangeRange,
	rebaseSessionChanges,
	verifyStagedSurfaceBranch,
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

	return { job, log, repository, baseSha: started.baseSha, code, repo, git, startSession };
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

	it("previews, rebases, and lands isolated single-session option groups without cross-option bleed or conflicts", async () => {
		const f = await keptFixture();
		const seed = await f.startSession();
		const seededHead = await seed.commit({ "index.html": "<main>Base</main>\n" }, "Seed base");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seededHead, title: "Seed base" }],
		});

		const s = await f.startSession(base.mainAfter);
		const opt1Id = randomUUID();
		const opt2Id = randomUUID();
		const opt3Id = randomUUID();

		const opt1Head = await s.commit(
			{ "index.html": "<main>Option 1: Broker</main>\n", "opt1.css": ".a { color: #111; }\n" },
			"Option 1",
		);
		await f.git(s.worktree, "read-tree", "--reset", "-u", base.mainAfter);
		const opt2Head = await s.commit(
			{ "index.html": "<main>Option 2: Showcase</main>\n", "opt2.css": ".b { color: #222; }\n" },
			"Option 2",
		);
		await f.git(s.worktree, "read-tree", "--reset", "-u", base.mainAfter);
		const opt3Head = await s.commit(
			{ "index.html": "<main>Option 3: Trading desk</main>\n", "opt3.css": ".c { color: #333; }\n" },
			"Option 3",
		);

		const previewOpt2 = await composePreviewTree(f.job, {
			repository: f.repository,
			baseSha: base.mainAfter,
			changes: [{ changeId: opt2Id, parentSha: base.mainAfter, headSha: opt2Head }],
		});
		expect(previewOpt2.status).toBe("ready");
		if (previewOpt2.status !== "ready") throw new Error("expected ready preview for option 2");
		const preview2Files = (await f.git(f.repo, "--git-dir=.", "ls-tree", "--name-only", previewOpt2.compositeTreeSha))
			.split("\n")
			.sort();
		expect(preview2Files).toEqual(["index.html", "opt2.css"]);
		expect(await f.git(f.repo, "--git-dir=.", "show", `${previewOpt2.compositeTreeSha}:index.html`)).toBe(
			"<main>Option 2: Showcase</main>",
		);

		const peer = await f.startSession(base.mainAfter);
		const peerHead = await peer.commit({ "footer.html": "<footer>Brooks ApS</footer>\n" }, "Add footer");
		const main2 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: base.mainAfter,
			changes: [{ changeId: randomUUID(), parentSha: base.mainAfter, headSha: peerHead, title: "Add footer" }],
		});

		const rebased = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: s.workerId,
			ontoSha: main2.mainAfter,
			updateBranchRef: true,
			remainingChanges: [
				{
					changeId: opt1Id,
					parentSha: base.mainAfter,
					headSha: opt1Head,
					title: "Option 1",
					optionGroupKey: "concept",
				},
				{
					changeId: opt2Id,
					parentSha: base.mainAfter,
					headSha: opt2Head,
					title: "Option 2",
					optionGroupKey: "concept",
				},
				{
					changeId: opt3Id,
					parentSha: base.mainAfter,
					headSha: opt3Head,
					title: "Option 3",
					optionGroupKey: "concept",
				},
			],
		});
		expect(rebased.status).toBe("clean");
		if (rebased.status !== "clean") throw new Error("expected clean option-group rebase");
		expect(rebased.rebasedChanges).toHaveLength(3);
		for (const item of rebased.rebasedChanges) {
			expect(item.parentSha).toBe(main2.mainAfter);
		}
		const rebasedOpt2 = rebased.rebasedChanges[1]!;
		const rebasedOpt3 = rebased.rebasedChanges[2]!;

		const previewOpt3 = await composePreviewTree(f.job, {
			repository: f.repository,
			baseSha: main2.mainAfter,
			changes: [{ changeId: opt3Id, parentSha: rebasedOpt3.parentSha, headSha: rebasedOpt3.headSha }],
		});
		expect(previewOpt3.status).toBe("ready");
		if (previewOpt3.status !== "ready") throw new Error("expected ready preview for rebased option 3");
		const preview3Files = (await f.git(f.repo, "--git-dir=.", "ls-tree", "--name-only", previewOpt3.compositeTreeSha))
			.split("\n")
			.sort();
		expect(preview3Files).toEqual(["footer.html", "index.html", "opt3.css"]);

		const landed = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: main2.mainAfter,
			changes: [
				{
					changeId: opt2Id,
					parentSha: rebasedOpt2.parentSha,
					headSha: rebasedOpt2.headSha,
					title: "Option 2",
				},
			],
		});
		expect(landed.mainBefore).toBe(main2.mainAfter);
		expect(await readFile(join(f.code, "main/index.html"), "utf8")).toBe("<main>Option 2: Showcase</main>\n");
		expect(await exists(join(f.code, "main/opt2.css"))).toBe(true);
		expect(await exists(join(f.code, "main/opt1.css"))).toBe(false);
		expect(await exists(join(f.code, "main/opt3.css"))).toBe(false);
		expect(await readFile(join(f.code, "main/footer.html"), "utf8")).toBe("<footer>Brooks ApS</footer>\n");
	}, 20_000);

	it("stress-tests 4-option groups across 3 sequential main landings, file deletions, conflicts, and post-pick follow-up steering", async () => {
		const f = await keptFixture();
		const seed = await f.startSession();
		const seededHead = await seed.commit(
			{
				"index.html": "<main>Base</main>\n",
				"legacy.css": ".legacy { display: block; }\n",
				"shared.css": "body { margin: 0; }\n.hero { color: #000; }\n",
			},
			"Seed multi-file base",
		);
		const m0 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seededHead, title: "Seed base" }],
		});

		const s = await f.startSession(m0.mainAfter);
		const optIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;

		const c1 = await s.commit(
			{
				"index.html": "<main>Option 1</main>\n",
				"assets/opt1/style.css": ".opt1 { gap: 8px; }\n",
			},
			"Option 1",
		);
		await f.git(s.worktree, "read-tree", "--reset", "-u", m0.mainAfter);
		const c2 = await s.commit(
			{
				"index.html": "<main>Option 2</main>\n",
				"assets/opt2/style.css": ".opt2 { gap: 16px; }\n",
				"components/opt2/hero.js": "export const hero = 2;\n",
			},
			"Option 2",
		);
		await f.git(s.worktree, "read-tree", "--reset", "-u", m0.mainAfter);
		await rm(join(s.worktree, "legacy.css"));
		const c3 = await s.commit(
			{
				"index.html": "<main>Option 3</main>\n",
				"assets/opt3/style.css": ".opt3 { gap: 24px; }\n",
			},
			"Option 3 (deletes legacy.css)",
		);
		await f.git(s.worktree, "read-tree", "--reset", "-u", m0.mainAfter);
		const c4 = await s.commit(
			{
				"index.html": "<main>Option 4</main>\n",
				"shared.css": "body { margin: 0; }\n.hero { color: #f00; }\n",
			},
			"Option 4",
		);

		let currentMain = m0.mainAfter;
		let tracked = [
			{ changeId: optIds[0], parentSha: currentMain, headSha: c1, title: "Option 1", optionGroupKey: "dir" },
			{ changeId: optIds[1], parentSha: currentMain, headSha: c2, title: "Option 2", optionGroupKey: "dir" },
			{ changeId: optIds[2], parentSha: currentMain, headSha: c3, title: "Option 3", optionGroupKey: "dir" },
			{ changeId: optIds[3], parentSha: currentMain, headSha: c4, title: "Option 4", optionGroupKey: "dir" },
		];

		for (let round = 1; round <= 3; round++) {
			const peer = await f.startSession(currentMain);
			const peerHead = await peer.commit({ [`peer-${round}.txt`]: `round ${round}\n` }, `Peer landing ${round}`);
			const landedPeer = await cherryPickChangeUnits(f.job, {
				repository: f.repository,
				expectMainSha: currentMain,
				changes: [{ changeId: randomUUID(), parentSha: currentMain, headSha: peerHead, title: `Peer ${round}` }],
			});
			currentMain = landedPeer.mainAfter;
			const rebased = await rebaseSessionChanges(f.job, {
				repository: f.repository,
				workerId: s.workerId,
				ontoSha: currentMain,
				updateBranchRef: true,
				remainingChanges: tracked,
			});
			expect(rebased.status).toBe("clean");
			if (rebased.status !== "clean") throw new Error(`expected clean rebase round ${round}`);
			tracked = rebased.rebasedChanges.map((item, idx) => ({
				...tracked[idx]!,
				parentSha: item.parentSha,
				headSha: item.headSha,
			}));
			for (const item of tracked) expect(item.parentSha).toBe(currentMain);
		}

		for (const [idx, expectedUnique, expectLegacy] of [
			[0, "assets/opt1/style.css", true],
			[1, "components/opt2/hero.js", true],
			[2, "assets/opt3/style.css", false],
			[3, "shared.css", true],
		] as const) {
			const opt = tracked[idx]!;
			const preview = await composePreviewTree(f.job, {
				repository: f.repository,
				baseSha: currentMain,
				changes: [{ changeId: opt.changeId, parentSha: opt.parentSha, headSha: opt.headSha }],
			});
			expect(preview.status).toBe("ready");
			if (preview.status !== "ready") throw new Error(`expected ready preview for option ${idx + 1}`);
			const allPaths = (
				await f.git(f.repo, "--git-dir=.", "ls-tree", "-r", "--name-only", preview.compositeTreeSha)
			).split("\n");
			expect(allPaths).toContain(expectedUnique);
			expect(allPaths).toContain("peer-1.txt");
			expect(allPaths).toContain("peer-2.txt");
			expect(allPaths).toContain("peer-3.txt");
			expect(allPaths.includes("legacy.css")).toBe(expectLegacy);
			for (let other = 1; other <= 3; other++) {
				if (other !== idx + 1) {
					expect(allPaths).not.toContain(`assets/opt${other}/style.css`);
				}
			}
			expect(await f.git(f.repo, "--git-dir=.", "show", `${preview.compositeTreeSha}:index.html`)).toBe(
				`<main>Option ${idx + 1}</main>`,
			);
		}

		const conflictPeer = await f.startSession(currentMain);
		const conflictPeerHead = await conflictPeer.commit(
			{ "shared.css": "body { margin: 0; }\n.hero { color: #00f; }\n" },
			"Conflicting hero color",
		);
		const mConflict = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: currentMain,
			changes: [
				{ changeId: randomUUID(), parentSha: currentMain, headSha: conflictPeerHead, title: "Conflicting hero" },
			],
		});
		const conflictRebase = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: s.workerId,
			ontoSha: mConflict.mainAfter,
			updateBranchRef: false,
			remainingChanges: tracked,
		});
		expect(conflictRebase.status).toBe("conflicted");
		if (conflictRebase.status !== "conflicted") throw new Error("expected conflict on option 4");
		expect(conflictRebase.conflictedChangeId).toBe(optIds[3]);
		expect(conflictRebase.conflictPaths).toEqual(["shared.css"]);

		const chosenOpt2 = tracked[1]!;
		const tipAtOpt4 = tracked[3]!.headSha;
		await f.git(s.worktree, "reset", "--hard", tipAtOpt4);
		await f.git(s.worktree, "read-tree", "--reset", "-u", chosenOpt2.headSha);
		const followUpId = randomUUID();
		const followUpHead = await s.commit(
			{
				"index.html": "<main>Option 2 — Refined CTA</main>\n",
				"cta.js": "export const cta = true;\n",
			},
			"Refine chosen option 2",
		);

		const rebasedChosen = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: s.workerId,
			ontoSha: mConflict.mainAfter,
			updateBranchRef: true,
			allowedBranchTips: [followUpHead],
			remainingChanges: [
				{
					changeId: chosenOpt2.changeId,
					parentSha: chosenOpt2.parentSha,
					headSha: chosenOpt2.headSha,
					title: "Opt 2",
				},
				{ changeId: followUpId, parentSha: chosenOpt2.headSha, headSha: followUpHead, title: "Refine CTA" },
			],
		});
		expect(rebasedChosen.status).toBe("clean");
		if (rebasedChosen.status !== "clean") throw new Error("expected clean rebase of chosen option + follow-up");
		expect(rebasedChosen.rebasedChanges).toHaveLength(2);
		const [rOpt2, rFollowUp] = rebasedChosen.rebasedChanges;
		expect(rOpt2!.parentSha).toBe(mConflict.mainAfter);
		expect(rFollowUp!.parentSha).toBe(rOpt2!.headSha);

		await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: mConflict.mainAfter,
			changes: [
				{ changeId: chosenOpt2.changeId, parentSha: rOpt2!.parentSha, headSha: rOpt2!.headSha, title: "Opt 2" },
				{ changeId: followUpId, parentSha: rFollowUp!.parentSha, headSha: rFollowUp!.headSha, title: "Refine CTA" },
			],
		});
		expect(await readFile(join(f.code, "main/index.html"), "utf8")).toBe("<main>Option 2 — Refined CTA</main>\n");
		expect(await readFile(join(f.code, "main/cta.js"), "utf8")).toBe("export const cta = true;\n");
		expect(await exists(join(f.code, "main/components/opt2/hero.js"))).toBe(true);
		expect(await exists(join(f.code, "main/assets/opt1/style.css"))).toBe(false);
		expect(await exists(join(f.code, "main/assets/opt3/style.css"))).toBe(false);
		expect(await readFile(join(f.code, "main/shared.css"), "utf8")).toBe(
			"body { margin: 0; }\n.hero { color: #00f; }\n",
		);
	}, 30_000);

	it("removes dirty discarded session worktree, git admin folder, and branch ref in two phases without affecting peers or main", async () => {
		const f = await keptFixture();
		const baseSha = f.baseSha;
		const discarded = await f.startSession(baseSha);
		const peer = await f.startSession(baseSha);

		await discarded.commit({ "draft.html": "<p>Unmerged change</p>\n" }, "Draft change");
		await writeFile(join(discarded.worktree, "index.html"), "<main>Dirty edit</main>\n");
		await writeFile(join(discarded.worktree, "untracked.txt"), "scratch\n");
		const peerHead = await peer.commit({ "peer.html": "<p>Keep peer</p>\n" }, "Peer change");

		const worktreeDir = join(f.code, "worktrees", discarded.workerId);
		const adminDir = join(f.repo, "worktrees", discarded.workerId);
		const discardedRef = `refs/heads/qorpera/coding/${discarded.workerId}`;
		expect(existsSync(worktreeDir)).toBe(true);
		expect(existsSync(adminDir)).toBe(true);

		const deferredGit = await discardSurfaceSessionWorktree(f.job, {
			repository: f.repository,
			workerId: discarded.workerId,
			phase: "git-folder",
		});
		expect(deferredGit).toEqual({ status: "files_still_there" });
		expect(existsSync(adminDir)).toBe(true);
		expect(await f.git(f.repo, "--git-dir=.", "rev-parse", discardedRef)).toMatch(/^[0-9a-f]{40}$/);

		const phase1 = await discardSurfaceSessionWorktree(f.job, {
			repository: f.repository,
			workerId: discarded.workerId,
			phase: "files",
		});
		expect(phase1).toEqual({
			status: "cleaned",
			removedWorktree: true,
			removedAdmin: false,
			deletedBranch: false,
		});
		expect(existsSync(worktreeDir)).toBe(false);
		expect(existsSync(adminDir)).toBe(true);

		const phase2 = await discardSurfaceSessionWorktree(f.job, {
			repository: f.repository,
			workerId: discarded.workerId,
			phase: "git-folder",
		});
		expect(phase2).toEqual({
			status: "cleaned",
			removedWorktree: false,
			removedAdmin: true,
			deletedBranch: true,
		});
		expect(existsSync(worktreeDir)).toBe(false);
		expect(existsSync(adminDir)).toBe(false);
		expect(await f.git(f.repo, "--git-dir=.", "for-each-ref", discardedRef)).toBe("");

		expect(await f.git(f.repo, "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(baseSha);
		expect(existsSync(peer.worktree)).toBe(true);
		expect(await f.git(f.repo, "--git-dir=.", "rev-parse", `refs/heads/qorpera/coding/${peer.workerId}`)).toBe(
			peerHead,
		);

		expect(
			await discardSurfaceSessionWorktree(f.job, {
				repository: f.repository,
				workerId: discarded.workerId,
				phase: "files",
			}),
		).toEqual({ status: "cleaned", removedWorktree: false, removedAdmin: false, deletedBranch: false });
		expect(
			await discardSurfaceSessionWorktree(f.job, {
				repository: f.repository,
				workerId: discarded.workerId,
				phase: "git-folder",
			}),
		).toEqual({ status: "cleaned", removedWorktree: false, removedAdmin: false, deletedBranch: false });

		const reopened = await addCodeWorktree(f.job, {
			repository: f.repository,
			workerId: discarded.workerId,
			baseSha,
			preferCurrentBase: true,
		});
		expect(reopened.state).toBe("added");
		expect(existsSync(worktreeDir)).toBe(true);
		expect(await f.git(f.repo, "--git-dir=.", "rev-parse", discardedRef)).toBe(baseSha);
	}, 20_000);

	it("handles unseeded repositories cleanly and refuses symlinks in discardSurfaceSessionWorktree", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-discard-edge-")));
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
		const repository = { host: "qorpera" as const, owner: "surfaces", name: "unseeded", baseBranch: "main" };
		const workerId = randomUUID();
		expect(await discardSurfaceSessionWorktree(job, { repository, workerId, phase: "files" })).toEqual({
			status: "unseeded",
		});

		const f = await keptFixture();
		const linkWorkerId = randomUUID();
		await mkdir(join(f.code, "worktrees"), { recursive: true });
		await symlink(join(f.code, "main"), join(f.code, "worktrees", linkWorkerId));
		await expect(
			discardSurfaceSessionWorktree(f.job, {
				repository: f.repository,
				workerId: linkWorkerId,
				phase: "files",
			}),
		).rejects.toSatisfy((error: unknown) => error instanceof CodeHostRefusal && error.code === "CODE_HOST_LINK");
	}, 20_000);

	it("inspects rebase worktrees without /usr/bin/find or full ls-tree -r while still blocking nested .git", async () => {
		const f = await keptFixture();
		const seed = await f.startSession();
		const seededHead = await seed.commit(
			{ ".gitignore": "node_modules/\n", "src/app.ts": "export const v = 1;\n" },
			"Seed src",
		);
		const m1 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seededHead, title: "Seed src" }],
		});

		const session = await f.startSession(m1.mainAfter);
		const changeId = randomUUID();
		const sessionHead = await session.commit({ "src/feature.ts": "export const f = 1;\n" }, "Feature");
		// WHY: Add a gitignored node_modules tree to prove rebase inspection avoids walking ignored FUSE trees with find.
		await mkdir(join(session.worktree, "node_modules/pkg"), { recursive: true });
		await writeFile(join(session.worktree, "node_modules/pkg/index.js"), "module.exports = 1;\n");

		const peer = await f.startSession(m1.mainAfter);
		const peerHead = await peer.commit({ "README.md": "hello\n" }, "Peer");
		const m2 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: m1.mainAfter,
			changes: [{ changeId: randomUUID(), parentSha: m1.mainAfter, headSha: peerHead, title: "Peer" }],
		});

		const logBefore = f.log.length;
		const rebased = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: session.workerId,
			ontoSha: m2.mainAfter,
			updateBranchRef: true,
			remainingChanges: [{ changeId, parentSha: m1.mainAfter, headSha: sessionHead, title: "Feature" }],
		});
		expect(rebased.status).toBe("clean");
		const rebaseCommands = f.log.slice(logBefore);
		expect(rebaseCommands.some((cmd) => cmd.argv[0]?.endsWith("/find") && cmd.argv.includes(session.worktree))).toBe(
			false,
		);
		expect(rebaseCommands.some((cmd) => cmd.argv.includes("ls-tree") && cmd.argv.includes("-r"))).toBe(false);

		await writeFile(join(session.worktree, "src/.git"), "gitdir: /tmp/evil\n");
		const peer2 = await f.startSession(m2.mainAfter);
		const peer2Head = await peer2.commit({ "NOTES.md": "notes\n" }, "Peer 2");
		const m3 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: m2.mainAfter,
			changes: [{ changeId: randomUUID(), parentSha: m2.mainAfter, headSha: peer2Head, title: "Peer 2" }],
		});
		const unsafe = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: session.workerId,
			ontoSha: m3.mainAfter,
			updateBranchRef: true,
			remainingChanges:
				rebased.status === "clean" ? rebased.rebasedChanges.map((c) => ({ ...c, title: "Feature" })) : [],
		});
		expect(unsafe).toMatchObject({ status: "deferred", reason: "worktree_unsafe" });
		await rm(join(session.worktree, "src/.git"));
		await mkdir(join(session.worktree, "src/.GIT"));
		const unsafeUpper = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: session.workerId,
			ontoSha: m3.mainAfter,
			updateBranchRef: true,
			remainingChanges:
				rebased.status === "clean" ? rebased.rebasedChanges.map((c) => ({ ...c, title: "Feature" })) : [],
		});
		expect(unsafeUpper).toMatchObject({ status: "deferred", reason: "worktree_unsafe" });
	}, 20_000);

	it("returns affectedPaths and diffStats from verifyStagedSurfaceBranch", async () => {
		const f = await keptFixture();
		const s = await f.startSession();
		const headSha = await s.commit(
			{
				"src/index.ts": "export const a = 1;\nexport const b = 2;\n",
				"src/styles.css": "body { margin: 0; }\n",
			},
			"Add app files",
		);
		const verified = await verifyStagedSurfaceBranch(f.job, {
			repository: f.repository,
			workerId: s.workerId,
			baseSha: f.baseSha,
			headSha,
		});
		expect(verified.changed).toBe(true);
		expect(verified.filesChanged).toBe(2);
		expect(verified.affectedPaths).toEqual(["src/index.ts", "src/styles.css"]);
		expect(verified.diffStats).toEqual({ filesChanged: 2, additions: 3, deletions: 0 });
	}, 20_000);
});
