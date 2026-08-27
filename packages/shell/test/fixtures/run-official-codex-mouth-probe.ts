import { runOfficialCodexMouthProbe } from "./official-codex-mouth-probe.ts";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: run-official-codex-mouth-probe <codex command> [arguments]");
console.log(JSON.stringify(await runOfficialCodexMouthProbe([command, ...args])));
