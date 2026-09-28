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

/** The placeholder a company route carries instead of one computer's id. */
export const COMPANY_COMPUTER_NATIVE_ROUTE_PLACEHOLDER = "{companyComputerId}";
const PLACEHOLDER_PROBE = "00000000-0000-4000-8000-000000000000";

/** A native route names one Company Computer (`/office/<id>/native`), or every
 * computer of the company (`/office/{companyComputerId}/native`): a company can
 * run several, and a run reaches the one its screen is on (migration
 * 20260928100100). A company route's transport token is accepted by every
 * computer of that company; tool authority still comes from the run, the office
 * descriptor and effect-time grants. */
export function parseCompanyComputerNativeRoute(value: string): {
	url: string;
	/** Null for a company route. */
	companyComputerId: string | null;
	/** The endpoint for one computer; a one-computer route refuses any other. */
	urlFor(companyComputerId: string): string;
} {
	if (typeof value === "string" && value.includes(COMPANY_COMPUTER_NATIVE_ROUTE_PLACEHOLDER)) {
		const probe = value.split(COMPANY_COMPUTER_NATIVE_ROUTE_PLACEHOLDER);
		if (probe.length !== 2 || !probe[1].startsWith("/native") || !probe[0].endsWith("/office/"))
			throw new Error("INVALID_OFFICE_NATIVE_URL");
		parseCompanyComputerNativeUrl(probe.join(PLACEHOLDER_PROBE));
		return {
			url: value,
			companyComputerId: null,
			urlFor: (companyComputerId) => parseCompanyComputerNativeUrl(probe.join(companyComputerId)).url,
		};
	}
	const exact = parseCompanyComputerNativeUrl(value);
	return {
		...exact,
		urlFor: (companyComputerId) => {
			if (companyComputerId !== exact.companyComputerId) throw new Error("OFFICE_NATIVE_CONFIGURATION_DIFFERS");
			return exact.url;
		},
	};
}
