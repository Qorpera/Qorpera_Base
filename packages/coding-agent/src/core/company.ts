/**
 * Company folder scaffold — the Qorpera Base spine (spec §2).
 *
 * The folder IS the company. Base defines the spine plus the product-
 * development department kit and never opines past that line: `app/` and
 * department-authored content belong to the company's agents. Scaffolding
 * is strictly idempotent — existing files are never overwritten (a
 * company's `company.md` is its identity, not ours to reset). Sessions ARE
 * the trail: the scaffold points
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
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "../config.ts";
import { discoverAuthority } from "./authority.ts";
import {
	EMPTY_PROJECTION,
	type ProjectionDocument,
	type ProjectionNode,
	parseProjectionDocument,
} from "./projection.ts";

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

Surfaces are instruments, not reports: prefer HTML that reads live state
over prose that freezes it. The backend serves the company design system
at \`/assets/surface.css\` (markdown surfaces inherit it automatically;
HTML surfaces get layout classes too — \`.q-grid\`, \`.q-card\`, \`.q-stat\`,
\`.q-badge\`, \`.q-row\` — so instruments compose without hand-rolled CSS;
override tokens in \`app/surfaces/theme.css\`) and a read-only kit at
\`/assets/surface-kit.js\` — \`window.qorpera\` with \`getState()\`,
\`readSubstrate(name)\`, \`readInbox(file)\`, and \`every(ms, fn)\` — so a
surface can show the company as it is right now and refresh itself.

\`app/projection.json\` is the only navigation publication document. It is
not your company model. Publish only the small part of the company the
founder should navigate. Its stable nodes are departments, categories, and
pages: a department contains pages or categories; a category contains pages
only; a page either hosts a surface or a named Base builtin. Node IDs are
immutable even when files or labels move. Do not derive navigation from the
folder tree, place routines in the projection, or reorganize company data to
fit the UI. Main is platform-owned and always present.

When you wake: read \`company.md\`, look around — the app, the inbox, the
state of the work — and decide for yourself what most needs doing. Routines
in \`app/routines/\` are jobs you can run; the inbox may carry steering from
the human; beyond that, use your judgment. Treat the app as something you
keep in good repair, not something you endlessly rework: when reality and
its surfaces diverge — new work worth showing, a surface gone stale, a
capability missing — fix it, and otherwise leave it be.

Prefer derived understanding over asked understanding: read the data, the
repositories, and the connected services first, and ask the founder to fill
gaps and resolve uncertainty — not to dictate what you could measure.
Founder answers are evidence, not constants: record them with their date
and provenance, and treat every number in them (prices, budgets, forecasts)
as a current best estimate to test and revise with analysis. \`company.md\`
holds identity and intent only; working beliefs — pricing, plans, forecasts
— live in \`app/substrates/\` where you can revise them as evidence arrives.

Everything you think and do is recorded automatically: sessions land in
\`trail/\` as append-only trees. Never compact, replace, expire, or delete
that trail. When a session becomes too large, start a fresh session or, for
product work, a fresh worktree. You owe the record nothing — but it is
searchable history when you need to know why something is the way it is,
and a smarter model than you will one day read it and redo your work
better. Work in clean units so the record stays legible.

The company's git history is append-only from your side: rewriting it
(amend, rebase, force-push, filter, reflog expiry) gates. End every commit
message with provenance trailers — \`Qorpera-Trigger:\` (what prompted the
change) and \`Qorpera-Rationale:\` (why) — the harness enforces this; a
commit without them is rejected with no gate filed, just retry with the
trailers. You are explaining yourself to your future self, not to a
reviewer.

How you and the founder communicate: chat sessions are for work the founder
brings to you. Your own autonomous work communicates through \`inbox/\` —
write \`inbox/msg-<slug>.md\` files for anything user-facing: questions,
proposals, plans, progress updates, decisions you need. One item per file,
a clear title, and enough context to answer without reading your session.
The founder responds inside the item (a Response section appears below your
text); read answers on your next wake. Never block waiting for a reply —
post the item and continue other work.

\`authority.toml\` defines which effects require the human — it binds the
tools you build exactly as it binds you, and it is enforced in the harness,
not by this text. Blocked effects file gate requests in \`inbox/\`
automatically; keep working elsewhere while you wait. Never edit
\`authority.toml\`, this file, or anything in \`inbox/\` other than your own
\`msg-*.md\` items — the rest belongs to the human.

Product code lives only inside \`departments/<product>-development/\`.
As the company controller you may study product repositories, worktrees,
pull requests, and their trails, but you cannot modify product code. Write
briefs and delegate implementation through the department's Product Chat.
That launches a product-worker in one assigned \`worktrees/<task>/\`
directory. A product-worker changes only that worktree, tests and commits
there, pushes its branch, and proposes integration through a pull request.
Controller authority never turns into product-worker authority.

\`userland/\` is your app's own code — this company's fork of the Qorpera
Base chrome. Evolve it freely: change the UI, add views, commands, and
behavior as the company needs. \`userland/.base/\` is the pristine base you
forked from — leave it as merge reference. When a base update is staged at
\`userland/.update/\`, merge it (yours / .base / .update, a 3-way merge):
preserve your evolutions, adopt the update, verify the app loads. The
kernel beneath you — authority enforcement, the trail, the updater — is not
yours and not forkable; everything above it is.

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

const APP_PROJECTION_TEMPLATE = `${JSON.stringify(EMPTY_PROJECTION, null, "\t")}\n`;

const PRODUCT_DEPARTMENT_GITIGNORE = `# Product Git data belongs to the product repository, not the company repository.
repository/
worktrees/
`;

const PULL_REQUESTS_README = `# Pull Requests

Local, synchronized pull-request read models for this product. Connectors or
department routines may write one JSON record per pull request here. The
product department UI reads these records; credentials never belong here.
`;

const PRODUCT_DEPARTMENT_KIND = "product-development";

interface ProductDepartmentManifest {
	version: 1;
	kind: typeof PRODUCT_DEPARTMENT_KIND;
	product: string;
}

function productProjectionNodes(department: ProductDepartment): ProjectionNode[] {
	const namespace = department.id.toLowerCase();
	const departmentId = `department:${namespace}`;
	const context = { departmentId: department.id };
	return [
		{
			id: departmentId,
			kind: "department",
			label: `${department.name} Development`,
			items: [`page:${namespace}.chat`, `page:${namespace}.pull-requests`, `page:${namespace}.architecture`],
		},
		{
			id: `page:${namespace}.chat`,
			kind: "page",
			label: "Chat",
			description: "Start product work in a fresh isolated worktree.",
			view: { type: "builtin", id: "qorpera.product-chat", context },
		},
		{
			id: `page:${namespace}.pull-requests`,
			kind: "page",
			label: "Pull Requests",
			description: "Review synchronized local pull-request records.",
			view: { type: "builtin", id: "qorpera.pull-requests", context },
		},
		{
			id: `page:${namespace}.architecture`,
			kind: "page",
			label: "Architecture",
			description: "Reserved for the product's auditable architecture trail.",
			view: {
				type: "builtin",
				id: "qorpera.placeholder",
				context: {
					title: `${department.name} Architecture`,
					message: "The architecture model will be defined later.",
				},
			},
		},
	];
}

/** Install the product kit into the one company UI projection document. */
function installProductProjection(root: string, department: ProductDepartment): void {
	const projectionPath = join(root, "app", "projection.json");
	let document: ProjectionDocument = {
		schema: EMPTY_PROJECTION.schema,
		default: EMPTY_PROJECTION.default,
		navigation: [],
		nodes: [],
	};
	if (existsSync(projectionPath)) {
		const raw = JSON.parse(readFileSync(projectionPath, "utf-8")) as unknown;
		const parsed = parseProjectionDocument(raw);
		if (parsed.diagnostics.length > 0) {
			throw new Error(
				`Cannot install product UI into invalid app/projection.json: ${parsed.diagnostics.join("; ")}`,
			);
		}
		document = {
			schema: parsed.schema,
			...(parsed.default ? { default: parsed.default } : {}),
			navigation: parsed.navigation,
			nodes: parsed.nodes,
		};
	}
	const kitNodes = productProjectionNodes(department);
	const existing = new Set(document.nodes.map((node) => node.id));
	const departmentId = kitNodes[0].id;
	let changed = false;
	for (const node of kitNodes) {
		if (existing.has(node.id)) continue;
		document.nodes.push(node);
		changed = true;
	}
	if (!document.navigation.includes(departmentId)) {
		document.navigation.push(departmentId);
		changed = true;
	}
	if (!changed && existsSync(projectionPath)) return;
	mkdirSync(join(root, "app"), { recursive: true });
	writeFileSync(projectionPath, `${JSON.stringify(document, null, "\t")}\n`, "utf-8");
}

