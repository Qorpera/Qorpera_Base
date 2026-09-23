#!/usr/bin/env node
// Removes what earlier runtime updates left behind on a node: LXD images nothing
// live can use, and image transfer files. A dry run unless --apply. Run it under
// `flock --nonblock /run/lock/qorpera-node-update.lock`; update lanes take the same
// lock around image transfer, import and cleanup, so a held lock means "not now".

import { execFile } from "node:child_process";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { request } from "node:http";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const CONFIG_SCHEMA = "qorpera.node-tidy/v1";
const FINGERPRINT = /\b[0-9a-f]{64}\b/g;
const FILE_PATH = /\/(?:etc|opt|var\/lib|usr\/local)\/[A-Za-z0-9_.@/+-]+/g;
const MAX_TRACED_FILE_BYTES = 2_000_000;
const HOUR_MS = 60 * 60_000;

/** Decides which LXD images stay. Pure: every input is an observation of the node.
 * - images: [{ fingerprint, project, size, uploadedAt, description }]
 * - instances: [{ project, name, status, baseImage }]
 * - referenced: fingerprints named by files the live units read
 * - pins: [{ version, fingerprint, live }] from the provider env files; `live` when a live unit reads the file
 * Keeps images of any instance, configured ones, the live runtime pin, every newer (staged) pin and the newest
 * older pin with another fingerprint (the rollback), images named by live configuration, base images and
 * recent uploads. Refuses to delete anything when the live pin cannot be found or names no local image. */
export function planImages({ images, instances, referenced, pins, now, config }) {
	const reasons = new Map();
	const keep = (fingerprint, reason) => {
		if (fingerprint && !reasons.has(fingerprint)) reasons.set(fingerprint, reason);
	};
	for (const instance of instances) keep(instance.baseImage, `instance ${instance.project}/${instance.name}`);
	for (const fingerprint of config.keepFingerprints) keep(fingerprint, "configured");
	const live = pins.filter((pin) => pin.live).sort((a, b) => b.version - a.version)[0];
	if (live) {
		keep(live.fingerprint, "live runtime pin");
		for (const pin of pins) if (pin.version > live.version) keep(pin.fingerprint, "staged runtime pin");
		const previous = pins
			.filter((pin) => pin.version < live.version && pin.fingerprint !== live.fingerprint)
			.sort((a, b) => b.version - a.version)[0];
		if (previous) keep(previous.fingerprint, "previous runtime pin");
	}
	for (const image of images) {
		if (referenced.has(image.fingerprint)) keep(image.fingerprint, "live configuration");
		if (/^ubuntu/i.test(image.description)) keep(image.fingerprint, "base image");
		const uploaded = Date.parse(image.uploadedAt);
		if (!Number.isFinite(uploaded) || now - uploaded < config.recentHours * HOUR_MS) keep(image.fingerprint, "recent upload");
	}
	const kept = images.filter((image) => reasons.has(image.fingerprint));
	const remove = images.filter((image) => !reasons.has(image.fingerprint));
	let refusal = null;
	if (!live) refusal = "no live runtime pin was found";
	else if (!images.some((image) => image.fingerprint === live.fingerprint)) refusal = "the live runtime pin names no local image";
	else if (remove.length > config.maxDelete) refusal = `would delete ${remove.length} images, more than ${config.maxDelete}`;
	return {
		keep: kept.map((image) => ({ ...image, reason: reasons.get(image.fingerprint) })),
		remove: refusal ? [] : remove,
		refusal,
	};
}

/** Image transfer files older than the configured age. */
export function planStaging(files, now, maxAgeHours) {
	return files.filter((file) => now - file.mtimeMs >= maxAgeHours * HOUR_MS);
}

