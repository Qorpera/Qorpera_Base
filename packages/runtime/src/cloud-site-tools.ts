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
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * Company sites (founder go, 3 November 2026; migration 20260930550000): an agent publishes a static website from the
 * company folder to a private link, https://sites.qorpera.com/<slug>/, which people outside the company open with a
 * password. The site-serve edge function serves it (supabase/functions/site-serve).
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
 * - The agent never sees the password: the founder reads, copies and changes it in Settings → Sites.
 * - unpublish_site takes one of the company's sites offline: its copy, password and visitors' sessions go.
 * - share_app (private app links, v195; migration 20260930562000, deploy/sites/APP-PREVIEW.md) shares one port of one
 *   of the company's always-on machines at https://<slug>-preview.qorpera.com/, behind a site's password: an app site
 *   is a company site of kind 'app'. Before the automatic review it asks the database whether the machine can serve
 *   one (refused at once if not, as is a machine that is not running), whether the slug makes a new app link or
 *   updates one, its link, and whether that needs a review (a new link, or one moved to another machine or port: a
 *   built-in access check, cloud-action-review.ts). Then the share issues a one-time claim, and the tool starts the link
 *   program with it on that machine itself, as machine_run starts a command (no time limit, no notify): the claim never
 *   reaches the model. The program trades the claim for its connection key at once, so the command members see in the
 *   machine's list holds nothing that still works.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
	"xml",
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
]);

export const CLOUD_PUBLISH_SITE_TOOL_DESCRIPTION =
	"Publish a static website from the company folder to a private link, https://sites.qorpera.com/<slug>/, that people outside the company open with a password. " +
	"source is a folder whose index.html is the home page (every web file under it goes out: HTML, CSS, JavaScript, JSON, text, images, fonts, audio, video, PDF), or one .html file, published as the home page. " +
	"Link the site's files to each other with relative links (about.html, img/logo.png), never links starting with /. At most 500 files and 25 MiB, 10 MiB a file; hidden files, links and other types are left out and named in the answer. Only static files are served: no server code runs. " +
	"slug is the site's name in its link: 3 to 48 lowercase letters, digits and hyphens. title is optional. " +
	"Each page runs sandboxed on its own: scripts, forms and links work, but it cannot keep data in the browser (localStorage, cookies) or show the site's own pages in an iframe, and a PDF may only download. " +
	"A site's first publish waits for an owner or admin to approve it on a card, and so does publishing it from another folder. Publishing the same slug again replaces the whole site at once and keeps its password. " +
	"You never see the password: tell the member the link and that the password is in Settings → Sites, where founders and admins see, copy and change it.";

export const CLOUD_UNPUBLISH_SITE_TOOL_DESCRIPTION =
	"Take one of the company's websites or app links offline: its link stops working. A website's published copy and password are deleted (the files stay in the company folder); an app link keeps its name and password for its next share_app, and the app keeps running on its machine. slug is the site's name in its link.";

export const CLOUD_SHARE_APP_TOOL_DESCRIPTION =
	"Share a server app (Node, Python, Docker, any program that answers HTTP) at a private link, https://<slug>-preview.qorpera.com/, that people outside the company open with a password, as they open a website. " +
	"The app runs on one of the company's always-on machines: start one with machine_start and lifetime always-on (a task machine sleeps, and its link stops), run the app there with machine_run listening on a port (on 127.0.0.1 or all addresses), then call share_app with the machine's name and that port. A coding session's work is on the machine at /company/code/<owner>/<name>/worktrees/<workerId>. " +
	"Static files (HTML, CSS, JavaScript, images) need no machine: publish them with publish_site instead. " +
	"slug is the link's name: 3 to 48 lowercase letters, digits and hyphens. title is optional. " +
	"The machine must be running. share_app starts the link program that connects the link to the app on that machine itself, as a command with no time limit (machine_list counts it; machine_read shows its status lines, machine_cancel stops it). The link works while it and the app run; otherwise the link says the app is not running. If it stops, call share_app again. The link passes HTTP requests, not WebSockets (a dev server's live reload does not work through it). " +
	"A first share waits for an owner or admin to approve it on a card, and so does sharing the link from another machine or port. Sharing the same slug again keeps its link and password. " +
	"You never see the password: tell the member the link and that the password is in Settings → Sites, where founders and admins see, copy and change it. unpublish_site turns the link off.";

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

function parseSlug(value: unknown): string {
	if (typeof value !== "string" || !SLUG.test(value))
		throw new CloudToolArgumentRefusal(
			"slug must be 3 to 48 lowercase letters, digits and hyphens, starting and ending with a letter or digit, such as wristband-shop",
		);
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
				typeof (item as { machineId?: unknown }).machineId === "string" &&
				UUID.test((item as { machineId: string }).machineId),
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
				slug: { type: "string", pattern: SLUG.source },
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
			if (PLATFORM_TOPS.has(companyPathKey(source).split("/")[0] ?? ""))
				throw new CloudToolArgumentRefusal(
					"source must be the company's own work, not a platform folder (QorperaOS, hooks, digital-post, bank, members)",
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
							? "The site has a new password. You never see it: the founder finds, copies and changes it in Settings → Sites."
							: "The password is unchanged. You never see it: it is in Settings → Sites.",
					next: "Tell the member the link, and that the password is in Settings → Sites. Visitors open the link and enter the password.",
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
			properties: { slug: { type: "string", pattern: SLUG.source } },
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
				slug: { type: "string", pattern: SLUG.source },
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
			let started: CloudMachineCommandReceipt | string;
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
				started = "its start could not be confirmed";
			}
			const password = shared.newPassword
				? "The link has a new password. You never see it: the founder finds, copies and changes it in Settings → Sites."
				: "The password is unchanged. You never see it: it is in Settings → Sites.";
			const link = {
				url,
				slug: prepared.slug,
				...(prepared.title === null ? {} : { title: prepared.title }),
				machine: prepared.machine,
				port: prepared.port,
				newPassword: shared.newPassword,
			};
			if (typeof started === "string")
				return {
					kind: "text",
					value: cloudToolJsonText({
						schema: "qorpera.app-share-result/v1",
						state: "not_connected",
						...link,
						reason: `The link is shared, but its link program did not start: ${started}.`,
						next: `Check machine_list: if ${prepared.machine} is not running, wake it with machine_start. Then call share_app again; until a link program runs, the link says the app is not running.`,
						password,
					}),
				};
			return {
				kind: "text",
				value: cloudToolJsonText({
					schema: "qorpera.app-share-result/v1",
					state: started.state === "running" ? "connecting" : "program_ended",
					...link,
					linkProgram: { commandId: started.commandId, state: started.state },
					next:
						started.state === "running"
							? `The link program runs on ${prepared.machine} (command ${started.commandId}) and connects the link to the app on port ${prepared.port}: the link works while it runs and the app answers on that port. A program from an earlier share of this link stops by itself. machine_read shows its status lines; if it stops, call share_app again. Tell the member the link, and that the password is in Settings → Sites.`
							: `The link program ended at once (${started.state}): read why with machine_read (machine ${prepared.machine}, command ${started.commandId}), then call share_app again.`,
					password,
				}),
			};
		},
	};
	return [publish, unpublish, share];
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