export interface ProductDepartment {
	/** Stable folder identifier, for example `qorpera-development`. */
	id: string;
	/** Product display name from the department manifest. */
	name: string;
	/** Root-relative department path. */
	path: string;
	/** Root-relative path of the controlling clone. */
	repositoryPath: string;
	/** Root-relative parent for task worktrees. */
	worktreesPath: string;
	/** Root-relative synchronized pull-request read model. */
	pullRequestsPath: string;
	repositoryExists: boolean;
}

export interface ProductWorktree {
	path: string;
	branch: string;
}

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

/** Merge company runtime defaults into project settings without clobbering. */
function ensureProjectSettings(root: string, result: ScaffoldResult): void {
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
	let changed = false;
	if (settings.sessionDir === undefined) {
		settings.sessionDir = "./trail";
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (sessionDir already set)");
	}
	if (settings.compaction === undefined) {
		settings.compaction = { enabled: false };
		changed = true;
	} else if (
		settings.compaction &&
		typeof settings.compaction === "object" &&
		(settings.compaction as Record<string, unknown>).enabled === undefined
	) {
		(settings.compaction as Record<string, unknown>).enabled = false;
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (compaction already configured)");
	}
	if (!changed) return;
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
	result.created.push(".qorpera/settings.json (trail retained; auto-compaction disabled)");
}

