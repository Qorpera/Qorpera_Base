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

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
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

The company's git metadata is kernel-owned. At each settled controller turn,
the kernel checkpoints the files that turn changed and attaches the trail
session as provenance; never edit \`.git/\` or rewrite company history.
Product workers are different: their assigned worktree is an isolated clone,
so they commit there with \`Qorpera-Trigger:\` and \`Qorpera-Rationale:\`
trailers before proposing the branch through a pull request. You are
explaining yourself to your future self, not to a reviewer.

How you and the founder communicate: chat sessions are for work the founder
brings to you. Your own autonomous work communicates through \`inbox/messages/\` —
write \`inbox/messages/msg-<slug>.md\` files for anything user-facing: questions,
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
\`inbox/messages/msg-*.md\` items — the rest belongs to the human.

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
- \`messages/msg-*.md\` — agent-authored questions, proposals, and updates.
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
const PRODUCT_REGISTRY_PATH = join(".qorpera", "products.json");
const PRODUCT_WORKTREE_ASSIGNMENTS_PATH = join(".qorpera", "product-worktrees");

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Resolve an existing company through aliases once, then use that physical identity everywhere. */
export function canonicalCompanyRoot(rootDir: string): string {
	return realpathSync(resolve(rootDir));
}

function canonicalDirectory(root: string, relativePath: string): string {
	const target = resolve(root, relativePath);
	const actual = realpathSync(target);
	if (normalizedPath(actual) !== normalizedPath(target) || !lstatSync(target).isDirectory()) {
		throw new Error(`Company storage must be a physical directory, not a link or junction: ${relativePath}`);
	}
	return actual;
}

interface StorageIdentity {
	path: string;
	device: string;
	inode: string;
	kind: "directory" | "file";
}

export interface ProductTransactionStorage {
	root: StorageIdentity;
	departments: StorageIdentity;
	app: StorageIdentity;
	qorpera: StorageIdentity;
	projection: StorageIdentity;
	productRegistry: StorageIdentity;
}

function storageIdentity(path: string, kind: StorageIdentity["kind"]): StorageIdentity {
	const actual = realpathSync(path);
	const entry = lstatSync(path);
	if (
		normalizedPath(actual) !== normalizedPath(path) ||
		(kind === "directory" ? !entry.isDirectory() : !entry.isFile()) ||
		(kind === "file" && entry.nlink !== 1)
	) {
		throw new Error(`Company transaction ${kind} must be one physical entry: ${path}`);
	}
	const stats = statSync(path, { bigint: true });
	return { path, device: stats.dev.toString(), inode: stats.ino.toString(), kind };
}

/**
 * Bind a product transaction to the canonical company roots before review.
 * Rechecking the device/inode tuple prevents a reviewed directory from being
 * replaced with a junction before a later transaction write.
 */
export function captureProductTransactionStorage(rootDir: string): ProductTransactionStorage {
	const root = canonicalCompanyRoot(rootDir);
	return {
		root: storageIdentity(root, "directory"),
		departments: storageIdentity(canonicalDirectory(root, "departments"), "directory"),
		app: storageIdentity(canonicalDirectory(root, "app"), "directory"),
		qorpera: storageIdentity(canonicalDirectory(root, ".qorpera"), "directory"),
		projection: storageIdentity(join(root, "app", "projection.json"), "file"),
		productRegistry: storageIdentity(join(root, PRODUCT_REGISTRY_PATH), "file"),
	};
}

export function assertProductTransactionStorage(storage: ProductTransactionStorage): string {
	for (const identity of [
		storage.root,
		storage.departments,
		storage.app,
		storage.qorpera,
		storage.projection,
		storage.productRegistry,
	]) {
		const actual = storageIdentity(identity.path, identity.kind);
		if (
			normalizedPath(actual.path) !== normalizedPath(identity.path) ||
			actual.device !== identity.device ||
			actual.inode !== identity.inode
		) {
			throw new Error(`Company transaction storage changed after review: ${identity.path}`);
		}
	}
	return storage.root.path;
}

export function companyRuntimeLockPath(rootDir: string): string {
	const root = canonicalCompanyRoot(rootDir);
	const gitPath = spawnSync(
		"git",
		["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "qorpera-runtime-locks"],
		{ encoding: "utf-8", shell: false },
	);
	if (gitPath.status !== 0 || !gitPath.stdout.trim()) {
		throw new Error("company transaction requires a valid Git repository");
	}
	const id = createHash("sha256").update(normalizedPath(root)).digest("hex");
	return join(gitPath.stdout.trim(), `${id}.json`);
}

export interface CompanyRuntimeLock {
	path: string;
	root: string;
	token: string;
	release: () => void;
}

interface CompanyLockRecord {
	version: 2;
	pid: number;
	root: string;
	token: string;
	mode: "runtime" | "product-registration";
}

const ownedRuntimeLocks = new WeakSet<CompanyRuntimeLock>();

function acquireCompanyLock(rootDir: string, mode: CompanyLockRecord["mode"]): CompanyRuntimeLock {
	const root = canonicalCompanyRoot(rootDir);
	const path = companyRuntimeLockPath(root);
	mkdirSync(dirname(path), { recursive: true });
	let release: () => void;
	try {
		release = lockfile.lockSync(path, { realpath: false, stale: 30_000 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
			throw new Error("Company transaction is already owned by another process", { cause: error });
		}
		throw error;
	}
	const token = randomUUID();
	const record: CompanyLockRecord = { version: 2, pid: process.pid, root, token, mode };
	try {
		writeFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
		return { path, root, token, release };
	} catch (error) {
		release();
		throw error;
	}
}

export function claimCompanyRuntimeLock(rootDir: string): CompanyRuntimeLock {
	const lock = acquireCompanyLock(rootDir, "runtime");
	ownedRuntimeLocks.add(lock);
	return lock;
}

export function releaseCompanyRuntimeLock(lock: CompanyRuntimeLock): void {
	try {
		const record = JSON.parse(readFileSync(lock.path, "utf-8")) as Partial<CompanyLockRecord>;
		if (record.token !== lock.token || normalizedPath(record.root ?? "") !== normalizedPath(lock.root)) {
			throw new Error("company transaction lock ownership changed before release");
		}
		rmSync(lock.path, { force: true });
		lock.release();
	} catch (error) {
		try {
			lock.release();
		} catch {}
		throw error;
	} finally {
		ownedRuntimeLocks.delete(lock);
	}
}

function assertRuntimeLock(root: string, lock: CompanyRuntimeLock): void {
	const canonicalRoot = canonicalCompanyRoot(root);
	if (!ownedRuntimeLocks.has(lock) || normalizedPath(lock.root) !== normalizedPath(canonicalRoot)) {
		throw new Error("desktop product transaction has no kernel-owned runtime capability");
	}
	const path = companyRuntimeLockPath(canonicalRoot);
	let record: Partial<CompanyLockRecord>;
	try {
		record = JSON.parse(readFileSync(path, "utf-8")) as Partial<CompanyLockRecord>;
	} catch (error) {
		throw new Error("desktop product transaction has no valid runtime lock", { cause: error });
	}
	if (
		record.version !== 2 ||
		record.mode !== "runtime" ||
		record.pid !== process.pid ||
		record.token !== lock.token ||
		normalizedPath(record.root ?? "") !== normalizedPath(canonicalRoot)
	) {
		throw new Error("desktop product transaction does not own the company runtime lock");
	}
}

interface ProductDepartmentManifest {
	version: 1;
	kind: typeof PRODUCT_DEPARTMENT_KIND;
	product: string;
}

interface ProductRegistry {
	version: 1;
	products: string[];
}

const PRODUCT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-development$/;

function parseProductRegistry(root: string, allowMissing: boolean): ProductRegistry {
	const path = join(root, PRODUCT_REGISTRY_PATH);
	if (!existsSync(path)) {
		if (allowMissing) return { version: 1, products: [] };
		throw new Error(`Company product inventory is missing: ${PRODUCT_REGISTRY_PATH}`);
	}
	try {
		if (normalizedPath(realpathSync(path)) !== normalizedPath(path) || !lstatSync(path).isFile()) {
			throw new Error("product inventory must be a physical file");
		}
		const registry = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProductRegistry>;
		if (
			registry.version === 1 &&
			Array.isArray(registry.products) &&
			registry.products.every((id) => typeof id === "string" && PRODUCT_ID_PATTERN.test(id)) &&
			new Set(registry.products).size === registry.products.length
		) {
			return { version: 1, products: [...registry.products] };
		}
	} catch (error) {
		throw new Error(
			`Company product inventory is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	throw new Error(`Company product inventory is invalid: ${PRODUCT_REGISTRY_PATH}`);
}