function parseConfig(value) {
	const keys = [
		"schema",
		"lxdSocket",
		"unitPattern",
		"extraRoots",
		"pinFiles",
		"keepFingerprints",
		"recentHours",
		"maxDelete",
		"staging",
		"stagingMaxAgeHours",
	];
	if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== [...keys].sort().join())
		throw new Error("Node tidy configuration has unexpected fields");
	const strings = (list) => Array.isArray(list) && list.every((item) => typeof item === "string" && item.startsWith("/"));
	if (
		value.schema !== CONFIG_SCHEMA ||
		typeof value.lxdSocket !== "string" ||
		!value.lxdSocket.startsWith("/") ||
		!/^[a-z0-9*.-]+$/.test(value.unitPattern) ||
		!strings(value.extraRoots) ||
		typeof value.pinFiles !== "string" ||
		!value.pinFiles.startsWith("/") ||
		!Array.isArray(value.keepFingerprints) ||
		!value.keepFingerprints.every((item) => /^[0-9a-f]{64}$/.test(item)) ||
		!Number.isInteger(value.recentHours) ||
		value.recentHours < 1 ||
		!Number.isInteger(value.maxDelete) ||
		value.maxDelete < 0 ||
		!strings(value.staging) ||
		!Number.isInteger(value.stagingMaxAgeHours) ||
		value.stagingMaxAgeHours < 1
	)
		throw new Error("Node tidy configuration is invalid");
	return value;
}

