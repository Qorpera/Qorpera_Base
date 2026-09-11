/** Deployment transport identity only. Tool authority still comes from the
 * native run, office descriptor and effect-time resource grants. */
export function parseCompanyComputerNativeUrl(value: string): { url: string; companyComputerId: string } {
	const url = new URL(value);
	const match = /^\/office\/([^/]+)\/native$/.exec(url.pathname);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.href !== value ||
		!match ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(match[1])
	)
		throw new Error("INVALID_OFFICE_NATIVE_URL");
	return { url: url.href, companyComputerId: match[1] };
}
