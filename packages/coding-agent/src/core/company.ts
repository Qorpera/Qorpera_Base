/**
 * Company folder scaffold — the Qorpera Base spine (spec §2).
 *
 * The folder IS the company. Base defines seven spine entries plus the
 * materialized kernel files and never opines past that line: `app/` and
 * `work/` belong to the company's agent. Scaffolding is strictly idempotent
 * — existing files are never overwritten (a company's `company.md` is its
 * identity, not ours to reset). Sessions ARE the trail: the scaffold points
 * the project `sessionDir` at `./trail`, so every session's tree-shaped
 * JSONL record lands inside the company folder with no mirroring layer.
 *
 * The kernel prompt is single-sourced here and materialized as BOTH
 * `AGENTS.md` and `CLAUDE.md` (spec §5.1): the context-file slot is the one
 * channel every vendor co-trains models to honor, it costs zero vendor-
 * prompt upkeep, and it makes the folder self-describing on any harness —
 * including ones Base has never met. Authority for the rules the kernel
 * describes comes from enforcement (`authority.ts`), never from prompt tier.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The kernel prompt (spec §5.2). L0 — companies and models may layer above
 * it, never below it. Written to AGENTS.md and CLAUDE.md at the company
 * root; both files are [authority]-gated against agent edits.
 */
export const KERNEL_PROMPT = `# Kernel

You are the controller of the company rooted in this folder — and the
builder of its controller platform. The human opens one app to run this
company: the app is \`app/\`, and you are its author. Build what the company
needs — surfaces that show the work, substrates that model what matters,
routines that keep it moving, and real capability in \`app/tools/\` when you
need machinery that doesn't exist: commands against your connections,
operational planes, your own ways of working. The controller should fit
this company the way a hand-built instrument fits its player.

When you wake: read \`company.md\`, look around — the app, the inbox, the
state of the work — and decide for yourself what most needs doing. Routines
in \`app/routines/\` are jobs you can run; the inbox may carry steering from
the human; beyond that, use your judgment. Treat the app as something you
keep in good repair, not something you endlessly rework: when reality and
its surfaces diverge — new work worth showing, a surface gone stale, a
capability missing — fix it, and otherwise leave it be.

Everything you think and do is recorded automatically: sessions land in
\`trail/\` as append-only trees. You owe the record nothing — but it is
searchable history when you need to know why something is the way it is,
and a smarter model than you will one day read it and redo your work
better. Work in clean units so the record stays legible.

\`authority.toml\` defines which effects require the human — it binds the
tools you build exactly as it binds you, and it is enforced in the harness,
not by this text. Blocked effects file requests in \`inbox/\`; keep working
elsewhere while you wait. Never edit \`authority.toml\`, this file, or
anything in \`inbox/\` — those belong to the human.

If your model id is newer than the stamps in the trail, you may understand
things your predecessors did not. Re-derive their choices where it matters
and redo the work. Steer the company to the better path; do not bulldoze it.
`;

const COMPANY_MD_TEMPLATE = `# Company

*This company does not exist yet.*

*If you are the controller reading this: interview your founder — who is
this company, what is it trying to become, which constraints matter, what
does the founder care about — then rewrite this file as the company's
identity. Keep it prose, keep it current, keep it honest. It must survive
any model and any decade.*
`;

const AUTHORITY_TOML_TEMPLATE = `# Authority gates — human-owned. The agent reads this file, never writes it.
# Modes: "auto" (proceed) | "notify" (proceed, record a notice) | "gate" (require approval).
# Blocked effects file requests in inbox/; edit their status line to approve or deny.

[money]
mode = "gate"
limit_usd = 50

[identity]
mode = "gate"      # acting AS the company externally: sending, posting, signing

[irreversible]
mode = "gate"      # prod deploys, deletions, legal commitments

[authority]
mode = "gate"      # editing this file, the kernel files, or inbox/.
                   # ALWAYS gated — the harness enforces this regardless of
                   # what this line says.

# [products]       # software products the controller may READ and study
# mode = "gate"    # freely but not MODIFY without approval. Root-relative.
# paths = ["work/my-product"]

# [tools]          # optional per-tool overrides, e.g.:
# deploy = "irreversible"
`;

const CONNECTIONS_README = `# Connections

Declared capabilities: plugins, accounts, subscription lanes. References
only — secrets live in the harness keychain, never in this folder.
`;