function readProductRegistry(root: string): ProductRegistry {
	return parseProductRegistry(root, false);
}

function registerProductDepartment(root: string, id: string): void {
	const registry = parseProductRegistry(root, true);
	if (registry.products.includes(id)) return;
	registry.products.push(id);
	registry.products.sort();
	mkdirSync(join(root, ".qorpera"), { recursive: true });
	writeFileSync(join(root, PRODUCT_REGISTRY_PATH), `${JSON.stringify(registry, null, "\t")}\n`, "utf-8");
}

function checkpointProductKit(root: string, id: string): void {
	if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false }).status !== 0)
		return;
	const paths = [
		PRODUCT_REGISTRY_PATH,
		join("app", "projection.json"),
		join("departments", id, "department.json"),
		join("departments", id, ".gitignore"),
		join("departments", id, "briefs", ".gitkeep"),
		join("departments", id, "pull-requests", "README.md"),
	].filter((path) => existsSync(join(root, path)));
	const added = spawnSync("git", ["-C", root, "add", "--", ...paths], { stdio: "ignore", shell: false });
	if (added.status !== 0) throw new Error(`Could not stage product department ${id}`);
	const changed = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", ...paths], {
		stdio: "ignore",
		shell: false,
	});
	if (changed.status === 0) return;
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Kernel",
			"-c",
			"user.email=kernel@qorpera.local",
			"commit",
			"--only",
			"-m",
			`feat: add ${id} product department\n\nQorpera-Trigger: founder product kit request\nQorpera-Rationale: preserve the registered product boundary and its UI projection`,
			"--",
			...paths,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit product department ${id}: ${committed.stderr || committed.stdout}`);
	}
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
function installProductProjection(root: string, department: ProductDepartment, write = true): void {
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
	const existing = new Map(document.nodes.map((node) => [node.id, node]));
	const departmentId = kitNodes[0].id;
	let changed = false;
	for (const node of kitNodes) {
		const current = existing.get(node.id);
		if (current) {
			if (JSON.stringify(current) !== JSON.stringify(node)) {
				throw new Error(
					`Cannot install product UI: projection node ${node.id} is already owned by incompatible content`,
				);
			}
			continue;
		}
		document.nodes.push(node);
		changed = true;
	}
	if (!document.navigation.includes(departmentId)) {
		document.navigation.push(departmentId);
		changed = true;
	}
	const completed = parseProjectionDocument(document);
	if (completed.diagnostics.length > 0) {
		throw new Error(`Cannot install product UI into app/projection.json: ${completed.diagnostics.join("; ")}`);
	}
	if (!write) return;
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
	departmentId: string;
	repositoryPath: string;
	sourceRemote: string;
	sourceHead?: string;
	createdAt: string;
}

export interface ProductWorktreePlan {
	taskId: string;
	path: string;
	branch: string;
	departmentId: string;
	repositoryPath: string;
	sourceRemote: string;
	sourceHead?: string;
}

interface ProductWorktreeAssignment extends ProductWorktree {
	version: 1;
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
		result.created.push(join(relPath, ".gitkeep"));
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
function ensureProjectSettings(root: string, result: ScaffoldResult): boolean {
	const settingsDir = join(root, ".qorpera");
	const settingsPath = join(settingsDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("settings root must be an object");
			}
			settings = parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`Company settings are invalid and cannot be opened safely: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	let changed = false;
	if (settings.sessionDir !== "./trail") {
		settings.sessionDir = "./trail";
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (sessionDir already set)");
	}
	if (!settings.compaction || typeof settings.compaction !== "object" || Array.isArray(settings.compaction)) {
		settings.compaction = { enabled: false };
		changed = true;
	} else if ((settings.compaction as Record<string, unknown>).enabled !== false) {
		(settings.compaction as Record<string, unknown>).enabled = false;
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (compaction already configured)");
	}
	if (settings.transport !== "sse") {
		settings.transport = "sse";
		changed = true;
	} else {
		result.skipped.push(".qorpera/settings.json (brokered SSE transport already set)");
	}
	if (!changed) return false;
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
	result.created.push(".qorpera/settings.json (trail retained; auto-compaction disabled)");
	return true;
}

