import { runCloudMouthProbe } from "./cloud-mouth-probe.ts";

const evidence = await runCloudMouthProbe(process.argv[2]);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