const INBOX_README = `# Inbox

Gate requests and human steering land here.

- \`gate-*.md\` — a blocked effect awaiting a decision. Edit its \`status:\`
  line to \`approved\` or \`denied\`. Tool-call approvals are single-use;
  extension-load approvals are durable for the approved content hash.
- \`notices.md\` — effects that proceeded under notify mode.
- Anything else you put here is steering the agent reads on its next wake.
`;

const APP_MANIFEST_TEMPLATE = `{
	"version": 1,
	"surfaces": [],
	"routines": []
}
`;

export interface ScaffoldResult {
	root: string;
	created: string[];
	skipped: string[];
	gitInitialized: boolean;
}

function writeIfMissing(root: string, relPath: string, content: string, result: ScaffoldResult): void {
	const target = join(root, relPath);
	if (existsSync(target)) {
		result.skipped.push(relPath);
		return;
	}
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content, "utf-8");
	result.created.push(relPath);
}

function ensureDir(root: string, relPath: string, result: ScaffoldResult): void {
	const target = join(root, relPath);
	if (!existsSync(target)) {
		mkdirSync(target, { recursive: true });
		result.created.push(`${relPath}/`);
	} else {
		result.skipped.push(`${relPath}/`);
	}
	// Keep empty spine directories present in git.
	const keep = join(target, ".gitkeep");
	if (!existsSync(keep) && readdirIsEmpty(target)) {
		writeFileSync(keep, "", "utf-8");
	}
}

function readdirIsEmpty(dir: string): boolean {
	try {
		return readdirSync(dir).length === 0;
	} catch {
		return false;
	}
}

/** Merge sessionDir into project settings without clobbering other keys. */
function ensureProjectSessionDir(root: string, result: ScaffoldResult): void {
	const settingsDir = join(root, ".qorpera");
	const settingsPath = join(settingsDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		} catch {
			result.skipped.push(".qorpera/settings.json (unreadable — left untouched)");
			return;
		}
	}
	if (settings.sessionDir !== undefined) {
		result.skipped.push(".qorpera/settings.json (sessionDir already set)");
		return;
	}
	settings.sessionDir = "./trail";
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
	result.created.push(".qorpera/settings.json (sessionDir → ./trail)");
}

/**
 * Create the company spine at `dir` (idempotent; never overwrites).
 * The folder is a git repository (spec §2: fork a company = clone it);
 * `git init` runs only when no repository is present and git is available.
 */
export function scaffoldCompany(dir: string): ScaffoldResult {
	const root = resolve(dir);
	mkdirSync(root, { recursive: true });
	const result: ScaffoldResult = { root, created: [], skipped: [], gitInitialized: false };

	writeIfMissing(root, "AGENTS.md", KERNEL_PROMPT, result);
	writeIfMissing(root, "CLAUDE.md", KERNEL_PROMPT, result);
	writeIfMissing(root, "company.md", COMPANY_MD_TEMPLATE, result);
	writeIfMissing(root, "authority.toml", AUTHORITY_TOML_TEMPLATE, result);
	writeIfMissing(root, join("connections", "README.md"), CONNECTIONS_README, result);
	writeIfMissing(root, join("inbox", "README.md"), INBOX_README, result);
	ensureDir(root, "trail", result);
	writeIfMissing(root, join("app", "manifest.json"), APP_MANIFEST_TEMPLATE, result);
	ensureDir(root, join("app", "surfaces"), result);
	ensureDir(root, join("app", "substrates"), result);
	ensureDir(root, join("app", "routines"), result);
	ensureDir(root, join("app", "tools"), result);
	ensureDir(root, "work", result);
	ensureProjectSessionDir(root, result);

	if (!existsSync(join(root, ".git"))) {
		const git = spawnSync("git", ["init"], { cwd: root, stdio: "ignore", shell: false });
		result.gitInitialized = git.status === 0;
	}

	return result;
}

const CONCEPTION_NEW = `This company folder was just created and company.md is still the template. Begin conception: interview me — who this company is, what it is trying to become, which constraints matter, what I care about. Then perform the setup yourself: rewrite company.md as the company's identity, propose authority.toml adjustments and the connections we need (I ratify those), and build the first state-of-the-company surface in app/. Ask me one focused question at a time.`;

const CONCEPTION_INTEGRATE = (repoName: string) =>
	`This company folder was just created around an existing repository at work/${repoName}. Begin conception with study: read that repository enough to understand what exists (do not modify it yet). Then interview me about what the code cannot say — intent, customers, constraints, what I care about. Then perform the setup yourself: rewrite company.md, propose authority.toml adjustments and connections (I ratify those), and build the first state-of-the-company surface in app/. Ask me one focused question at a time.`;

