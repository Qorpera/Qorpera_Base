import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import { type CloudMachineCommandReceipt, isUuid, type JsonValue, parseRecord } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderFileEntry } from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "./cloud-company-path-gateway.ts";
import { CloudCompanyPathRpcRefusal } from "./cloud-company-path-refusal.ts";
import { CloudControlRpcRefused } from "./cloud-control-errors.ts";
import { unavailable } from "./cloud-folder-file-tools.ts";
import {
	CLOUD_MACHINE_TOOL_VERSION,
	CloudMachineAppRefusal,
	type CloudMachineCommandGateway,
	cloudMachineCommandRefusal,
} from "./cloud-machine-command-http.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import { type CloudNativeToolOperations, cloudNativeToolOperationEnvelope } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * Company sites (founder go, 3 November 2026; migration 20260930550000): an agent publishes a static website from the
 * company folder to a private address of its own, https://<slug>.qorpera.com/, which people outside the company open
 * with a password. The site-serve edge function serves it (supabase/functions/site-serve) at the top of that address, as
 * its own origin with no sandbox, since site hosts went on (own code storage, step 5.1, v247; deploy/sites/SITE-HOSTS.md);
 * the old link, https://sites.qorpera.com/<slug>/, answers 308 to it.
 *
 * - publish_site reads the source with the run's own view of the folder: a folder (its index.html is the home page) or
 *   one HTML file (published as index.html). Only web files go out (the database's list, `qorpera_site_content_type`);
 *   hidden files, links and other types are left out and named in the answer.
 * - Before the automatic review (`prepare`) it lists the files, takes their manifest and asks the database whether
 *   the slug makes a new site or updates one of the company's live sites. The review reads that, not the bare
 *   arguments: its card names the link, the files and their size. A new site is a built-in access check
 *   (cloud-action-review.ts), so an owner or admin approves it on a card; an update is reviewed as any outside effect.
 * - After the review it lists and reads the files again, refuses if they changed, then publishes in three steps: begin
 *   (the site with a new password on its first publish, and a new version naming every file; bytes the live version
 *   already has are copied in the database), the missing bytes in batches of at most 10 MiB, and finish, which switches
 *   the site to the new version at once. The same call again (its call id) continues or answers its own version.
 * - A source under code/ is refused before anything (own code storage, step 4): a repository kept in Qorpera goes live
 *   only when an owner or admin puts a version its checks made live (What's new, or the card under the agent's thread).
 * - The agent never sees the password: owners and admins read, copy and change it on the Sites page in the apps drawer,
 *   and copy it from the site's row under a message that links the site (web #1848).
 * - unpublish_site takes one of the company's sites offline: its copy, password and visitors' sessions go.
 * - share_app (private app links, v195; migration 20260930562000, deploy/sites/APP-PREVIEW.md) shares one port of one
 *   of the company's always-on machines at https://<slug>-preview.qorpera.com/, behind a site's password: an app site
 *   is a company site of kind 'app'. Before the automatic review it asks the database whether the machine can serve
 *   one (refused at once if not, as is a machine that is not running), whether the slug makes a new app link or
 *   updates one, its link, and whether that needs a review (a new link, or one moved to another machine or port: a
 *   built-in access check, cloud-action-review.ts). Then the share issues a one-time claim, and the platform starts the
 *   link program with it on that machine, as machine_run starts a command (no time limit, no notify); the tool's answer
 *   never holds the claim. The claim is a word of that command, so it shows on the machine and, cut to its first 300
 *   characters, in the members' command list; the program spends it within seconds for its connection key, and only
 *   the program that spent it can use it again.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
/** A machine's name, as machine_start gives one (cloud-machine-tools.ts). */
const MACHINE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The words the link program's command is made of: each is checked to be one shell word that needs no quoting (the
 * claim as base64 or base64url, the program's address on an app host, the host suffix as the database's settings
 * allow it, qorpera_site_settings.app_host_suffix). */