/** Reassert kernel-owned retention policy whenever an existing company opens. */
export function enforceCompanyKernelSettings(rootDir: string): void {
	const root = canonicalCompanyRoot(rootDir);
	if (!ensureProjectSettings(root, { root, created: [], skipped: [], gitInitialized: false })) return;
	if (spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false }).status !== 0)
		return;
	const path = join(".qorpera", "settings.json");
	if (spawnSync("git", ["-C", root, "add", "--", path], { stdio: "ignore", shell: false }).status !== 0) {
		throw new Error("Could not stage kernel retention settings");
	}
	if (
		spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", path], {
			stdio: "ignore",
			shell: false,
		}).status === 0
	)
		return;
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Kernel",
			"-c",
			"user.email=kernel@qorpera.local",
			"commit",
			"--only",
			"-m",
			"fix: enforce append-only company trails\n\nQorpera-Trigger: company open\nQorpera-Rationale: keep company session storage local and disable compaction",
			"--",
			path,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit kernel retention settings: ${committed.stderr || committed.stdout}`);
	}
}

function productSlug(product: string): string {
	const slug = product
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "product";
}

/** Canonical folder identifier reviewed before any product-registration transaction. */
export function productDepartmentId(product: string): string {
	return `${productSlug(product)}-development`;
}

function productDepartmentFromEntry(root: string, id: string): ProductDepartment | undefined {
	if (!id.endsWith("-development") || id.includes("/") || id.includes("\\")) return undefined;
	const path = join("departments", id);
	try {
		canonicalDirectory(root, path);
		const manifestPath = join(root, path, "department.json");
		if (
			normalizedPath(realpathSync(manifestPath)) !== normalizedPath(manifestPath) ||
			!lstatSync(manifestPath).isFile()
		)
			return undefined;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Partial<ProductDepartmentManifest>;
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
	const root = canonicalCompanyRoot(rootDir);
	return readProductRegistry(root)
		.products.map((id) => productDepartmentFromEntry(root, id))
		.filter((entry): entry is ProductDepartment => entry !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Kernel protection inventory; never depends on agent-writable department manifests. */
export function readProductProtectionInventory(
	rootDir: string,
): Array<{ id: string; repositoryPath: string; worktreesPath: string }> {
	const root = canonicalCompanyRoot(rootDir);
	const actualRoot = root;
	return readProductRegistry(root).products.map((id) => {
		const repositoryPath = join("departments", id, "repository");
		const worktreesPath = join("departments", id, "worktrees");
		for (const path of [repositoryPath, worktreesPath]) {
			const expected = resolve(root, path);
			const expectedActual = resolve(actualRoot, path);
			let actual: string;
			try {
				actual = realpathSync(expected);
			} catch (error) {
				throw new Error(`Registered product storage is unavailable: ${path}`, { cause: error });
			}
			const normalizedExpected = process.platform === "win32" ? expectedActual.toLowerCase() : expectedActual;
			const normalizedActual = process.platform === "win32" ? actual.toLowerCase() : actual;
			if (normalizedActual !== normalizedExpected) {
				throw new Error(`Registered product storage must not be a link or junction: ${path}`);
			}
		}
		return { id, repositoryPath, worktreesPath };
	});
}

/** Materialize the standard product-development department while its caller owns the company transaction lock. */
function scaffoldProductDepartmentUnlocked(
	rootDir: string,
	product: string,
	storage: ProductTransactionStorage,
): ProductDepartment {
	const root = assertProductTransactionStorage(storage);
	if (normalizedPath(root) !== normalizedPath(canonicalCompanyRoot(rootDir))) {
		throw new Error("Product transaction storage does not belong to this company");
	}
	const id = productDepartmentId(product);
	const path = join("departments", id);
	const target = join(root, path);
	const existing = productDepartmentFromEntry(root, id);
	if (existsSync(target) && !existing) {
		throw new Error(
			`Cannot create product department ${id}: ${path} already exists without a valid product-development manifest`,
		);
	}
	if (existing) {
		assertProductTransactionStorage(storage);
		installProductProjection(root, existing);
		assertProductTransactionStorage(storage);
		registerProductDepartment(root, id);
		assertProductTransactionStorage(storage);
		checkpointProductKit(root, id);
		return existing;
	}
	const result: ScaffoldResult = { root, created: [], skipped: [], gitInitialized: false };
	const manifest: ProductDepartmentManifest = {
		version: 1,
		kind: PRODUCT_DEPARTMENT_KIND,
		product: product.trim() || productSlug(product),
	};
	const department: ProductDepartment = {
		id,
		name: manifest.product,
		path,
		repositoryPath: join(path, "repository"),
		worktreesPath: join(path, "worktrees"),
		pullRequestsPath: join(path, "pull-requests"),
		repositoryExists: false,
	};
	installProductProjection(root, department, false);
	assertProductTransactionStorage(storage);
	writeIfMissing(root, join(path, "department.json"), `${JSON.stringify(manifest, null, "\t")}\n`, result);
	writeIfMissing(root, join(path, ".gitignore"), PRODUCT_DEPARTMENT_GITIGNORE, result);
	ensureDir(root, join(path, "briefs"), result);
	ensureDir(root, join(path, "worktrees"), result);
	writeIfMissing(root, join(path, "pull-requests", "README.md"), PULL_REQUESTS_README, result);
	mkdirSync(join(root, path, "repository"), { recursive: true });
	const created = productDepartmentFromEntry(root, id)!;
	assertProductTransactionStorage(storage);
	installProductProjection(root, created);
	assertProductTransactionStorage(storage);
	registerProductDepartment(root, id);
	assertProductTransactionStorage(storage);
	checkpointProductKit(root, id);
	return created;
}

/** Offline product registration. The lock is held across inventory, folder, projection, and Git mutation. */
export function scaffoldProductDepartment(rootDir: string, product: string): ProductDepartment {
	const lock = acquireCompanyLock(rootDir, "product-registration");
	try {
		const storage = captureProductTransactionStorage(lock.root);
		return scaffoldProductDepartmentUnlocked(lock.root, product, storage);
	} finally {
		releaseCompanyRuntimeLock(lock);
	}
}

/** Desktop-kernel product registration under the already-held runtime transaction. */
export function scaffoldProductDepartmentWithRuntimeLock(
	rootDir: string,
	product: string,
	runtimeLock: CompanyRuntimeLock,
	storage: ProductTransactionStorage,
): ProductDepartment {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	return scaffoldProductDepartmentUnlocked(root, product, storage);
}

function worktreeAssignmentPath(root: string, departmentId: string, taskId: string): string {
	return join(root, PRODUCT_WORKTREE_ASSIGNMENTS_PATH, departmentId, `${taskId}.json`);
}

function commitProductWorktreeAssignment(root: string, path: string, departmentId: string): void {
	const relativePath = join(PRODUCT_WORKTREE_ASSIGNMENTS_PATH, departmentId, `${path}.json`);
	const added = spawnSync("git", ["-C", root, "add", "--", relativePath], { encoding: "utf-8", shell: false });
	if (added.status !== 0)
		throw new Error(`Could not stage product worktree assignment: ${added.stderr || added.stdout}`);
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Kernel",
			"-c",
			"user.email=kernel@qorpera.local",
			"commit",
			"--only",
			"-m",
			`docs: assign ${departmentId} worktree\n\nQorpera-Trigger: founder product-chat request\nQorpera-Rationale: bind product-code authority to one kernel-created clone`,
			"--",
			relativePath,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit product worktree assignment: ${committed.stderr || committed.stdout}`);
	}
}