function printScaffoldReport(result: ScaffoldResult): void {
	console.log(`Company spine at ${result.root}`);
	for (const entry of result.created) console.log(`  created ${entry}`);
	for (const entry of result.skipped) console.log(`  kept    ${entry}`);
	if (result.gitInitialized) console.log("  initialized git repository");
}

function launchSession(dir: string, initialMessage?: string): Promise<number> {
	// Re-exec this CLI interactively inside the company folder; the kernel
	// AGENTS.md and gates take over from there.
	const cliPath = process.argv[1];
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cliPath, ...(initialMessage ? [initialMessage] : [])], {
			cwd: dir,
			stdio: "inherit",
		});
		child.on("exit", (code) => resolve(code ?? 0));
		child.on("error", () => resolve(1));
	});
}

function cloneInto(source: string, destination: string): boolean {
	const clone = spawnSync("git", ["clone", source, destination], { stdio: "inherit", shell: false });
	return clone.status === 0;
}

/**
 * Early CLI handlers in the `handlePackageCommand` style. The forking-hub
 * verbs (spec §6.1a): `new` starts or integrates a company, `fork` clones an
 * existing one, `company init` remains the bare scaffold plumbing.
 */
export async function handleCompanyCommand(args: string[]): Promise<boolean> {
	if (args[0] === "new") {
		const rest = args.slice(1);
		const noLaunch = rest.includes("--no-launch");
		const fromIndex = rest.indexOf("--from");
		const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
		const positional = rest.filter((arg, index) => !arg.startsWith("--") && index !== fromIndex + 1);
		const dir = positional[0];
		if (!dir || (fromIndex >= 0 && !from)) {
			console.error("Usage: new <dir> [--from <repo-path-or-url>] [--no-launch]");
			process.exitCode = 1;
			return true;
		}
		const result = scaffoldCompany(dir);
		printScaffoldReport(result);
		let repoName: string | undefined;
		if (from) {
			repoName = basenameOf(from);
			const destination = join(result.root, "work", repoName);
			if (existsSync(destination)) {
				console.log(`  kept    work/${repoName} (already present)`);
			} else if (cloneInto(from, destination)) {
				console.log(`  cloned  ${from} -> work/${repoName}`);
			} else {
				console.error(
					`Could not clone ${from}. Point --from at a git repository (path or URL), or copy the files into work/ yourself and re-run.`,
				);
				process.exitCode = 1;
				return true;
			}
		}
		if (noLaunch) {
			console.log("\nNext: run `qorpera` inside the folder to begin conception.");
			return true;
		}
		console.log("\nStarting conception session…\n");
		process.exitCode = await launchSession(result.root, repoName ? CONCEPTION_INTEGRATE(repoName) : CONCEPTION_NEW);
		return true;
	}

	if (args[0] === "fork") {
		const source = args[1];
		if (!source) {
			console.error("Usage: fork <company-repo-path-or-url> [dir]");
			process.exitCode = 1;
			return true;
		}
		const dir = args[2] ?? basenameOf(source);
		if (existsSync(dir) && readdirSync(dir).length > 0) {
			console.error(`Destination ${dir} exists and is not empty.`);
			process.exitCode = 1;
			return true;
		}
		if (!cloneInto(source, dir)) {
			console.error(`Could not clone ${source}.`);
			process.exitCode = 1;
			return true;
		}
		console.log(`Forked company into ${resolve(dir)}`);
		if (!args.includes("--no-launch")) {
			process.exitCode = await launchSession(resolve(dir));
		}
		return true;
	}

	if (args[0] !== "company") return false;
	const sub = args[1];
	if (sub !== "init") {
		console.error(`Unknown company command: ${sub ?? "(none)"}. Usage: company init [dir]`);
		process.exitCode = 1;
		return true;
	}
	const dir = args[2] ?? process.cwd();
	const result = scaffoldCompany(dir);
	printScaffoldReport(result);
	console.log(
		"\nNext: open a chat here — the controller will interview you and rewrite company.md. Gates live in authority.toml; requests appear in inbox/.",
	);
	return true;
}

function basenameOf(source: string): string {
	const cleaned = source.replace(/\.git$/, "").replace(/[/\\]+$/, "");
	const segments = cleaned.split(/[/\\]/);
	return segments[segments.length - 1] || "company";
}