/** Expands a path whose last segment may contain `*`. */
async function expand(pattern) {
	if (!basename(pattern).includes("*")) return (await present(pattern)) ? [pattern] : [];
	const matcher = new RegExp(`^${basename(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
	const names = await readdir(dirname(pattern)).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	return names.filter((name) => matcher.test(name)).map((name) => join(dirname(pattern), name));
}

async function present(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/** Reads the files a set of starting paths name, following paths named inside them (three levels). */
async function trace(starts) {
	const seen = new Map();
	let frontier = starts;
	for (let depth = 0; depth < 4 && frontier.length; depth++) {
		const next = [];
		for (const path of frontier) {
			if (seen.has(path)) continue;
			const info = await lstat(path).catch(() => undefined);
			if (!info?.isFile() || info.size > MAX_TRACED_FILE_BYTES) continue;
			const text = await readFile(path, "utf8").catch(() => "");
			seen.set(path, text);
			next.push(...(text.match(FILE_PATH) ?? []));
		}
		frontier = next;
	}
	return seen;
}

function lxdRequest(socketPath, method, path) {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, method, path, headers: { host: "lxd" }, timeout: 180_000 }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					if (body.type === "error") reject(new Error(`LXD ${method} ${path}: ${body.error}`));
					else resolve(body);
				} catch (error) {
					reject(error);
				}
			});
		});
		req.on("timeout", () => req.destroy(new Error(`LXD ${method} ${path} timed out`)));
		req.on("error", reject);
		req.end();
	});
}

export function nodeLxd(socketPath) {
	return {
		async images() {
			const body = await lxdRequest(socketPath, "GET", "/1.0/images?recursion=1&all-projects=true");
			return body.metadata.map((image) => ({
				fingerprint: image.fingerprint,
				project: image.project || "default",
				size: image.size,
				uploadedAt: image.uploaded_at,
				description: image.properties?.description ?? "",
			}));
		},
		async instances() {
			const body = await lxdRequest(socketPath, "GET", "/1.0/instances?recursion=1&all-projects=true");
			return body.metadata.map((instance) => ({
				project: instance.project || "default",
				name: instance.name,
				status: instance.status,
				baseImage: instance.config?.["volatile.base_image"] ?? null,
			}));
		},
		async deleteImage(fingerprint, project) {
			const body = await lxdRequest(
				socketPath,
				"DELETE",
				`/1.0/images/${fingerprint}?project=${encodeURIComponent(project)}`,
			);
			if (body.type !== "async") return;
			const done = await lxdRequest(socketPath, "GET", `${body.operation}/wait?timeout=170`);
			if (done.metadata?.status !== "Success") throw new Error(`LXD image deletion ${fingerprint} did not succeed`);
		},
	};
}

const run = promisify(execFile);
export const nodeSystemd = {
	async units(pattern) {
		const { stdout } = await run("/usr/bin/systemctl", ["list-units", "--all", "--plain", "--no-legend", pattern]);
		return stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter(([name, , active]) => name && (active === "active" || active === "activating"))
			.map(([name]) => name);
	},
	/** The files a live unit really starts from: its effective start commands, environment files and the
	 * running process's command line. Overridden drop-ins are not followed, so their old pins are not live. */
	async startPaths(unit) {
		const { stdout } = await run("/usr/bin/systemctl", [
			"show",
			unit,
			"-p",
			"ExecStart",
			"-p",
			"ExecStartPre",
			"-p",
			"EnvironmentFiles",
			"-p",
			"MainPID",
		]);
		const paths = stdout.match(FILE_PATH) ?? [];
		const pid = /^MainPID=(\d+)$/m.exec(stdout)?.[1];
		if (pid && pid !== "0") {
			const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
			paths.push(...(command.replaceAll("\0", " ").match(FILE_PATH) ?? []));
		}
		return paths;
	},
};

export async function tidy({ config, apply, lxd, systemd, now = Date.now(), removeFile = unlink }) {
	const units = await systemd.units(config.unitPattern);
	const starts = [];
	for (const unit of units) starts.push(...(await systemd.startPaths(unit)));
	for (const root of config.extraRoots) starts.push(...(await expand(root)));
	// Launchers name their env file relative to a base folder, so a pin file is live when a live file names it.
	const pinFiles = await expand(config.pinFiles);
	const direct = [...(await trace(starts)).values()];
	const livePins = new Set(pinFiles.filter((path) => direct.some((text) => text.includes(basename(path)))));
	const traced = await trace([...starts, ...livePins]);
	const referenced = new Set();
	for (const text of traced.values()) for (const match of text.match(FINGERPRINT) ?? []) referenced.add(match);
	const pins = [];
	for (const path of pinFiles) {
		const version = /-v(\d+)\.json$/.exec(path)?.[1];
		if (!version) continue;
		const fingerprint = JSON.parse(await readFile(path, "utf8"))?.env?.QORPERA_LXD_IMAGE_FINGERPRINT;
		if (typeof fingerprint === "string" && /^[0-9a-f]{64}$/.test(fingerprint))
			pins.push({ version: Number(version), fingerprint, live: livePins.has(path) });
	}
	const images = await lxd.images();
	const plan = planImages({ images, instances: await lxd.instances(), referenced, pins, now, config });
	const stagingFiles = [];
	for (const pattern of config.staging)
		for (const path of await expand(pattern)) {
			const info = await lstat(path);
			if (info.isFile()) stagingFiles.push({ path, size: info.size, mtimeMs: info.mtimeMs });
		}
	// A refusal means the node looks unlike what the rules expect: delete nothing at all.
	const staging = plan.refusal ? [] : planStaging(stagingFiles, now, config.stagingMaxAgeHours);
	const report = {
		mode: apply ? "apply" : "dry-run",
		unitsTraced: units.length,
		filesTraced: traced.size,
		keep: plan.keep.map(({ fingerprint, project, size, reason, description }) => ({
			fingerprint,
			project,
			size,
			reason,
			description,
		})),
		remove: plan.remove.map(({ fingerprint, project, size, description }) => ({ fingerprint, project, size, description })),
		staging: staging.map(({ path, size }) => ({ path, size })),
		refusal: plan.refusal,
		deleted: [],
		errors: [],
	};
	if (!apply) return report;
	for (const image of plan.remove) {
		try {
			await lxd.deleteImage(image.fingerprint, image.project);
			report.deleted.push(image.fingerprint);
		} catch (error) {
			report.errors.push(`${image.fingerprint}: ${error.message}`);
		}
	}
	for (const file of staging) {
		try {
			await removeFile(file.path);
			report.deleted.push(file.path);
		} catch (error) {
			report.errors.push(`${file.path}: ${error.message}`);
		}
	}
	return report;
}

async function main(argv) {
	const configIndex = argv.indexOf("--config");
	const configPath = configIndex >= 0 ? argv[configIndex + 1] : "/etc/qorpera-node-tidy.json";
	const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
	const report = await tidy({
		config,
		apply: argv.includes("--apply"),
		lxd: nodeLxd(config.lxdSocket),
		systemd: nodeSystemd,
	});
	process.stdout.write(`${JSON.stringify(report)}\n`);
	return report.errors.length ? 1 : report.refusal ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			process.stderr.write(`qorpera-node-tidy: ${error.message}\n`);
			process.exit(1);
		},
	);
}