function productSlug(product: string): string {
	const slug = product
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
	return slug || "product";
}

function productDepartmentFromEntry(root: string, id: string): ProductDepartment | undefined {
	if (!id.endsWith("-development") || id.includes("/") || id.includes("\\")) return undefined;
	const path = join("departments", id);
	try {
		const manifest = JSON.parse(
			readFileSync(join(root, path, "department.json"), "utf-8"),
		) as Partial<ProductDepartmentManifest>;
		if (manifest.version !== 1 || manifest.kind !== PRODUCT_DEPARTMENT_KIND || typeof manifest.product !== "string") {
			return undefined;
		}
		const repositoryPath = join(path, "repository");
		return {
			id,
			name: manifest.product,
			path,
			repositoryPath,
			worktreesPath: join(path, "worktrees"),
			pullRequestsPath: join(path, "pull-requests"),
			repositoryExists: existsSync(join(root, repositoryPath, ".git")),
		};
	} catch {
		return undefined;
	}
}

/** Product-development departments are an optional Base kit, discovered from the folder. */
export function listProductDepartments(rootDir: string): ProductDepartment[] {
	const root = resolve(rootDir);
	try {
		return readdirSync(join(root, "departments"))
			.map((id) => productDepartmentFromEntry(root, id))
			.filter((entry): entry is ProductDepartment => entry !== undefined)
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/** Materialize the standard product-development department without overwriting it. */
export function scaffoldProductDepartment(rootDir: string, product: string): ProductDepartment {
	const root = resolve(rootDir);
	const id = `${productSlug(product)}-development`;
	const path = join("departments", id);
	const result: ScaffoldResult = { root, created: [], skipped: [], gitInitialized: false };
	const manifest: ProductDepartmentManifest = {
		version: 1,
		kind: PRODUCT_DEPARTMENT_KIND,
		product: product.trim() || productSlug(product),
	};
	writeIfMissing(root, join(path, "department.json"), `${JSON.stringify(manifest, null, "\t")}\n`, result);
	writeIfMissing(root, join(path, ".gitignore"), PRODUCT_DEPARTMENT_GITIGNORE, result);
	ensureDir(root, join(path, "briefs"), result);
	ensureDir(root, join(path, "worktrees"), result);
	writeIfMissing(root, join(path, "pull-requests", "README.md"), PULL_REQUESTS_README, result);
	mkdirSync(join(root, path, "repository"), { recursive: true });
	const department = productDepartmentFromEntry(root, id)!;
	installProductProjection(root, department);
	return department;
}

/** Create one isolated product task branch/worktree from the controlling clone. */
export function createProductWorktree(rootDir: string, department: ProductDepartment): ProductWorktree | undefined {
	const root = resolve(rootDir);
	if (!department.repositoryExists) return undefined;
	const taskId = `${new Date()
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	const path = join(department.worktreesPath, taskId);
	const branch = `qorpera/${department.id}/${taskId}`;
	mkdirSync(join(root, department.worktreesPath), { recursive: true });
	const result = spawnSync(
		"git",
		["-C", join(root, department.repositoryPath), "worktree", "add", "-b", branch, join(root, path)],
		{ encoding: "utf-8", shell: false },
	);
	if (result.status === 0) return { path, branch };
	console.error(`Could not create product worktree: ${result.stderr || result.stdout || "git failed"}`);
	return undefined;
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

	// Kernel files are kernel-owned: refreshed to the current kernel text on
	// every scaffold (that is how kernel upgrades reach existing companies).
	// Everything else is never overwritten.
	for (const kernelFile of ["AGENTS.md", "CLAUDE.md"]) {
		const target = join(root, kernelFile);
		if (!existsSync(target)) {
			writeFileSync(target, KERNEL_PROMPT, "utf-8");
			result.created.push(kernelFile);
		} else if (readFileSync(target, "utf-8") !== KERNEL_PROMPT) {
			writeFileSync(target, KERNEL_PROMPT, "utf-8");
			result.created.push(`${kernelFile} (kernel refreshed)`);
		} else {
			result.skipped.push(kernelFile);
		}
	}
	writeIfMissing(root, "company.md", COMPANY_MD_TEMPLATE, result);
	writeIfMissing(root, "authority.toml", AUTHORITY_TOML_TEMPLATE, result);
	writeIfMissing(root, join("connections", "README.md"), CONNECTIONS_README, result);
	writeIfMissing(root, join("inbox", "README.md"), INBOX_README, result);
	ensureDir(root, "trail", result);
	writeIfMissing(root, join("app", "projection.json"), APP_PROJECTION_TEMPLATE, result);
	ensureDir(root, join("app", "surfaces"), result);
	ensureDir(root, join("app", "substrates"), result);
	ensureDir(root, join("app", "routines"), result);
	ensureDir(root, join("app", "tools"), result);
	ensureDir(root, "departments", result);
	ensureProjectSettings(root, result);

	if (!existsSync(join(root, ".git"))) {
		const git = spawnSync("git", ["init"], { cwd: root, stdio: "ignore", shell: false });
		result.gitInitialized = git.status === 0;
	}

	return result;
}

const CONCEPTION_SHARED = `Your primary source of understanding is data, not interview: derive the scope of the company from what you can read. This is an autonomous session — do NOT hold an interactive interview. For the gaps data cannot answer (intent, customers, constraints, which data sources and services to connect), post inbox/msg-*.md items — focused, answerable questions with your working assumption stated — then continue with everything that does not depend on the answers. Treat founder answers as dated evidence with provenance, never fixed facts: numbers (prices, budgets, forecasts) are early estimates you are expected to test and revise with analysis. Perform the setup yourself: rewrite company.md as identity and intent only (mark unconfirmed parts provisional), keep working beliefs in app/substrates/ as revisable records, propose authority.toml adjustments and connections through the inbox (the founder ratifies), and build the first state-of-the-company surface in app/. Finish by posting a msg item summarizing what you did and what awaits the founder.`;

const CONCEPTION_NEW = `This company folder was just created and company.md is still the template. Begin conception. ${CONCEPTION_SHARED}`;

const CONCEPTION_INTEGRATE = (department: ProductDepartment) =>
	`This company folder was just created around the ${department.name} product at ${department.repositoryPath}. Begin conception with study: read that repository enough to understand what exists. As controller, do not modify it; implementation belongs to a product-worker in ${department.worktreesPath}. ${CONCEPTION_SHARED}`;

function printScaffoldReport(result: ScaffoldResult): void {
	console.log(`Company spine at ${result.root}`);
	for (const entry of result.created) console.log(`  created ${entry}`);
	for (const entry of result.skipped) console.log(`  kept    ${entry}`);
	if (result.gitInitialized) console.log("  initialized git repository");
}

/**
 * Re-exec this CLI interactively inside the company folder. Launched bare on
 * purpose: main() detects the company, registers it, and auto-injects the
 * conception kickoff when company.md is still the template — so kickoff
 * logic lives in exactly one place (conceptionKickoff).
 */
function launchSession(dir: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [process.argv[1]], { cwd: dir, stdio: "inherit" });
		child.on("exit", (code) => resolve(code ?? 0));
		child.on("error", () => resolve(1));
	});
}

function cloneInto(source: string, destination: string): boolean {
	const clone = spawnSync("git", ["clone", source, destination], { stdio: "inherit", shell: false });
	return clone.status === 0;
}

/** Clone an existing repo into its product-development department. */
export function integrateRepo(root: string, from: string, product = basenameOf(from)): boolean {
	const department = scaffoldProductDepartment(root, product);
	const destination = join(root, department.repositoryPath);
	if (existsSync(destination)) {
		try {
			if (readdirSync(destination).length > 0) {
				console.log(`  kept    ${department.repositoryPath} (already present)`);
				return true;
			}
		} catch {
			// cloneInto reports the useful error below
		}
	}
	if (cloneInto(from, destination)) {
		console.log(`  cloned  ${from} -> ${department.repositoryPath}`);
		return true;
	}
	console.error(
		`Could not clone ${from}. Point it at a git repository (path or URL), or populate the product department repository and re-run.`,
	);
	return false;
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
		registerCompany(result.root);
		if (from && !integrateRepo(result.root, from)) {
			process.exitCode = 1;
			return true;
		}
		if (noLaunch) {
			console.log("\nNext: run `qorpera` inside the folder to begin conception.");
			return true;
		}
		console.log("\nStarting conception session…\n");
		process.exitCode = await launchSession(result.root);
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
		registerCompany(resolve(dir));
		if (!args.includes("--no-launch")) {
			process.exitCode = await launchSession(resolve(dir));
		}
		return true;
	}

	if (args[0] !== "company") return false;
	const sub = args[1];
	if (sub === "product" && args[2] === "add") {
		const product = args[3];
		const fromIndex = args.indexOf("--from");
		const from = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
		if (!product || (fromIndex >= 0 && !from)) {
			console.error("Usage: company product add <product-name> [--from <repo-path-or-url>]");
			process.exitCode = 1;
			return true;
		}
		const root = discoverAuthority(process.cwd())?.root;
		if (!root) {
			console.error("Run this command inside a company folder.");
			process.exitCode = 1;
			return true;
		}
		const department = scaffoldProductDepartment(root, product);
		if (from && !integrateRepo(root, from, product)) process.exitCode = 1;
		else console.log(`Product department ready at ${department.path}`);
		return true;
	}
	if (sub !== "init") {
		console.error(
			`Unknown company command: ${sub ?? "(none)"}. Usage: company init [dir] | company product add <name> [--from <repo>]`,
		);
		process.exitCode = 1;
		return true;
	}
	const dir = args[2] ?? process.cwd();
	const result = scaffoldCompany(dir);
	printScaffoldReport(result);
	registerCompany(result.root);
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

/**
 * If this company has never been conceived (company.md is still the
 * template), return the kickoff message to auto-send on session start — the
 * founder should never have to type "hello?" to make setup begin. Companies
 * with a product-development department get the study-first variant.
 */
export function conceptionKickoff(root: string): string | undefined {
	try {
		const companyMd = readFileSync(join(root, "company.md"), "utf-8");
		if (!companyMd.includes("This company does not exist yet")) return undefined;
	} catch {
		return undefined;
	}
	const department = listProductDepartments(root).find((entry) => entry.repositoryExists);
	if (department) return CONCEPTION_INTEGRATE(department);
	return CONCEPTION_NEW;
}

// ---- company registry (the hub's memory) ----------------------------------

export interface CompanyRecord {
	root: string;
	name: string;
	lastOpened: string;
}

function registryPath(): string {
	return join(getAgentDir(), "companies.json");
}

/** Companies known to this machine; roots that stopped being companies are filtered out. */
export function listCompanies(): CompanyRecord[] {
	try {
		const records = JSON.parse(readFileSync(registryPath(), "utf-8")) as CompanyRecord[];
		if (!Array.isArray(records)) return [];
		return records
			.filter(
				(record) => record && typeof record.root === "string" && existsSync(join(record.root, "authority.toml")),
			)
			.sort((a, b) => (b.lastOpened ?? "").localeCompare(a.lastOpened ?? ""));
	} catch {
		return [];
	}
}

export function registerCompany(rootDir: string): void {
	const root = resolve(rootDir);
	const name = basenameOf(root);
	const existing = listCompanies().filter((record) => resolve(record.root) !== root);
	const records: CompanyRecord[] = [{ root, name, lastOpened: new Date().toISOString() }, ...existing];
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(registryPath(), `${JSON.stringify(records, null, "\t")}\n`, "utf-8");
	} catch {
		// The registry is a convenience; failure to write it never blocks a session.
	}
}

// ---- the hub ---------------------------------------------------------------

function askLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolvePromise) => {
		rl.question(question, (answer) => {
			rl.close();
			resolvePromise(answer.trim());
		});
	});
}

type HubChoice = { kind: "enter"; root: string } | { kind: "new" } | { kind: "integrate" } | { kind: "plain" };

/**
 * The forking hub (spec §6.1a): bare `qorpera` outside a company offers
 * enter / new / integrate / plain-session. Returns undefined to continue
 * normal startup (plain session), or an exit code when it ran a session.
 */
export async function runCompanyHub(
	showSelector: (title: string, options: Array<{ label: string; value: HubChoice }>) => Promise<HubChoice | undefined>,
): Promise<number | undefined> {
	const companies = listCompanies();
	const options: Array<{ label: string; value: HubChoice }> = [
		...companies.map((company) => ({
			label: `Enter ${company.name}  (${company.root})`,
			value: { kind: "enter", root: company.root } as HubChoice,
		})),
		{ label: "New company…", value: { kind: "new" } },
		{ label: "Integrate an existing repo into a new company…", value: { kind: "integrate" } },
		{ label: "Plain session in this directory", value: { kind: "plain" } },
	];
	const choice = await showSelector("Qorpera — company hub", options);
	if (choice === undefined) return 0; // esc/ctrl-c: quit
	switch (choice.kind) {
		case "plain":
			return undefined;
		case "enter": {
			registerCompany(choice.root);
			return await launchSession(choice.root);
		}
		case "new":
		case "integrate": {
			const dir = await askLine("Directory for the new company (e.g. C:\\Companies\\my-co): ");
			if (!dir) return 0;
			const from =
				choice.kind === "integrate" ? await askLine("Existing repo to integrate (path or git URL): ") : "";
			if (choice.kind === "integrate" && !from) return 0;
			const result = scaffoldCompany(dir);
			printScaffoldReport(result);
			registerCompany(result.root);
			if (from && !integrateRepo(result.root, from)) return 1;
			console.log("\nStarting conception session…\n");
			return await launchSession(result.root);
		}
	}
}
