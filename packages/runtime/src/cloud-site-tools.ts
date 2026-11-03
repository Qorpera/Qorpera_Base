import { createHash } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import { isUuid, type JsonValue, parseRecord } from "@qorpera/contracts";
import type { CloudCompanyFolderClient, CloudCompanyFolderFileEntry } from "./cloud-company-folder-client.ts";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "./cloud-company-path-gateway.ts";
import { CloudCompanyPathRpcRefusal } from "./cloud-company-path-refusal.ts";
import { CloudControlRpcRefused } from "./cloud-control-errors.ts";
import { unavailable } from "./cloud-folder-file-tools.ts";
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
 */

const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
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
	"Take one of the company's websites offline: its link stops working, and its published copy and password are deleted (the files stay in the company folder). slug is the site's name in its link.";

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

function plain(text: string): string {
	return PLAIN.test(text) ? text : text.replace(/[^ -~À-ÿ]/g, "?");
}

/** A refusal before anything began, with plain words only. */
function refuse(text: string): never {
	throw new CloudToolRefusal(plain(text).slice(0, 1000));
}

/** The database's refusal of a call that began nothing (a check, or a publish's begin), as the tool's answer. */
function relayed(error: unknown): never {
	if (error instanceof CloudControlRpcRefused || error instanceof CloudCompanyPathRpcRefusal) {
		const detail = error.detail.replace(/→/g, "->");
		refuse(detail && PLAIN.test(detail) ? detail : "NOT_AVAILABLE: publishing is not available now");
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

/** The two site tools for a company agent's run (never a worker's). */
export function cloudSiteTools(options: {
	binding: CloudNativeToolBinding;
	identity: CloudNativeToolIdentity;
	control: CloudCompanyPathControl;
	folder: CloudCompanyFolderClient;
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
			let title: string | null = null;
			if (input.title !== undefined) {
				if (typeof input.title !== "string" || !input.title.trim() || [...input.title.trim()].length > 120)
					throw new CloudToolArgumentRefusal("title must be 1 to 120 characters");
				title = input.title.trim();
				if (/\p{Cc}/u.test(title)) throw new CloudToolArgumentRefusal("title must be one line");
			}
			return { slug, source, title };
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
	return [publish, unpublish];
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