function gitOutput(root: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false });
	return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/** Plan the exact founder-reviewed worktree without mutating product storage. */
export function planProductWorktree(
	rootDir: string,
	department: ProductDepartment,
	runtimeLock: CompanyRuntimeLock,
): ProductWorktreePlan | undefined {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	readProductProtectionInventory(root);
	if (!department.repositoryExists) return undefined;
	const registered = listProductDepartments(root).find(
		(entry) =>
			entry.id === department.id &&
			entry.repositoryPath === department.repositoryPath &&
			entry.worktreesPath === department.worktreesPath &&
			entry.repositoryExists,
	);
	if (!registered) return undefined;
	const taskId = `${new Date()
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14)}-${randomUUID().slice(0, 8)}`;
	const path = join(department.worktreesPath, taskId);
	const branch = `qorpera/${taskId}`;
	const repository = canonicalDirectory(root, department.repositoryPath);
	canonicalDirectory(root, department.worktreesPath);
	const sourceRemote = gitOutput(repository, ["remote", "get-url", "origin"]) ?? repository;
	const sourceHead = gitOutput(repository, ["rev-parse", "HEAD"]);
	return {
		taskId,
		path,
		branch,
		departmentId: department.id,
		repositoryPath: department.repositoryPath,
		sourceRemote,
		...(sourceHead ? { sourceHead } : {}),
	};
}

