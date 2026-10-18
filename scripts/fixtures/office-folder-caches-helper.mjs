// The office's folder helper as master builds it (packages/runtime), for the cache proof's guest: test-office-folder-
// caches.mjs bundles this file with esbuild, as the company computer package bundles the runtime. Each run is a new
// helper process, as a helper restart is: it makes or checks its folders, answers one request and prints the answer.
// Only the mount unit's name is the proof's: an image's own unit in /etc would shadow one of the office's name in /run.
// Nothing here publishes, launches a command or relays: the proof takes mounts away with `drop`.
//
// node helper.mjs line '<request>'     the request line as the helper's socket takes it (an unparsed one is `invalid`)
// node helper.mjs direct '<request>'   the request object handed to the helper itself, past the line's parser
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CompanyComputerFolderHelper,
	createLinuxCompanyComputerFolderHelperSystem,
} from "../../packages/runtime/src/cloud-company-computer-folder-helper.ts";
import { parseCompanyComputerFolderRequest } from "../../packages/runtime/src/cloud-company-computer-folder-helper-client.ts";

export const PROOF_UNIT = "qorpera-caches-folder-mount";
const OFFICE_UNIT = /^qorpera-office-folder-mount@((?:desktop|command)-[0-9a-f-]{36})\.service$/;

/** The machine as the helper uses it, with each mount unit under the proof's name. */
export function proofSystem(system) {
	const unit = (name) => {
		const match = OFFICE_UNIT.exec(name);
		if (!match) throw new Error(`Not a folder mount unit: ${name}`);
		return `${PROOF_UNIT}@${match[1]}.service`;
	};
	const never = (what) => () => {
		throw new Error(`The cache proof never ${what}`);
	};
	return {
		...system,
		inspect: (name) => system.inspect(unit(name)),
		start: (name) => system.start(unit(name)),
		stop: (name) => system.stop(unit(name)),
		resetFailed: (name) => system.resetFailed(unit(name)),
		publish: never("publishes"),
		launch: never("launches a command"),
		relay: never("relays"),
	};
}

async function main([mode, text]) {
	const lines = [];
	const helper = new CompanyComputerFolderHelper(proofSystem(createLinuxCompanyComputerFolderHelperSystem()), {
		log: (line) => lines.push(line),
	});
	await helper.prepare();
	let request;
	if (mode === "line") request = parseCompanyComputerFolderRequest(text);
	else if (mode === "direct") request = JSON.parse(text);
	else throw new Error(`Unknown mode ${mode}`);
	// The helper's socket answers a line it cannot parse with `invalid`, before anything.
	const answer = request === undefined ? { answer: "invalid" } : await helper.answer(request);
	console.log(JSON.stringify({ answer, parsed: request !== undefined, log: lines }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