const CLAIM = /^[A-Za-z0-9_+/=-]{16,256}$/;
const CLIENT_URL = /^https:\/\/[a-z0-9][a-z0-9.-]{0,252}\/\.qorpera\/client\.mjs$/;
const HOST_SUFFIX = /^-[a-z0-9-]{0,14}(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** A site path segment, as the database stores it: no hidden file, no '..', no character a link would escape. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
export const SITE_MAX_FILES = 500;
export const SITE_MAX_BYTES = 25 * 1024 * 1024;
export const SITE_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** One upload call's bytes, so a call stays well inside the database's statement budget; a larger file (up to 10
 * MiB) goes alone. */
const PUT_BYTES = 4 * 1024 * 1024;
/** A source folder holds at most this many entries (folders, links and other files included). */
const MAX_LISTED = 2000;
/** The platform's own top folders, which never go out as a website. */
const PLATFORM_TOPS = new Set(["qorperaos", "hooks", "digital-post", "bank", "members"]);
/** Printable ASCII and Latin-1 letters, as the boundary relays a refusal. */
const PLAIN = /^[ -~À-ÿ]*$/;
const UPLOAD_MS = 60_000;

/** The extensions a site serves, as the database maps them (qorpera_site_content_type). */
const WEB_EXTENSIONS = new Set([
	"html",
	"htm",
	"css",
	"js",
	"mjs",
	"json",
	"map",
	"webmanifest",
	"txt",
	"csv",
	"vtt",
	"md",
	"xml",
	"rss",
	"atom",
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"ico",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"mp4",
	"webm",
	"mp3",
	"m4a",
	"ogg",
	"wav",
	"pdf",
	"wasm",
	"glb",
	"gltf",
]);

/** Where a site's or an app link's password is, which the agent never sees. A message that links one of the company's
 * sites shows the site's row under it, with the password's copy key for owners and admins (web #1848). */
const SITE_PASSWORD =
	"You never see the password, so never write one: put the address in your message as a link, and members see the site's row under it, where owners and admins copy the password. They also see, copy and change it on the Sites page in the apps drawer.";

export const CLOUD_PUBLISH_SITE_TOOL_DESCRIPTION = [
	"Publish a static website from the company folder to a private address of its own, https://<slug>.qorpera.com/, that people outside the company open with a password. Only static files are served: no server code runs (a server app goes by share_app).",
	"source is a folder whose index.html is the home page (every web file under it goes out: HTML, CSS, JavaScript, JSON, text, Markdown, VTT, RSS/Atom, WebAssembly, glTF/GLB, images, fonts, audio, video, PDF), or one .html file, published as the home page. Its files link each other from / (/img/logo.png) or relatively (img/logo.png): both work. At most 500 files and 25 MiB, 10 MiB a file; hidden files, links and other types are left out and named in the answer.",
	"Each site is its own origin: browser storage, cookies (never one with Domain=qorpera.com) and frames of its own pages work; other sites cannot frame it or load its files, and it gets no service worker.",
	`A site's first publish waits for an owner or admin to approve it on a card, and so does publishing it from another folder. Publishing the same slug again switches the site at once, keeps the last ten versions for rollback with manage_site, and keeps its password. ${SITE_PASSWORD}`,
].join("\n");

export const CLOUD_UNPUBLISH_SITE_TOOL_DESCRIPTION =
	"Take one of the company's websites or app links offline: its link stops working. A website's published copy and password are deleted (the files stay in the company folder); an app link keeps its name and password for its next share_app, and the app keeps running on its machine.";

export const CLOUD_SHARE_APP_TOOL_DESCRIPTION = [
	"Share a server app (Node, Python, Docker, any program that answers HTTP) at a private link, https://<slug>-preview.qorpera.com/, that people outside the company open with a password, as they open a website. Static files (HTML, CSS, JavaScript, images) need no machine: publish them with publish_site.",
	"The app runs on one of the company's always-on machines: start one with machine_start and lifetime always-on (a task machine sleeps, and its link stops), run the app there listening on a port (on 127.0.0.1 or all addresses), then call share_app with the machine's name and that port; the machine must be running. A coding session's work is on the machine at /company/code/<owner>/<name>/worktrees/<workerId>.",
	"The platform starts the link program that connects the link to the app on that machine, as a command with no time limit (machine_list counts it; machine_read shows its status lines; machine_cancel stops it). Its command carries a one-time code that the program spends within seconds; only that program can use it again. The link works while the program and the app run; otherwise it says the app is not running. If it stops, call share_app again. The link passes HTTP requests, long-lived SSE streams, and WebSockets (including dev server live reload and bidirectional realtime apps) with per-stream flow control and active health checks; once shared, manage_site can start and supervise the app under restart-on-failure systemd management, probe health, reload, stop, or read rolling NDJSON logs and crash summaries, and updating the shared port via share_app performs a zero-downtime target swap when healthy.",
	`A first share waits for an owner or admin to approve it on a card, and so does sharing the link from another machine or port. Sharing the same slug again keeps its link and password. ${SITE_PASSWORD} unpublish_site turns the link off.`,
].join("\n");

export const CLOUD_MANAGE_SITE_TOOL_DESCRIPTION = [
	"Inspect and manage the company's published websites and shared app links.",
	"- action list_versions: list retained versions of a static website (current live version, kept versions for instant rollback, and ready code builds) or inspect an app link's machine, port, and auth mode.",
	"- action rollback: atomically switch a publish_site static website back to a previously published version by versionId (keeps the current live version in history; repository code sites still release and roll back in What's new).",
	"- action app_start: launch a shared app link's process under supervised restart-on-failure systemd management (command, port, optional healthPath and cwd) with 4x16 MiB ring-rotated NDJSON logs and automatic crash summaries.",
	"- action app_health: inspect the supervised app unit's systemd state, restart count, local health probe result, and latest crash summary.",
	"- action app_reload: restart the supervised app unit in place or probe and update its port/healthPath.",
	"- action app_logs: query structured rolling NDJSON stdout/stderr logs and automatic crash summary (OOM kills, exit code/signal, restart count, recent stderr tail) for a hosted app link, with optional grep, tail (1-500, default 100), stream (stdout|stderr|all), and since (ISO-8601 timestamp).",
	"- action app_stop: stop the supervised app unit on its machine.",
].join("\n");

/** One file a site will serve: its path in the site and the folder entry it is read from. */
interface SiteFile {
	readonly path: string;
	readonly entry: CloudCompanyFolderFileEntry;
}

interface CollectedSite {
	readonly source: string;
	readonly kind: "folder" | "file";
	readonly files: readonly SiteFile[];
	readonly bytes: number;
	readonly manifestSha256: string;
	readonly skipped: readonly string[];
}

/** What the review and the effect read in place of the arguments (`prepare`). */
interface PreparedPublish {
	readonly slug: string;
	readonly source: string;
	readonly title: string | null;
	readonly kind: "folder" | "file";
	readonly mode: "new" | "update";
	readonly url: string;
	/** The live site's source folder, for an update; null for a new site. */
	readonly liveSource: string | null;
	readonly files: number;
	readonly bytes: number;
	readonly manifestSha256: string;
	/** The site's paths, as many as fit 16 KiB. */
	readonly paths: readonly string[];
	readonly pathsOmitted: number;
	readonly skipped: readonly string[];
	readonly skippedOmitted: number;
}

/** What share_app's review and effect read in place of the arguments (`prepare`). */
interface PreparedShare {
	readonly slug: string;
	readonly title: string | null;
	readonly machine: string;
	readonly port: number;
	readonly mode: "new" | "update";
	/** A new app link, or one moved to another machine or port: a built-in access check. Otherwise no review runs. */
	readonly needsReview: boolean;
	readonly url: string;
	/** The live link's machine and port, for an update; null for a new link (or a machine that was deleted). */
	readonly liveMachine: string | null;
	readonly livePort: number | null;
}

const isPort = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535;

/** An app link as the database gives it: https, the slug's own host, nothing after its slash. */
function appUrl(value: unknown, slug: string): string | undefined {
	if (typeof value !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	return url.protocol === "https:" &&
		url.href === value &&
		url.pathname === "/" &&
		!url.search &&
		!url.hash &&
		!url.username &&
		!url.password &&
		!url.port &&
		/^[a-z0-9.-]+$/.test(url.hostname) &&
		url.hostname.startsWith(slug) &&
		/^[-.]/.test(url.hostname.slice(slug.length))
		? value
		: undefined;
}

function plain(text: string): string {
	return PLAIN.test(text) ? text : text.replace(/[^ -~À-ÿ]/g, "?");
}

/** A refusal before anything began, with plain words only. */
function refuse(text: string): never {
	throw new CloudToolRefusal(plain(text).slice(0, 1000));
}

function machineMissing(name: string): string {
	return `APP_MACHINE_NOT_FOUND: the company has no machine named ${name}; start an always-on one with machine_start (lifetime always-on), or name one from machine_list`;
}

/** The database's refusal of a call that began nothing (a check, a publish's begin, a share), as the tool's answer. */
function relayed(error: unknown, unavailableText = "NOT_AVAILABLE: publishing is not available now"): never {
	if (error instanceof CloudControlRpcRefused || error instanceof CloudCompanyPathRpcRefusal) {
		const detail = error.detail.replace(/→/g, "->");
		refuse(detail && PLAIN.test(detail) ? detail : unavailableText);
	}
	throw error;
}

function manifestOf(files: readonly { path: string; sha256: string; bytes: number }[]): string {
	// Paths are ASCII: code-unit order is the database's byte order (collate "C").
	const lines = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => `${file.path}\t${file.sha256}\t${file.bytes}`);
	return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** The site path a folder entry gets, or why it is left out (null: not a web file, or hidden). */
function sitePath(relative: string): { path: string } | { skip: true } | { bad: true } {
	const segments = relative.split("/");
	if (segments.some((segment) => segment.startsWith("."))) return { skip: true };
	const extension = /\.([A-Za-z0-9]{1,12})$/.exec(segments.at(-1) ?? "")?.[1]?.toLowerCase();
	if (!extension || !WEB_EXTENSIONS.has(extension)) return { skip: true };
	if (
		segments.length > 16 ||
		relative.length > 512 ||
		segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")
	)
		return { bad: true };
	return { path: relative };
}

/** The name rule in one sentence, as every refusal of a site's name says it: the kernel's SITE_NAME_INVALID of
 * publish_site, share_app and unpublish_site (`qorpera_site_name_words()`, migration 20260930756000) and the coding
 * executor's for a checks file's `site.name`, byte for byte (cloud-site-tools.test.ts reads the migration's text). */
export const SITE_NAME_RULE =
	"A site's name is 3 to 48 characters of a to z, 0 to 9 and single hyphens, starts and ends with a letter or digit, does not end in -preview, does not contain qorpera, and is not a reserved name (such as app, api, mail, shop, login).";

/** What publish_site's and share_app's slug field says: the address the name makes, then the name rule (Codex sends no
 * pattern, so the rule reaches the model only in words). */
const slugField = (address: string) => `The name in its address, ${address}. ${SITE_NAME_RULE}`;

function parseSlug(value: unknown): string {
	// A slug of the wrong shape, refused here; one the kernel's rule refuses gets these same words from the kernel.
	if (typeof value !== "string" || !SLUG.test(value))
		throw new CloudToolArgumentRefusal(`SITE_NAME_INVALID: ${SITE_NAME_RULE}`);
	return value;
}

function parseTitle(value: JsonValue | undefined): string | null {
	if (value === undefined) return null;
	if (typeof value !== "string" || !value.trim() || [...value.trim()].length > 120)
		throw new CloudToolArgumentRefusal("title must be 1 to 120 characters");
	const title = value.trim();
	if (/\p{Cc}/u.test(title)) throw new CloudToolArgumentRefusal("title must be one line");
	return title;
}

function args(value: JsonValue, tool: string, required: readonly string[], optional: readonly string[] = []) {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal(`${tool} takes an object with ${[...required, ...optional].join(", ")}`);
	if (
		Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	)
		throw new CloudToolArgumentRefusal(
			`${tool} takes ${required.join(", ")}${optional.length ? ` and optionally ${optional.join(", ")}` : ""}`,
		);
	return value as Record<string, JsonValue>;
}

/** The site tools for a company agent's run (never a worker's): publish_site, unpublish_site and share_app. */
export function cloudSiteTools(options: {
	binding: CloudNativeToolBinding;
	identity: CloudNativeToolIdentity;
	control: CloudCompanyPathControl;
	folder: CloudCompanyFolderClient;
	/** The run's machine command gateway and operations, as its machine tools have them: share_app starts the link
	 * program with them. Absent when the run has no machines: share_app then refuses before anything happens. */
	machines?: {
		gateway: CloudMachineCommandGateway;
		operations: Pick<CloudNativeToolOperations, "execute">;
	};
}): CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(options.binding);
	const expected = Object.freeze({ ...options.identity });
	const { control, folder } = options;
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Site tool binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Site tool identity differs");
		context.signal.throwIfAborted();
	};
	const call = (
		method: CloudCompanyPathRpc,
		values: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs = 10_000,
	): Promise<unknown> =>
		cloudToolRequest(
			(requestSignal) => control.call(method, { p_binding: admitted, ...values }, requestSignal, timeoutMs),
			signal,
			timeoutMs,
		);

	/** The files a source would publish, read with the run's own view of the folder. */
	const collect = async (source: string, signal: AbortSignal): Promise<CollectedSite> => {
		let found: Awaited<ReturnType<CloudCompanyFolderClient["read"]>>["entry"];
		try {
			found = (await folder.read(source, signal)).entry;
		} catch (error) {
			return unavailable(error, "read");
		}
		if (!found) refuse("SITE_SOURCE_MISSING: nothing is at that path in the company folder");
		const files: SiteFile[] = [];
		const skipped: string[] = [];
		const badNames: string[] = [];
		let kind: "folder" | "file";
		if (found.kind === "symlink") refuse("SITE_SOURCE_LINK: the source is a link; name the folder or file itself");
		if (found.kind === "file") {
			kind = "file";
			if (!/\.html?$/i.test(found.path))
				refuse("SITE_SOURCE_NOT_HTML: a single file published as a site must be an .html file");
			files.push({ path: "index.html", entry: found });
		} else {
			kind = "folder";
			let listed: Awaited<ReturnType<CloudCompanyFolderClient["listAll"]>>;
			try {
				listed = await folder.listAll(found.path, { recursive: true, maxEntries: MAX_LISTED }, signal);
			} catch (error) {
				if (error instanceof Error && error.message === "Company folder listing has more entries than its bound")
					refuse(
						`SITE_TOO_MANY_FILES: the folder holds more than ${MAX_LISTED} entries; publish a folder with only the site's files`,
					);
				return unavailable(error, "listed");
			}
			const prefix = `${companyPathKey(found.path)}/`;
			for (const entry of listed.entries) {
				if (entry.kind === "folder") continue;
				if (!companyPathKey(entry.path).startsWith(prefix))
					throw new Error("Company folder listing left its folder");
				const relative = entry.path.slice(prefix.length);
				if (entry.kind === "symlink") {
					skipped.push(relative);
					continue;
				}
				const placed = sitePath(relative);
				if ("skip" in placed) skipped.push(relative);
				else if ("bad" in placed) badNames.push(relative);
				else files.push({ path: placed.path, entry });
			}
		}
		if (badNames.length)
			refuse(
				`SITE_FILE_NAME: rename these files and folders to letters, digits, dots, hyphens and underscores, not starting with a dot or hyphen: ${badNames.slice(0, 5).join(", ")}${badNames.length > 5 ? ` and ${badNames.length - 5} more` : ""}`,
			);
		if (!files.some((file) => file.path === "index.html"))
			refuse("SITE_NO_INDEX: the folder needs an index.html at its top, the site's home page");
		if (files.length > SITE_MAX_FILES)
			refuse(`SITE_TOO_MANY_FILES: a site has at most ${SITE_MAX_FILES} files; this one has ${files.length}`);
		const large = files.find((file) => file.entry.file.bytes > SITE_MAX_FILE_BYTES);
		if (large) refuse(`SITE_FILE_TOO_LARGE: ${large.path} is larger than 10 MiB`);
		const bytes = files.reduce((sum, file) => sum + file.entry.file.bytes, 0);
		if (bytes > SITE_MAX_BYTES) refuse("SITE_TOO_LARGE: a site is at most 25 MiB");
		return {
			source: found.path,
			kind,
			files,
			bytes,
			manifestSha256: manifestOf(
				files.map((file) => ({
					path: file.path,
					sha256: file.entry.file.fileSha256,
					bytes: file.entry.file.bytes,
				})),
			),
			skipped,
		};
	};

	/** The company's machine of this name, which must be running: share_app starts its link program on it at once. */
	const runningMachine = async (name: string, signal: AbortSignal): Promise<{ machineId: string }> => {
		let listed: Record<string, unknown>;
		try {
			listed = parseRecord(
				await call("qorpera_native_machine_manage", { p_request: { action: "list" } }, signal),
				"Machine list differs",
			);
		} catch (error) {
			return relayed(error, "NOT_AVAILABLE: the company's machines cannot be read now");
		}
		if (listed.schema !== "qorpera.machine-list/v1" || !Array.isArray(listed.machines))
			throw new Error("Machine list differs");
		const found = (listed.machines as unknown[]).find(
			(item): item is { machineId: string; name: string; state: string } =>
				!!item &&
				typeof item === "object" &&
				(item as { name?: unknown }).name === name &&
				isUuid((item as { machineId?: unknown }).machineId),
		);
		if (!found) refuse(machineMissing(name));
		if (found.state !== "running")
			refuse(
				`APP_MACHINE_NOT_RUNNING: ${name} is ${typeof found.state === "string" && PLAIN.test(found.state) ? found.state : "not running"}; wake it with machine_start (pass only machine with its name), and call share_app again once it runs`,
			);
		return { machineId: found.machineId };
	};

	const publish: CloudNativeTool = {
		name: "publish_site" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_PUBLISH_SITE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["slug", "source"],
			properties: {
				slug: {
					type: "string",
					pattern: SLUG.source,
					description: slugField("https://<slug>.qorpera.com/"),
				},
				source: { type: "string", minLength: 1, maxLength: 4096 },
				title: { type: "string", minLength: 1, maxLength: 120 },
			},
		},
		parseArguments(value) {
			const input = args(value, "publish_site", ["slug", "source"], ["title"]);
			const slug = parseSlug(input.slug);
			let source: string;
			try {
				source = parseCloudCompanyPath(input.source, false);
			} catch {
				throw new CloudToolArgumentRefusal(
					"source must be a company-relative path to a folder or an .html file, like product/webshop (no leading or trailing /)",
				);
			}
			const top = companyPathKey(source).split("/")[0] ?? "";
			if (PLATFORM_TOPS.has(top))
				throw new CloudToolArgumentRefusal(
					"source must be the company's own work, not a platform folder (QorperaOS, hooks, digital-post, bank, members)",
				);
			// Own code storage, step 4: a repository kept in Qorpera goes live only when an owner or admin puts it live,
			// never through this tool; refused here, before the review and any card (SQL refuses it again in begin).
			if (top === "code")
				throw new CloudToolArgumentRefusal(
					"source must not be under code/: a repository kept in Qorpera goes live only when an owner or admin puts it live",
				);
			return { slug, source, title: parseTitle(input.title) };
		},
		// Everything the publish sends out, for the reviewer: every path the prepare listed (bounded there), and what it
		// leaves out.
		reviewContents(parsed) {
			const prepared = parsed as unknown as PreparedPublish;
			return {
				files: [...prepared.paths],
				filesNotListed: prepared.pathsOmitted,
				leftOut: [...prepared.skipped],
				leftOutNotListed: prepared.skippedOmitted,
			};
		},
		async prepare(value, context) {
			assertContext(context);
			const input = value as { slug: string; source: string; title: string | null };
			const site = await collect(input.source, context.signal);
			let checked: Record<string, unknown>;
			try {
				checked = parseRecord(
					await call("qorpera_site_publish_check", { p_slug: input.slug }, context.signal),
					"Site check differs",
				);
			} catch (error) {
				return relayed(error);
			}
			if (
				checked.schema !== "qorpera.site-publish-check/v1" ||
				checked.slug !== input.slug ||
				(checked.mode !== "new" && checked.mode !== "update") ||
				typeof checked.url !== "string" ||
				(checked.liveSource !== null && typeof checked.liveSource !== "string")
			)
				throw new Error("Site check differs");
			const paths: string[] = [];
			let used = 0;
			for (const file of site.files.map((item) => item.path).sort()) {
				used += file.length + 4;
				if (used > 16 * 1024) break;
				paths.push(file);
			}
			const skipped: string[] = [];
			used = 0;
			for (const name of site.skipped) {
				used += name.length + 4;
				if (used > 4 * 1024 || skipped.length === 20) break;
				skipped.push(name);
			}
			const prepared: PreparedPublish = {
				slug: input.slug,
				source: site.source,
				title: input.title,
				kind: site.kind,
				mode: checked.mode as "new" | "update",
				url: checked.url as string,
				liveSource: (checked.liveSource as string | null) ?? null,
				files: site.files.length,
				bytes: site.bytes,
				manifestSha256: site.manifestSha256,
				paths,
				pathsOmitted: site.files.length - paths.length,
				skipped,
				skippedOmitted: site.skipped.length - skipped.length,
			};
			return prepared as unknown as JsonValue;
		},
		async execute(value, context) {
			assertContext(context);
			const prepared = value as unknown as PreparedPublish;
			// Read again after the review: the files must be the ones it saw.
			const site = await collect(prepared.source, context.signal);
			if (site.manifestSha256 !== prepared.manifestSha256)
				refuse(
					"SITE_SOURCE_CHANGED: the files changed after this call was reviewed, so nothing was published; call publish_site again",
				);
			let begun: Record<string, unknown>;
			try {
				begun = parseRecord(
					await call(
						"qorpera_site_publish_begin",
						{
							p_call_id: context.callId,
							p_request: {
								slug: prepared.slug,
								title: prepared.title,
								source: site.source,
								manifestSha256: site.manifestSha256,
								files: site.files.map((file) => ({
									path: file.path,
									bytes: file.entry.file.bytes,
									sha256: file.entry.file.fileSha256,
								})),
							},
							p_review_id: isUuid(context.actionReviewId) ? context.actionReviewId : null,
						},
						context.signal,
						30_000,
					),
					"Site publish differs",
				);
			} catch (error) {
				// The begin is the publish's first effect: its refusal means nothing happened.
				return relayed(error);
			}
			let receipt = checkedReceipt(begun, prepared.slug);
			if (receipt.state !== "live") {
				try {
					const byPath = new Map(site.files.map((file) => [file.path, file]));
					let missing = receipt.missing;
					for (let round = 0; missing.length && round < 2; round++) {
						let batch: { path: string; content: string }[] = [];
						let batchBytes = 0;
						const send = async () => {
							if (!batch.length) return;
							const put = parseRecord(
								await call(
									"qorpera_site_publish_put",
									{ p_version_id: receipt.versionId, p_files: batch },
									context.signal,
									UPLOAD_MS,
								),
								"Site upload differs",
							);
							if (put.schema !== "qorpera.site-publish-put/v1" || !Array.isArray(put.missing))
								throw new Error("Site upload differs");
							missing = put.missing as string[];
							batch = [];
							batchBytes = 0;
						};
						for (const path of [...missing]) {
							const file = byPath.get(path);
							if (!file) throw new Error("Site upload names a file it was not given");
							if (batchBytes + file.entry.file.bytes > PUT_BYTES) await send();
							let bytes: Uint8Array;
							try {
								bytes = await folder.readRange(file.entry, 0, file.entry.file.bytes, context.signal);
							} catch (error) {
								return unavailable(error, "read");
							}
							batch.push({ path, content: Buffer.from(bytes).toString("base64") });
							batchBytes += bytes.byteLength;
						}
						await send();
					}
					if (missing.length) throw new Error("Site upload did not complete");
					receipt = checkedReceipt(
						parseRecord(
							await call(
								"qorpera_site_publish_finish",
								{ p_version_id: receipt.versionId },
								context.signal,
								30_000,
							),
							"Site publish differs",
						),
						prepared.slug,
					);
				} catch (error) {
					// After the begin something exists (a new site's name and password, an open upload), so a refusal is
					// told as it is, never as a call that changed nothing.
					if (!(error instanceof CloudControlRpcRefused || error instanceof CloudCompanyPathRpcRefusal))
						throw error;
					// Qorpera took the site down meanwhile (step 5.1): its own words, which the agent passes on, and never
					// the site's link.
					if (error.detail.startsWith("SITE_TAKEN_DOWN: ") && PLAIN.test(error.detail)) refuse(error.detail);
					return {
						kind: "text",
						value: cloudToolJsonText({
							schema: "qorpera.site-publish-result/v1",
							state: "not_live",
							url: receipt.url,
							slug: prepared.slug,
							reason: PLAIN.test(error.detail) ? error.detail : "the upload was refused",
							next: "Nothing new is live: the site shows what it showed before (a new site shows nothing yet). Call publish_site again.",
						}),
					};
				}
				if (receipt.state !== "live") throw new Error("Site publish differs");
			}
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.site-publish-result/v1",
					state: "live",
					url: receipt.url,
					slug: prepared.slug,
					title: prepared.title,
					mode: receipt.mode,
					unchanged: receipt.unchanged,
					files: receipt.files,
					bytes: receipt.bytes,
					...(prepared.skipped.length ? { leftOut: prepared.skipped, leftOutMore: prepared.skippedOmitted } : {}),
					password:
						receipt.mode === "new"
							? "The site has a new password. You never see it: owners and admins find, copy and change it on the Sites page in the apps drawer."
							: "The password is unchanged. You never see it: it is on the Sites page in the apps drawer.",
					next: "Put url in your message to the member as a link: the site's row shows under it, where owners and admins copy the password (also on the Sites page in the apps drawer). Never write a password. Visitors open the address and enter the password.",
				}),
			};
		},
	};

	const unpublish: CloudNativeTool = {
		name: "unpublish_site" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_UNPUBLISH_SITE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["slug"],
			properties: {
				slug: { type: "string", pattern: SLUG.source, description: "The site's or app link's name in its link." },
			},
		},
		parseArguments(value) {
			return { slug: parseSlug(args(value, "unpublish_site", ["slug"]).slug) };
		},
		async execute(value, context) {
			assertContext(context);
			const { slug } = value as { slug: string };
			let answer: Record<string, unknown>;
			try {
				answer = parseRecord(
					await call("qorpera_site_unpublish", { p_slug: slug }, context.signal),
					"Site unpublish differs",
				);
			} catch (error) {
				return relayed(error);
			}
			if (
				answer.schema !== "qorpera.site-unpublish/v1" ||
				answer.slug !== slug ||
				typeof answer.removed !== "boolean"
			)
				throw new Error("Site unpublish differs");
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.site-unpublish-result/v1",
					slug,
					removed: answer.removed,
					...(answer.removed
						? {}
						: { note: "The company has no site with this name: nothing was taken offline." }),
				}),
			};
		},
	};
	const share: CloudNativeTool = {
		name: "share_app" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_SHARE_APP_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["slug", "machine", "port"],
			properties: {
				slug: {
					type: "string",
					pattern: SLUG.source,
					description: slugField("https://<slug>-preview.qorpera.com/"),
				},
				title: { type: "string", minLength: 1, maxLength: 120 },
				machine: { type: "string", pattern: MACHINE.source },
				port: { type: "integer", minimum: 1, maximum: 65535 },
			},
		},
		parseArguments(value) {
			const input = args(value, "share_app", ["slug", "machine", "port"], ["title"]);
			const slug = parseSlug(input.slug);
			if (typeof input.machine !== "string" || !MACHINE.test(input.machine))
				throw new CloudToolArgumentRefusal(
					"machine must be the name of one of the company's machines, as machine_list shows it",
				);
			if (!isPort(input.port))
				throw new CloudToolArgumentRefusal(
					"port must be the app's port on the machine, a whole number from 1 to 65535",
				);
			return { slug, title: parseTitle(input.title), machine: input.machine, port: input.port };
		},
		async prepare(value, context) {
			assertContext(context);
			const input = value as { slug: string; title: string | null; machine: string; port: number };
			if (!options.machines)
				refuse(
					"APP_MACHINES_UNAVAILABLE: this run cannot start programs on the company's machines, so no link can connect; try again later",
				);
			let checked: Record<string, unknown>;
			try {
				checked = parseRecord(
					await call(
						"qorpera_site_share_check",
						{ p_slug: input.slug, p_machine: input.machine, p_port: input.port },
						context.signal,
					),
					"App share check differs",
				);
			} catch (error) {
				return relayed(error, "NOT_AVAILABLE: sharing apps is not available now");
			}
			// A share the database would refuse for its machine is refused here, before any card asks for approval.
			if (checked.state === "refused") {
				if (checked.reason === "APP_MACHINE_NOT_FOUND") refuse(machineMissing(input.machine));
				if (checked.reason === "APP_MACHINE_NOT_ALWAYS_ON")
					refuse(
						`APP_MACHINE_NOT_ALWAYS_ON: ${input.machine} is a task machine, which sleeps when its task is done, so its link would stop; run the app on an always-on machine (machine_start with lifetime always-on) and share from that`,
					);
				throw new Error("App share check differs");
			}
			const url = appUrl(checked.url, input.slug);
			const liveMachine = checked.machine ?? null;
			const livePort = checked.port ?? null;
			if (
				(checked.state !== "new" && checked.state !== "update" && checked.state !== "taken") ||
				typeof checked.needsReview !== "boolean" ||
				!url ||
				!HOST_SUFFIX.test(new URL(url).hostname.slice(input.slug.length)) ||
				(liveMachine !== null && (typeof liveMachine !== "string" || !MACHINE.test(liveMachine))) ||
				(livePort !== null && !isPort(livePort))
			)
				throw new Error("App share check differs");
			if (checked.state === "taken")
				refuse(
					"APP_NAME_TAKEN: another site already has this name, or it is one of the company's websites from publish_site (an app link never replaces one); choose another slug",
				);
			// The link program starts as soon as the share is made: a machine that is not running is refused now, before
			// any card.
			await runningMachine(input.machine, context.signal);
			const prepared: PreparedShare = {
				slug: input.slug,
				title: input.title,
				machine: input.machine,
				port: input.port,
				mode: checked.state as "new" | "update",
				// The database's say: a new link, or a live one shared from another machine or port (qorpera_site_share_app
				// requires the approval of exactly those).
				needsReview: checked.needsReview,
				url,
				liveMachine: liveMachine as string | null,
				livePort: livePort as number | null,
			};
			return prepared as unknown as JsonValue;
		},
		async execute(value, context) {
			assertContext(context);
			const prepared = value as unknown as PreparedShare;
			const machines = options.machines;
			if (!machines) throw new Error("App link machines unavailable");
			// Read again after the review: the program starts on the machine as it runs now.
			const machine = await runningMachine(prepared.machine, context.signal);
			let shared: Record<string, unknown>;
			try {
				shared = parseRecord(
					await call(
						"qorpera_site_share_app",
						{
							p_call_id: context.callId,
							p_request: {
								slug: prepared.slug,
								...(prepared.title === null ? {} : { title: prepared.title }),
								machine: prepared.machine,
								port: prepared.port,
							},
							p_review_id: isUuid(context.actionReviewId) ? context.actionReviewId : null,
						},
						context.signal,
						30_000,
					),
					"App share differs",
				);
			} catch (error) {
				// The share is the call's first effect: its refusal means nothing happened.
				return relayed(error, "NOT_AVAILABLE: sharing apps is not available now");
			}
			// Every word of the command is checked to be what it should be, so it runs as one plain shell line; the link is
			// the one the review named, and the program comes from its own host.
			const url = appUrl(shared.url, prepared.slug);
			const suffix = url ? new URL(url).hostname.slice(prepared.slug.length) : "";
			if (
				shared.slug !== prepared.slug ||
				!url ||
				url !== prepared.url ||
				!HOST_SUFFIX.test(suffix) ||
				shared.machine !== prepared.machine ||
				shared.port !== prepared.port ||
				typeof shared.newPassword !== "boolean" ||
				typeof shared.claim !== "string" ||
				!CLAIM.test(shared.claim) ||
				typeof shared.clientUrl !== "string" ||
				!CLIENT_URL.test(shared.clientUrl) ||
				new URL(shared.clientUrl).host !== new URL(url).host
			)
				throw new Error("App share differs");
			// One file a link, written whole before it runs.
			const file = `/root/.qorpera-app-link-${prepared.slug}.mjs`;
			const command = `curl -fsS ${shared.clientUrl} -o ${file}.tmp && mv -f ${file}.tmp ${file} && exec node ${file} ${prepared.slug} ${prepared.port} ${shared.claim} ${suffix}`;
			const operationKey = `share-app.${createHash("sha256").update(context.callId).digest("hex").slice(0, 32)}`;
			// The command's receipt; why it did not start; or undefined when whether it started is not known.
			let started: CloudMachineCommandReceipt | string | undefined;
			try {
				const content = await machines.operations.execute({
					// A command on the machine, as machine_run starts one (its receipt is the command's authority), with no time
					// limit and no notify: the link works while it runs.
					operation: {
						tool: "machine_run",
						toolVersion: CLOUD_MACHINE_TOOL_VERSION,
						logicalOperationKey: operationKey,
						arguments: { operationKey, machine: prepared.machine, command, notify: false },
						target: { realm: "company_machine", machineId: machine.machineId },
						requiresCompanyRevision: false,
					},
					signal: context.signal,
					authorize: async (_operation, admittedIdentity) => {
						if (!isDeepStrictEqual(admittedIdentity, expected))
							throw new Error("App link program identity changed");
					},
					perform: async (_operation, effect) => {
						try {
							const receipt = await machines.gateway.start(
								{ machineId: machine.machineId },
								{
									commandId: effect.receiptId,
									inputSha256: effect.inputSha256,
									command,
									timeoutMs: null,
									notify: false,
								},
								effect.signal,
							);
							return { content: { kind: "json", value: receipt as unknown as JsonValue } };
						} catch (error) {
							// The executor refused before anything started.
							const refusal = cloudMachineCommandRefusal(error);
							if (refusal === "MACHINE_NOT_RUNNING" || refusal === "MACHINE_COMMAND_ENDED")
								return { content: { kind: "json", value: { refused: refusal } } };
							throw error;
						}
					},
				});
				const answer = content.kind === "json" ? content.value : null;
				const result = (answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {}) as Record<
					string,
					JsonValue | undefined
				>;
				if (typeof result.refused === "string") started = `${prepared.machine} stopped before the program started`;
				else if (
					result.schema === "qorpera.machine-command-result/v1" &&
					typeof result.commandId === "string" &&
					typeof result.state === "string"
				)
					started = result as unknown as CloudMachineCommandReceipt;
				else throw new Error("App link program result differs");
			} catch {
				context.signal.throwIfAborted();
				started = undefined;
			}
			const password = shared.newPassword
				? "The link has a new password. You never see it: owners and admins find, copy and change it on the Sites page in the apps drawer."
				: "The password is unchanged. You never see it: it is on the Sites page in the apps drawer.";
			const link = {
				url,
				slug: prepared.slug,
				...(prepared.title === null ? {} : { title: prepared.title }),
				machine: prepared.machine,
				port: prepared.port,
				newPassword: shared.newPassword,
			};
			const reply = (state: string, extra: Record<string, JsonValue>) => ({
				kind: "text" as const,
				value: cloudToolJsonText({ schema: "qorpera.app-share-result/v1", state, ...link, ...extra, password }),
			});
			if (typeof started === "string")
				return reply("not_connected", {
					reason: `The link is shared, but its link program did not start: ${started}.`,
					next: `Check machine_list: if ${prepared.machine} is not running, wake it with machine_start. Then call share_app again; until a link program runs, the link says the app is not running.`,
				});
			// Whether the program started is not known: it may run, so the agent looks before it shares again.
			if (started === undefined || started.state === "unconfirmed")
				return reply("program_unconfirmed", {
					...(started ? { linkProgram: { commandId: started.commandId, state: started.state } } : {}),
					reason: "The link is shared, but the start of its link program could not be confirmed.",
					next: started
						? `Check it with machine_read (machine ${prepared.machine}, command ${started.commandId}) or machine_list. If it does not run, call share_app again; a new program replaces any earlier one of this link.`
						: `If machine_list shows no running command on ${prepared.machine}, call share_app again; a new program replaces any earlier one of this link.`,
				});
			const linkProgram = { commandId: started.commandId, state: started.state };
			if (started.state !== "running")
				return reply("program_ended", {
					linkProgram,
					next: `The link program ended at once (${started.state}): read why with machine_read (machine ${prepared.machine}, command ${started.commandId}), then call share_app again.`,
				});
			return reply("connecting", {
				linkProgram,
				next: `The platform started the link program on ${prepared.machine} (command ${started.commandId}); it connects the link to the app on port ${prepared.port}, and the link works while it runs and the app answers on that port. A program from an earlier share of this link stops by itself. machine_read shows its status lines; if it stops, call share_app again. Put url in your message to the member as a link: the link's row shows under it, where owners and admins copy the password (also on the Sites page in the apps drawer). Never write a password.`,
			});
		},
	};
	const manage: CloudNativeTool = {
		name: "manage_site" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_MANAGE_SITE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action", "slug"],
			properties: {
				action: {
					type: "string",
					enum: ["list_versions", "rollback", "app_start", "app_stop", "app_health", "app_reload", "app_logs"],
				},
				slug: { type: "string", pattern: SLUG.source, description: "The site's or app link's name in its link." },
				versionId: {
					type: "string",
					description: "The version UUID to activate (required when action is rollback).",
				},
				command: {
					type: "string",
					minLength: 1,
					maxLength: 32768,
					description: "Shell command to supervise under systemd (required when action is app_start).",
				},
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535,
					description: "Port the app listens on (required for app_start, optional for app_reload).",
				},
				healthPath: {
					type: "string",
					maxLength: 256,
					description: "Optional HTTP health probe path starting with / (for app_start or app_reload).",
				},
				cwd: {
					type: "string",
					minLength: 1,
					maxLength: 512,
					description: "Optional absolute working directory on the machine (for app_start).",
				},
				grep: { type: "string", minLength: 1, maxLength: 256 },
				tail: { type: "integer", minimum: 1, maximum: 500 },
				stream: { type: "string", enum: ["stdout", "stderr", "all"] },
				since: { type: "string", minLength: 1, maxLength: 64 },
			},
		},
		parseArguments(value) {
			const input = args(
				value,
				"manage_site",
				["action", "slug"],
				["versionId", "command", "port", "healthPath", "cwd", "grep", "tail", "stream", "since"],
			);
			const action = input.action;
			const validActions = [
				"list_versions",
				"rollback",
				"app_start",
				"app_stop",
				"app_health",
				"app_reload",
				"app_logs",
			];
			if (typeof action !== "string" || !validActions.includes(action))
				throw new CloudToolArgumentRefusal(
					"action must be list_versions, rollback, app_start, app_stop, app_health, app_reload, or app_logs",
				);
			const slug = parseSlug(input.slug);
			const forbid = (allowed: readonly string[], msg: string) => {
				for (const key of Object.keys(input))
					if (key !== "action" && key !== "slug" && !allowed.includes(key))
						throw new CloudToolArgumentRefusal(msg);
			};
			if (action === "list_versions" || action === "app_stop" || action === "app_health") {
				forbid([], `${action} takes only action and slug`);
				return { action, slug };
			}
			if (action === "rollback") {
				forbid(["versionId"], "rollback takes only action, slug, and versionId");
				if (typeof input.versionId !== "string" || !isUuid(input.versionId))
					throw new CloudToolArgumentRefusal("versionId must be a valid version UUID");
				return { action, slug, versionId: input.versionId };
			}
			if (action === "app_start") {
				forbid(
					["command", "port", "healthPath", "cwd"],
					"app_start takes command, port, and optional healthPath/cwd",
				);
				if (
					typeof input.command !== "string" ||
					!input.command.trim() ||
					input.command.includes("\0") ||
					Buffer.byteLength(input.command) > 32768
				)
					throw new CloudToolArgumentRefusal("command must be a non-empty string up to 32768 bytes");
				if (!isPort(input.port))
					throw new CloudToolArgumentRefusal(
						"port must be the app's port on the machine, a whole number from 1 to 65535",
					);
				const parsed: Record<string, JsonValue> = { action, slug, command: input.command, port: input.port };
				if (input.healthPath !== undefined) {
					if (
						typeof input.healthPath !== "string" ||
						(input.healthPath !== "" &&
							(!input.healthPath.startsWith("/") ||
								input.healthPath.length > 256 ||
								/[\x00-\x1f\x7f\s]/.test(input.healthPath)))
					)
						throw new CloudToolArgumentRefusal("healthPath must be empty or a / path without whitespace");
					parsed.healthPath = input.healthPath;
				}
				if (input.cwd !== undefined) {
					if (
						typeof input.cwd !== "string" ||
						!input.cwd.startsWith("/") ||
						input.cwd.length > 512 ||
						/[\0\r\n]/.test(input.cwd)
					)
						throw new CloudToolArgumentRefusal("cwd must be an absolute path up to 512 characters");
					parsed.cwd = input.cwd;
				}
				return parsed;
			}
			if (action === "app_reload") {
				forbid(["port", "healthPath"], "app_reload takes only optional port and healthPath");
				const parsed: Record<string, JsonValue> = { action, slug };
				if (input.port !== undefined) {
					if (!isPort(input.port))
						throw new CloudToolArgumentRefusal(
							"port must be the app's port on the machine, a whole number from 1 to 65535",
						);
					parsed.port = input.port;
				}
				if (input.healthPath !== undefined) {
					if (
						typeof input.healthPath !== "string" ||
						(input.healthPath !== "" &&
							(!input.healthPath.startsWith("/") ||
								input.healthPath.length > 256 ||
								/[\x00-\x1f\x7f\s]/.test(input.healthPath)))
					)
						throw new CloudToolArgumentRefusal("healthPath must be empty or a / path without whitespace");
					parsed.healthPath = input.healthPath;
				}
				return parsed;
			}
			forbid(["grep", "tail", "stream", "since"], "app_logs does not take versionId or app control options");
			const parsed: Record<string, JsonValue> = { action, slug };
			if (input.grep !== undefined) {
				if (
					typeof input.grep !== "string" ||
					!input.grep.length ||
					input.grep.length > 256 ||
					/\p{Cc}/u.test(input.grep)
				)
					throw new CloudToolArgumentRefusal("grep must be a single-line string of 1 to 256 characters");
				parsed.grep = input.grep;
			}
			if (input.tail !== undefined) {
				if (
					typeof input.tail !== "number" ||
					!Number.isSafeInteger(input.tail) ||
					input.tail < 1 ||
					input.tail > 500
				)
					throw new CloudToolArgumentRefusal("tail must be a whole number from 1 to 500");
				parsed.tail = input.tail;
			}
			if (input.stream !== undefined) {
				if (input.stream !== "stdout" && input.stream !== "stderr" && input.stream !== "all")
					throw new CloudToolArgumentRefusal("stream must be stdout, stderr, or all");
				parsed.stream = input.stream;
			}
			if (input.since !== undefined) {
				if (
					typeof input.since !== "string" ||
					!input.since.length ||
					input.since.length > 64 ||
					Number.isNaN(Date.parse(input.since))
				)
					throw new CloudToolArgumentRefusal("since must be an ISO-8601 timestamp");
				parsed.since = input.since;
			}
			return parsed;
		},
		async execute(value, context) {
			assertContext(context);
			const input = value as {
				action: "list_versions" | "rollback" | "app_start" | "app_stop" | "app_health" | "app_reload" | "app_logs";
				slug: string;
				versionId?: string;
				command?: string;
				port?: number;
				healthPath?: string;
				cwd?: string;
				grep?: string;
				tail?: number;
				stream?: "stdout" | "stderr" | "all";
				since?: string;
			};
			if (input.action === "list_versions") {
				let answer: Record<string, unknown>;
				try {
					answer = parseRecord(
						await call("qorpera_site_agent_list_versions", { p_slug: input.slug }, context.signal),
						"Site versions differ",
					);
				} catch (error) {
					return relayed(error, "NOT_AVAILABLE: site versions cannot be listed now");
				}
				if (
					answer.schema !== "qorpera.site-versions/v1" ||
					answer.slug !== input.slug ||
					!Array.isArray(answer.versions)
				)
					throw new Error("Site versions differ");
				return { kind: "text", value: cloudToolJsonText(answer as unknown as JsonValue) };
			}
			if (input.action === "rollback") {
				let answer: Record<string, unknown>;
				try {
					answer = parseRecord(
						await call(
							"qorpera_site_agent_activate_version",
							{ p_slug: input.slug, p_version_id: input.versionId },
							context.signal,
							30_000,
						),
						"Site rollback differs",
					);
				} catch (error) {
					return relayed(error, "NOT_AVAILABLE: site rollback is not available now");
				}
				if (
					answer.schema !== "qorpera.site-version-activate/v1" ||
					answer.slug !== input.slug ||
					typeof answer.versionId !== "string" ||
					!isUuid(answer.versionId)
				)
					throw new Error("Site rollback differs");
				return { kind: "text", value: cloudToolJsonText(answer as unknown as JsonValue) };
			}
			let site: Record<string, unknown>;
			try {
				site = parseRecord(
					await call("qorpera_site_agent_list_versions", { p_slug: input.slug }, context.signal),
					"Site versions differ",
				);
			} catch (error) {
				return relayed(error, `NOT_AVAILABLE: ${input.action} cannot run now`);
			}
			if (site.schema !== "qorpera.site-versions/v1" || site.slug !== input.slug)
				throw new Error("Site versions differ");
			if (site.kind !== "app")
				refuse(`APP_SITE_REQUIRED: ${input.action} only applies to app links created with share_app`);
			if (
				typeof site.machineId !== "string" ||
				!isUuid(site.machineId) ||
				typeof site.machine !== "string" ||
				!MACHINE.test(site.machine)
			)
				refuse("APP_MACHINE_NOT_FOUND: this app link has no active machine");
			const scope = { machineId: site.machineId };
			const machines = options.machines;
			const gw = machines?.gateway;
			const runApp = async <T>(fn: () => Promise<T>): Promise<T> => {
				try {
					return await fn();
				} catch (error) {
					if (error instanceof CloudMachineAppRefusal)
						refuse(`${error.code}: ${site.machine} refused ${input.action}`);
					const refusal = cloudMachineCommandRefusal(error);
					if (refusal) refuse(`${refusal}: ${site.machine} is not available for ${input.action}`);
					throw error;
				}
			};
			const runMutatingApp = async <T>(
				perform: (receiptId: string, envelope: string, signal: AbortSignal) => Promise<T>,
			): Promise<T> => {
				if (!machines) refuse("APP_CONTROL_UNAVAILABLE: app supervision is not available on this run's gateway");
				const operationKey = `manage-site.${createHash("sha256").update(context.callId).digest("hex").slice(0, 32)}`;
				const content = await machines.operations.execute({
					operation: {
						tool: "manage_site",
						toolVersion: CLOUD_MACHINE_TOOL_VERSION,
						logicalOperationKey: operationKey,
						arguments: input as unknown as JsonValue,
						target: { realm: "company_machine", machineId: scope.machineId },
						requiresCompanyRevision: false,
					},
					signal: context.signal,
					authorize: async (_operation, admittedIdentity) => {
						if (!isDeepStrictEqual(admittedIdentity, expected)) throw new Error("Manage site identity changed");
					},
					perform: async (operation, effect) => {
						const envelope = cloudNativeToolOperationEnvelope(effect.identity, operation);
						try {
							const answer = await perform(effect.receiptId, envelope, effect.signal);
							return { content: { kind: "json", value: answer as unknown as JsonValue } };
						} catch (error) {
							if (error instanceof CloudMachineAppRefusal)
								return { content: { kind: "json", value: { refused: error.code } } };
							const refusal = cloudMachineCommandRefusal(error);
							if (refusal) return { content: { kind: "json", value: { refused: refusal } } };
							throw error;
						}
					},
				});
				const answer = content.kind === "json" ? content.value : null;
				if (
					answer &&
					typeof answer === "object" &&
					!Array.isArray(answer) &&
					typeof (answer as Record<string, unknown>).refused === "string"
				)
					refuse(
						`${String((answer as Record<string, unknown>).refused)}: ${site.machine} refused ${input.action}`,
					);
				return answer as unknown as T;
			};
			if (input.action === "app_start") {
				const appStart = gw?.appStart;
				if (!appStart) refuse("APP_CONTROL_UNAVAILABLE: app supervision is not available on this run's gateway");
				const command = input.command ?? "";
				const port = input.port ?? 0;
				const started = await runMutatingApp((receiptId, envelope, signal) =>
					appStart(
						scope,
						{
							receiptId,
							envelope,
							slug: input.slug,
							command,
							port,
							...(input.healthPath !== undefined ? { healthPath: input.healthPath } : {}),
							...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
						},
						signal,
					),
				);
				return {
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.site-app-started/v1",
						slug: input.slug,
						machine: site.machine,
						unit: started.unit,
						port: started.port,
					}),
				};
			}
			if (input.action === "app_stop") {
				const appStop = gw?.appStop;
				if (!appStop) refuse("APP_CONTROL_UNAVAILABLE: app supervision is not available on this run's gateway");
				const stopped = await runMutatingApp((receiptId, envelope, signal) =>
					appStop(scope, { receiptId, envelope, slug: input.slug }, signal),
				);
				return {
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.site-app-stopped/v1",
						slug: input.slug,
						machine: site.machine,
						unit: stopped.unit,
					}),
				};
			}
			if (input.action === "app_health") {
				const appHealth = gw?.appHealth;
				if (!appHealth) refuse("APP_CONTROL_UNAVAILABLE: app health is not available on this run's gateway");
				const health = await runApp(() => appHealth(scope, { slug: input.slug }, context.signal));
				return {
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.site-app-health/v1",
						slug: input.slug,
						machine: site.machine,
						unit: health.unit,
						activeState: health.activeState,
						subState: health.subState,
						restarts: health.restarts,
						port: health.port,
						healthy: health.healthy,
						lastStatus: health.lastStatus,
						lastLatencyMs: health.lastLatencyMs,
						crashSummary: (health.crashSummary ?? null) as unknown as JsonValue,
					}),
				};
			}
			if (input.action === "app_reload") {
				const appReload = gw?.appReload;
				if (!appReload) refuse("APP_CONTROL_UNAVAILABLE: app reload is not available on this run's gateway");
				const reloaded = await runMutatingApp((receiptId, envelope, signal) =>
					appReload(
						scope,
						{
							receiptId,
							envelope,
							slug: input.slug,
							...(input.port !== undefined ? { port: input.port } : {}),
							...(input.healthPath !== undefined ? { healthPath: input.healthPath } : {}),
						},
						signal,
					),
				);
				return {
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.site-app-reload/v1",
						slug: input.slug,
						machine: site.machine,
						previousPort: reloaded.previousPort,
						activePort: reloaded.activePort,
						healthy: reloaded.healthy,
						restarted: reloaded.restarted,
					}),
				};
			}
			const appLogs = gw?.appLogs;
			if (!appLogs)
				refuse("APP_LOGS_UNAVAILABLE: structured app logs are not available on this run's machine gateway");
			const logs = await runApp(() =>
				appLogs(
					scope,
					{
						slug: input.slug,
						...(input.grep !== undefined ? { grep: input.grep } : {}),
						...(input.tail !== undefined ? { tail: input.tail } : {}),
						...(input.stream !== undefined ? { stream: input.stream } : {}),
						...(input.since !== undefined ? { since: input.since } : {}),
					},
					context.signal,
				),
			);
			if (logs.schema !== "qorpera.machine-app-logs/v1" || logs.slug !== input.slug || !Array.isArray(logs.lines))
				throw new Error("App logs differ");
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.site-app-logs/v1",
					slug: input.slug,
					machine: site.machine,
					port: typeof site.port === "number" ? site.port : null,
					lines: logs.lines as unknown as JsonValue,
					totalMatched: logs.totalMatched,
					truncated: logs.truncated,
					crashSummary: (logs.crashSummary ?? null) as unknown as JsonValue,
				}),
			};
		},
	};
	return [publish, unpublish, share, manage];
}