/** Materialize one founder-reviewed product task clone under worktrees/. */
export function createProductWorktree(
	rootDir: string,
	department: ProductDepartment,
	runtimeLock: CompanyRuntimeLock,
	plan: ProductWorktreePlan,
): ProductWorktree | undefined {
	const root = canonicalCompanyRoot(rootDir);
	assertRuntimeLock(root, runtimeLock);
	const currentPlan = planProductWorktree(root, department, runtimeLock);
	if (
		!currentPlan ||
		plan.departmentId !== currentPlan.departmentId ||
		plan.repositoryPath !== currentPlan.repositoryPath ||
		plan.path !== join(department.worktreesPath, plan.taskId) ||
		plan.branch !== `qorpera/${plan.taskId}` ||
		plan.sourceRemote !== currentPlan.sourceRemote ||
		plan.sourceHead !== currentPlan.sourceHead ||
		!/^\d{14}-[a-f0-9]{8}$/i.test(plan.taskId)
	) {
		throw new Error("Product worktree plan changed after founder review");
	}
	const { taskId, path, branch } = plan;
	const worktreesRoot = canonicalDirectory(root, department.worktreesPath);
	const repository = canonicalDirectory(root, department.repositoryPath);
	const target = join(root, path);
	if (existsSync(target) || existsSync(worktreeAssignmentPath(root, department.id, taskId))) {
		throw new Error("Founder-reviewed product worktree target is no longer available");
	}
	const clone = spawnSync("git", ["clone", "--no-hardlinks", repository, target], {
		encoding: "utf-8",
		shell: false,
	});
	if (clone.status !== 0) {
		console.error(`Could not create product worktree: ${clone.stderr || clone.stdout || "git clone failed"}`);
		return undefined;
	}
	const checkout = spawnSync("git", ["-C", target, "switch", "-c", branch], {
		encoding: "utf-8",
		shell: false,
	});
	if (checkout.status === 0) {
		const remote = gitOutput(repository, ["remote", "get-url", "origin"]);
		if (remote) {
			spawnSync("git", ["-C", target, "remote", "set-url", "origin", remote], {
				stdio: "ignore",
				shell: false,
			});
		}
		const actualTarget = realpathSync(target);
		if (
			normalizedPath(actualTarget) !== normalizedPath(resolve(worktreesRoot, taskId)) ||
			normalizedPath(dirname(actualTarget)) !== normalizedPath(worktreesRoot)
		) {
			rmSync(target, { recursive: true, force: true });
			throw new Error("Kernel-created product worktree escaped its assigned parent");
		}
		const sourceRemote = gitOutput(target, ["remote", "get-url", "origin"]);
		const sourceHead = gitOutput(target, ["rev-parse", "HEAD"]);
		if (!sourceRemote || sourceRemote !== plan.sourceRemote || sourceHead !== plan.sourceHead) {
			rmSync(target, { recursive: true, force: true });
			throw new Error("Kernel-created product worktree source changed after founder review");
		}
		const assignment: ProductWorktreeAssignment = {
			version: 1,
			path,
			branch,
			departmentId: department.id,
			repositoryPath: department.repositoryPath,
			sourceRemote,
			...(plan.sourceHead ? { sourceHead: plan.sourceHead } : {}),
			createdAt: new Date().toISOString(),
		};
		const assignmentDir = join(root, PRODUCT_WORKTREE_ASSIGNMENTS_PATH, department.id);
		mkdirSync(assignmentDir, { recursive: true });
		canonicalDirectory(root, join(PRODUCT_WORKTREE_ASSIGNMENTS_PATH, department.id));
		const assignmentPath = worktreeAssignmentPath(root, department.id, taskId);
		try {
			writeFileSync(assignmentPath, `${JSON.stringify(assignment, null, "\t")}\n`, {
				encoding: "utf-8",
				flag: "wx",
			});
			commitProductWorktreeAssignment(root, taskId, department.id);
			return assignment;
		} catch (error) {
			rmSync(assignmentPath, { force: true });
			rmSync(target, { recursive: true, force: true });
			throw error;
		}
	}
	console.error(`Could not create product worktree branch: ${checkout.stderr || checkout.stdout || "git failed"}`);
	rmSync(target, { recursive: true, force: true });
	return undefined;
}

