import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";

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