interface PublishReceipt {
	readonly versionId: string;
	readonly url: string;
	readonly mode: "new" | "update";
	readonly state: "live" | "uploading";
	readonly unchanged: boolean;
	readonly files: number;
	readonly bytes: number;
	readonly missing: string[];
}

function checkedReceipt(value: Record<string, unknown>, slug: string): PublishReceipt {
	if (
		value.schema !== "qorpera.site-publish/v1" ||
		value.slug !== slug ||
		typeof value.siteId !== "string" ||
		typeof value.versionId !== "string" ||
		!isUuid(value.versionId) ||
		typeof value.url !== "string" ||
		(value.mode !== "new" && value.mode !== "update") ||
		(value.state !== "live" && value.state !== "uploading") ||
		typeof value.unchanged !== "boolean" ||
		!Number.isSafeInteger(value.files) ||
		!Number.isSafeInteger(value.bytes) ||
		!Array.isArray(value.missing) ||
		value.missing.some((path) => typeof path !== "string") ||
		(value.state === "live" && value.missing.length > 0)
	)
		throw new Error("Site publish differs");
	return {
		versionId: value.versionId,
		url: value.url,
		mode: value.mode as "new" | "update",
		state: value.state as "live" | "uploading",
		unchanged: value.unchanged,
		files: value.files as number,
		bytes: value.bytes as number,
		missing: value.missing as string[],
	};
}
