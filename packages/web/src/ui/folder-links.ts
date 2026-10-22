import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";

/* Agents link a file or folder of their Company File in a message as a Markdown link with the `folder:` scheme and a
 * company-relative path: `[sales-dashboard.html](folder:designs/sales-dashboard.html)`. ui/markdown.ts draws one as a
 * link-styled button carrying the path, and the app opens Storage there (app/application.ts, views/settings.ts). */

/** The scheme, exactly as written: no other spelling counts. */
const SCHEME = "folder:";

/** The path a `folder:` link names: what follows the scheme, percent-decoded, as one plain company-relative path
 * (no leading or trailing slash, no empty, `.` or `..` name, no other scheme, within the Company File's own path
 * rules), or undefined for anything else, which is then never a folder link. */
export function folderLinkPath(href: string): string | undefined {
	if (!href.startsWith(SCHEME)) return undefined;
	try {
		return parseCloudCompanyPath(decodeURIComponent(href.slice(SCHEME.length)).normalize("NFC"));
	} catch {
		return undefined;
	}
}
