import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_COMPRESSIONS } from "./manifest.mjs";

const NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PHASE_SAFE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROPERTY_KEY = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;

export function lxcPublishArgs({ builderName, project, compression = "zstd", properties = {} }) {
	if (typeof builderName !== "string" || !NAME_SAFE.test(builderName)) {
		throw new Error(`Invalid builderName: ${builderName}`);
	}
	if (typeof project !== "string" || !NAME_SAFE.test(project)) {
		throw new Error(`Invalid project: ${project}`);
	}
	if (!IMAGE_COMPRESSIONS.includes(compression)) {
		throw new Error(`Invalid compression '${compression}' (expected ${IMAGE_COMPRESSIONS.join(", ")})`);
	}
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new Error("Invalid properties: must be an object");
	}
	const args = ["publish", builderName, "--project", project, "--compression", compression];
	for (const [key, value] of Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))) {
		if (!PROPERTY_KEY.test(key)) throw new Error(`Invalid image property key: ${key}`);
		if (value === undefined || value === null || /[\0\r\n]/.test(String(value))) {
			throw new Error(`Invalid image property value for ${key}`);
		}
		args.push(`${key}=${value}`);
	}
	return args;
}

export function exportExtensionForCompression(compression) {
	if (compression === "zstd") return ".tar.zst";
	if (compression === "gzip") return ".tar.gz";
	if (compression === "none") return ".tar";
	throw new Error(`Unsupported compression: ${compression}`);
}

export function lxcExportArgs({ fingerprint, project, targetBasePath }) {
	if (typeof fingerprint !== "string" || !HEX_64.test(fingerprint)) {
		throw new Error(`Invalid fingerprint: ${fingerprint}`);
	}
	if (typeof project !== "string" || !NAME_SAFE.test(project)) {
		throw new Error(`Invalid project: ${project}`);
	}
	if (
		typeof targetBasePath !== "string" ||
		targetBasePath.length === 0 ||
		targetBasePath.startsWith("-") ||
		/[\0\r\n]/.test(targetBasePath)
	) {
		throw new Error("Invalid targetBasePath");
	}
	return ["image", "export", fingerprint, targetBasePath, "--project", project];
}

export function readOrCreateReceipt(receiptDir, phase, record) {
	if (typeof receiptDir !== "string" || receiptDir.length === 0) {
		throw new Error("Invalid receiptDir");
	}
	if (typeof phase !== "string" || !PHASE_SAFE.test(phase)) {
		throw new Error(`Invalid receipt phase: ${phase}`);
	}
	mkdirSync(receiptDir, { recursive: true });
	const file = join(receiptDir, `${phase}.json`);
	if (existsSync(file)) {
		return { reused: true, receipt: JSON.parse(readFileSync(file, "utf8")) };
	}
	const temporary = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
	writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	try {
		linkSync(temporary, file);
		return { reused: false, receipt: record };
	} catch (error) {
		if (error?.code === "EEXIST") {
			return { reused: true, receipt: JSON.parse(readFileSync(file, "utf8")) };
		}
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}