/** Verify an existing assignment against its immutable kernel record and clone identity. */
export function readProductWorktreeAssignment(
	rootDir: string,
	department: ProductDepartment,
	worktreePath: string,
): ProductWorktree | undefined {
	const root = canonicalCompanyRoot(rootDir);
	const normalizedRelative = worktreePath.replace(/[\\/]+/g, "/");
	const expectedParent = department.worktreesPath.replace(/\\/g, "/");
	const taskId = normalizedRelative.slice(expectedParent.length + 1);
	if (
		!normalizedRelative.startsWith(`${expectedParent}/`) ||
		!taskId ||
		taskId.includes("/") ||
		taskId === "." ||
		taskId === ".."
	)
		return undefined;
	let assignment: Partial<ProductWorktreeAssignment>;
	try {
		const assignmentPath = worktreeAssignmentPath(root, department.id, taskId);
		if (
			normalizedPath(realpathSync(assignmentPath)) !== normalizedPath(assignmentPath) ||
			!lstatSync(assignmentPath).isFile()
		) {
			return undefined;
		}
		assignment = JSON.parse(readFileSync(assignmentPath, "utf-8")) as Partial<ProductWorktreeAssignment>;
	} catch {
		return undefined;
	}
	if (
		assignment.version !== 1 ||
		assignment.departmentId !== department.id ||
		assignment.path?.replace(/\\/g, "/") !== normalizedRelative ||
		assignment.repositoryPath !== department.repositoryPath ||
		typeof assignment.branch !== "string" ||
		!assignment.branch ||
		typeof assignment.sourceRemote !== "string" ||
		!assignment.sourceRemote ||
		typeof assignment.createdAt !== "string" ||
		(assignment.sourceHead !== undefined && typeof assignment.sourceHead !== "string")
	)
		return undefined;
	const worktreesRoot = canonicalDirectory(root, department.worktreesPath);
	const target = resolve(root, worktreePath);
	let actual: string;
	try {
		actual = realpathSync(target);
	} catch {
		return undefined;
	}
	const topLevel = gitOutput(actual, ["rev-parse", "--show-toplevel"]);
	if (
		normalizedPath(dirname(actual)) !== normalizedPath(worktreesRoot) ||
		normalizedPath(actual) !== normalizedPath(resolve(worktreesRoot, taskId)) ||
		!topLevel ||
		normalizedPath(topLevel) !== normalizedPath(actual) ||
		gitOutput(actual, ["branch", "--show-current"]) !== assignment.branch ||
		gitOutput(actual, ["remote", "get-url", "origin"]) !== assignment.sourceRemote
	)
		return undefined;
	if (
		assignment.sourceHead &&
		spawnSync("git", ["-C", actual, "merge-base", "--is-ancestor", assignment.sourceHead, "HEAD"], {
			stdio: "ignore",
			shell: false,
		}).status !== 0
	)
		return undefined;
	return assignment as ProductWorktree;
}

