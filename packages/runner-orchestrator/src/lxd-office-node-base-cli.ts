#!/usr/bin/env node
import { isDeepStrictEqual } from "node:util";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import {
	type LxdOfficeNodeBase,
	lxdOfficeNodeBasePorts,
	lxdOfficeNodeBaseSha256,
	measureLxdOfficeNodeBase,
	parseLxdOfficeNodeBaseConfig,
} from "./lxd-office-node-base.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";

// qorpera-office-node-base measure CONFIG          print this node's base (read-only)
// qorpera-office-node-base check CONFIG BASE       re-measure and compare with a stored base (read-only)
// Exit 0: done / same. 1: the node differs from BASE. 2: usage or an error (one short line, no values).

async function readJson(path: string): Promise<unknown> {
	const bytes = await readLxdOfficeProtectedFile(path, 65536);
	try {
		return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("OFFICE_NODE_BASE_INVALID_JSON");
	}
}

async function main(argv: string[]): Promise<number> {
	const [mode, configPath, basePath, ...extra] = argv;
	if (
		!((mode === "measure" && configPath && !basePath) || (mode === "check" && configPath && basePath)) ||
		extra.length
	) {
		process.stderr.write("Usage: qorpera-office-node-base measure CONFIG | check CONFIG BASE\n");
		return 2;
	}
	const config = parseLxdOfficeNodeBaseConfig(await readJson(configPath));
	const signal = AbortSignal.timeout(15000);
	const base = await measureLxdOfficeNodeBase(config, lxdOfficeNodeBasePorts(config.socketPath), signal);
	if (mode === "measure") {
		process.stdout.write(`${JSON.stringify({ base, sha256: lxdOfficeNodeBaseSha256(base) }, null, 2)}\n`);
		return 0;
	}
	// A stored base is exactly what `measure` printed: {base, sha256}, with the digest of that base.
	let stored: LxdOfficeNodeBase;
	try {
		const file = officeRecord(await readJson(basePath), ["base", "sha256"]);
		stored = file.base as LxdOfficeNodeBase;
		if (file.sha256 !== lxdOfficeNodeBaseSha256(stored)) throw new Error();
	} catch {
		throw new Error("OFFICE_NODE_BASE_STORED_INVALID");
	}
	const same = isDeepStrictEqual(stored, base);
	process.stdout.write(
		same
			? `Same node base (${lxdOfficeNodeBaseSha256(base)}).\n`
			: `The node differs from the stored base: now ${lxdOfficeNodeBaseSha256(base)}.\n`,
	);
	return same ? 0 : 1;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		const message =
			error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)
				? error.message
				: "OFFICE_NODE_BASE_UNCONFIRMED";
		process.stderr.write(`${message}\n`);
		process.exitCode = 2;
	},
);
