import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_COMPRESSIONS } from "./manifest.mjs";

const NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function lxcPublishArgs({ builderName, project, compression = "zstd", properties = {} }) {
	if (!NAME_SAFE.test(builderName)) throw new Error(`Invalid builderName: ${builderName}`);
	if (!NAME_SAFE.test(project)) throw new Error(`Invalid project: ${project}`);
	if (!IMAGE_COMPRESSIONS.includes(compression)) {
		throw new Error(`Invalid compression '${compression}' (expected ${IMAGE_COMPRESSIONS.join(", ")})`);
	}
	const args = ["publish", builderName, "--project", project, "--compression", compression];
	for (const [key, value] of Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))) {
		if (!/^[a-z0-9_.-]+$/i.test(key)) throw new Error(`Invalid image property key: ${key}`);
		if (/[\0\r\n]/.test(String(value))) throw new Error(`Invalid image property value for ${key}`);
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
	if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error(`Invalid fingerprint: ${fingerprint}`);
	if (!NAME_SAFE.test(project)) throw new Error(`Invalid project: ${project}`);
	if (!targetBasePath || /[\0\r\n]/.test(targetBasePath)) throw new Error("Invalid targetBasePath");
	return ["image", "export", fingerprint, targetBasePath, "--project", project];
}

export function readOrCreateReceipt(receiptDir, phase, record) {
	mkdirSync(receiptDir, { recursive: true });
	const file = join(receiptDir, `${phase}.json`);
	if (existsSync(file)) {
		return { reused: true, receipt: JSON.parse(readFileSync(file, "utf8")) };
	}
	writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	return { reused: false, receipt: record };
}