function ensureCompanyGenesis(root: string, createdPaths: string[]): void {
	const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { stdio: "ignore", shell: false });
	const materializedPaths = [
		...new Set(createdPaths.map((path) => path.replace(/ \([^)]*\)$/, "").replace(/\/$/, ""))),
	].filter((path) => path && existsSync(join(root, path)));
	if (head.status === 0 && materializedPaths.length === 0) return;
	const added = spawnSync(
		"git",
		head.status === 0 ? ["-C", root, "add", "--", ...materializedPaths] : ["-C", root, "add", "--all"],
		{ stdio: "ignore", shell: false },
	);
	if (added.status !== 0) throw new Error("Could not stage the company genesis snapshot");
	if (head.status === 0) {
		const changed = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", ...materializedPaths], {
			stdio: "ignore",
			shell: false,
		});
		if (changed.status === 0) return;
		if (changed.status !== 1) throw new Error("Could not inspect the company materialization snapshot");
	}
	const message =
		head.status === 0
			? "docs: materialize company spine\n\nQorpera-Trigger: company scaffold migration\nQorpera-Rationale: make kernel-owned company state cloneable before controller execution"
			: "feat: create company genesis\n\nQorpera-Trigger: company scaffold\nQorpera-Rationale: make the complete company spine cloneable and recoverable";
	const pathArgs = head.status === 0 ? ["--only", "--", ...materializedPaths] : [];
	const committed = spawnSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Qorpera Kernel",
			"-c",
			"user.email=kernel@qorpera.local",
			"commit",
			"-m",
			message,
			...pathArgs,
		],
		{ encoding: "utf-8", shell: false },
	);
	if (committed.status !== 0) {
		throw new Error(`Could not commit the company genesis snapshot: ${committed.stderr || committed.stdout}`);
	}
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
	ensureDir(root, join("inbox", "messages"), result);
	ensureDir(root, "trail", result);
	writeIfMissing(root, join("app", "projection.json"), APP_PROJECTION_TEMPLATE, result);
	ensureDir(root, join("app", "surfaces"), result);
	ensureDir(root, join("app", "substrates"), result);
	ensureDir(root, join("app", "routines"), result);
	ensureDir(root, join("app", "tools"), result);
	ensureDir(root, "departments", result);
	writeIfMissing(root, PRODUCT_REGISTRY_PATH, `${JSON.stringify({ version: 1, products: [] }, null, "\t")}\n`, result);
	ensureProjectSettings(root, result);

	if (!existsSync(join(root, ".git"))) {
		const git = spawnSync("git", ["init"], { cwd: root, stdio: "ignore", shell: false });
		result.gitInitialized = git.status === 0;
	}
	ensureCompanyGenesis(root, result.created);

	return result;
}

