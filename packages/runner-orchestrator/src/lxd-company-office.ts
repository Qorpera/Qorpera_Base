import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseCompanyComputerNativeUrl } from "@qorpera/contracts";

export interface LxdNativeCompanyOffice {
	companyId: string;
	environmentId: string;
	url: string;
	token: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateLxdNativeCompanyOffices(offices: LxdNativeCompanyOffice[], otherTokens: readonly string[]) {
	if (!Array.isArray(offices) || offices.length < 1 || offices.length > 128)
		throw new Error("INVALID_NATIVE_OFFICE_ROUTES");
	const scopes = new Set<string>(),
		tokens = new Set(otherTokens),
		targets = new Set<string>();
	for (const office of offices) {
		if (
			!office ||
			Object.keys(office).sort().join() !== "companyId,environmentId,token,url" ||
			typeof office.companyId !== "string" ||
			!UUID.test(office.companyId) ||
			typeof office.environmentId !== "string" ||
			!UUID.test(office.environmentId) ||
			typeof office.url !== "string" ||
			typeof office.token !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(office.token)
		)
			throw new Error("INVALID_NATIVE_OFFICE_ROUTE");
		const { companyComputerId } = parseCompanyComputerNativeUrl(office.url);
		const scope = `${office.companyId}:${office.environmentId}`;
		if (scopes.has(scope) || targets.has(companyComputerId) || tokens.has(office.token))
			throw new Error("DUPLICATE_NATIVE_OFFICE_AUTHORITY");
		scopes.add(scope);
		targets.add(companyComputerId);
		tokens.add(office.token);
	}
}

/** Read a protected routing map; credentials are separate private files and
 * only the exact company/environment route is injected into a job guest. */
export function readLxdNativeCompanyOffices(path: string, readToken: (path: string, label: string) => string) {
	if (!isAbsolute(path) || realpathSync(path) !== resolve(path)) throw new Error("INVALID_NATIVE_OFFICE_ROUTE_PATH");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Buffer;
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.size < 1 ||
			stat.size > 65536 ||
			(stat.mode & 0o077) !== 0 ||
			(stat.uid !== 0 && stat.uid !== process.getuid?.())
		)
			throw new Error("UNPROTECTED_NATIVE_OFFICE_ROUTES");
		bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length !== stat.size) throw new Error("NATIVE_OFFICE_ROUTES_CHANGED");
		bytes = bytes.subarray(0, length);
	} finally {
		closeSync(fd);
	}
	const decoded: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
		throw new Error("INVALID_NATIVE_OFFICE_ROUTES");
	const value = decoded as Record<string, unknown>;
	if (
		Object.keys(value).sort().join() !== "offices,schema" ||
		value.schema !== "qorpera.lxd-native-office-routes/v1" ||
		!Array.isArray(value.offices) ||
		value.offices.length < 1 ||
		value.offices.length > 128
	)
		throw new Error("INVALID_NATIVE_OFFICE_ROUTES");
	return value.offices.map((entry: unknown): LxdNativeCompanyOffice => {
		if (
			!entry ||
			typeof entry !== "object" ||
			Object.keys(entry).sort().join() !== "companyId,environmentId,tokenPath,url"
		)
			throw new Error("INVALID_NATIVE_OFFICE_ROUTE");
		const route = entry as Record<string, unknown>;
		if (
			typeof route.companyId !== "string" ||
			!UUID.test(route.companyId) ||
			typeof route.environmentId !== "string" ||
			!UUID.test(route.environmentId) ||
			typeof route.url !== "string"
		)
			throw new Error("INVALID_NATIVE_OFFICE_ROUTE");
		parseCompanyComputerNativeUrl(route.url);
		if (typeof route.tokenPath !== "string") throw new Error("INVALID_NATIVE_OFFICE_TOKEN_PATH");
		return {
			companyId: route.companyId,
			environmentId: route.environmentId,
			url: route.url,
			token: readToken(route.tokenPath, "Native office-token"),
		};
	});
}
