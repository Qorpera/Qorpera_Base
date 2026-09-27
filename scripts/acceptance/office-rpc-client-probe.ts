import { HttpCloudCompanyComputerRegistry } from "../../packages/runtime/src/cloud-company-computer-registry-http.ts";

// Fixed test operation; credentials arrive over stdin, never command arguments.
let input = "";
for await (const bytes of process.stdin) {
	input += bytes.toString();
	if (Buffer.byteLength(input) > 16384) throw new Error("OFFICE_RPC_PROBE_INPUT_LIMIT");
}
const options = JSON.parse(input) as { supabaseUrl: string; serviceRoleKey: string };
const registry = new HttpCloudCompanyComputerRegistry(options);
const result = await registry.call("qorpera_check_runtime_office_startup", { p_startup: {} }, AbortSignal.timeout(5000));
process.stdout.write(`${JSON.stringify(result)}\n`);