const CONCEPTION_SHARED = `Your primary source of understanding is data, not interview: derive the scope of the company from what you can read. This is an autonomous session — do NOT hold an interactive interview. For the gaps data cannot answer (intent, customers, constraints, which data sources and services to connect), post inbox/messages/msg-*.md items — focused, answerable questions with your working assumption stated — then continue with everything that does not depend on the answers. Treat founder answers as dated evidence with provenance, never fixed facts: numbers (prices, budgets, forecasts) are early estimates you are expected to test and revise with analysis. Perform the setup yourself: rewrite company.md as identity and intent only (mark unconfirmed parts provisional), keep working beliefs in app/substrates/ as revisable records, propose authority.toml adjustments and connections through the inbox (the founder ratifies), and build the first state-of-the-company surface in app/. Finish by posting a msg item summarizing what you did and what awaits the founder.`;

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
	console.log(`Company ready at ${resolve(dir)}. Open it in Qorpera Base desktop to start the kernel-owned session.`);
	return Promise.resolve(0);
}

function cloneInto(source: string, destination: string): boolean {
	try {
		const parsed = new URL(source);
		if ((parsed.protocol === "https:" || parsed.protocol === "http:") && (parsed.username || parsed.password)) {
			console.error("Repository URLs with embedded credentials are not allowed; use a Git credential helper.");
			return false;
		}
	} catch {
		// Local paths and SCP-style SSH remotes are not URL-userinfo credentials.
	}
	const clone = spawnSync("git", ["clone", source, destination], { stdio: "inherit", shell: false });
	return clone.status === 0;
}

/** Clone an existing repo while its caller owns the company transaction lock. */
function integrateRepoUnlocked(
	root: string,
	from: string,
	product: string,
	storage: ProductTransactionStorage,
): boolean {
	const department = scaffoldProductDepartmentUnlocked(root, product, storage);
	assertProductTransactionStorage(storage);
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
	assertProductTransactionStorage(storage);
	canonicalDirectory(root, department.path);
	canonicalDirectory(root, department.repositoryPath);
	if (cloneInto(from, destination)) {
		assertProductTransactionStorage(storage);
		canonicalDirectory(root, department.repositoryPath);
		console.log(`  cloned  ${from} -> ${department.repositoryPath}`);
		return true;
	}
	console.error(
		`Could not clone ${from}. Point it at a git repository (path or URL), or populate the product department repository and re-run.`,
	);
	return false;
}

/** Offline integration holds one transaction across registration and clone materialization. */
export function integrateRepo(root: string, from: string, product = basenameOf(from)): boolean {
	const lock = acquireCompanyLock(root, "product-registration");
	try {
		const storage = captureProductTransactionStorage(lock.root);
		return integrateRepoUnlocked(lock.root, from, product, storage);
	} finally {
		releaseCompanyRuntimeLock(lock);
	}
}

/** Desktop-kernel integration under the already-held runtime transaction. */
export function integrateRepoWithRuntimeLock(
	root: string,
	from: string,
	product: string,
	runtimeLock: CompanyRuntimeLock,
	storage: ProductTransactionStorage,
): ProductDepartment | undefined {
	const resolvedRoot = canonicalCompanyRoot(root);
	assertRuntimeLock(resolvedRoot, runtimeLock);
	if (!integrateRepoUnlocked(resolvedRoot, from, product, storage)) return undefined;
	return productDepartmentFromEntry(resolvedRoot, productDepartmentId(product));
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
			console.log("\nNext: open the company in Qorpera Base desktop.");
			return true;
		}
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
			console.error("Usage: company product add <product> [--from <repo-path-or-url>]");
			process.exitCode = 1;
			return true;
		}
		try {
			const root = process.cwd();
			if (!existsSync(join(root, "company.md"))) throw new Error("current directory is not a company root");
			if (from) {
				if (!integrateRepo(root, from, product)) throw new Error("product source clone failed");
			} else {
				scaffoldProductDepartment(root, product);
			}
			console.log(`Added ${productDepartmentId(product)}. Open the company in Qorpera Base.`);
			process.exitCode = 0;
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return true;
	}
	if (sub !== "init") {
		console.error(`Unknown company command: ${sub ?? "(none)"}. Usage: company init [dir]`);
		process.exitCode = 1;
		return true;
	}
	const dir = args[2] ?? process.cwd();
	const result = scaffoldCompany(dir);
	printScaffoldReport(result);
	registerCompany(result.root);
	console.log(
		"\nNext: open the company in Qorpera Base desktop. Gates live in authority.toml; requests appear in inbox/.",
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
	const root = canonicalCompanyRoot(rootDir);
	const name = basenameOf(root);
	const existing = listCompanies().filter((record) => {
		try {
			return normalizedPath(canonicalCompanyRoot(record.root)) !== normalizedPath(root);
		} catch {
			return false;
		}
	});
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
			return await launchSession(result.root);
		}
	}
}
