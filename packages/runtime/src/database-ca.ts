import { createHash, X509Certificate } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const ONE_PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;

export interface DatabaseCaCredentials {
	ownCa?: Uint8Array;
	ownCaSha256?: string;
}

export interface DatabaseTls {
	ca: string;
	rejectUnauthorized: true;
}

export function databaseTls(credentials: DatabaseCaCredentials, label: string): DatabaseTls {
	const invalid = new Error(`${label} database CA is invalid`);
	const { ownCa, ownCaSha256 } = credentials;
	if (ownCa === undefined || ownCaSha256 === undefined || !SHA256.test(ownCaSha256)) throw invalid;
	if (createHash("sha256").update(ownCa).digest("hex") !== ownCaSha256) throw invalid;
	let text: string;
	try {
		text = new TextDecoder("utf8", { fatal: true }).decode(ownCa);
	} catch {
		throw invalid;
	}
	if (!ONE_PEM_CERTIFICATE.test(text) || !isCaCertificate(text)) throw invalid;
	return { ca: text, rejectUnauthorized: true };
}

function isCaCertificate(pem: string): boolean {
	try {
		return new X509Certificate(pem).ca === true;
	} catch {
		return false;
	}
}
