import { createHash } from "node:crypto";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=="--out"||!args[1])throw new Error("Usage: node scripts/package-runtime-node-observer.mjs --out <new-output-directory>");
const output=resolve(args[1]);await mkdir(output);const artifacts=[];
for(const [entry,file] of [["runtime-node-observer-main.ts","qorpera-node-observer.cjs"],["lxd-office-host-namespace-cli.ts","qorpera-node-host-namespace.cjs"],["runtime-node-observer-installation-cli.ts","qorpera-node-observer-install.cjs"]]){
	await build({entryPoints:[`packages/runner-orchestrator/src/${entry}`],outfile:resolve(output,file),bundle:true,platform:"node",format:"cjs",target:"node22.19",legalComments:"none",logLevel:"silent"});
	const bytes=await readFile(resolve(output,file));artifacts.push({file,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
}
for(const file of ["qorpera-node-observer.service.in","qorpera-node-host-namespace.service"]){const bytes=await readFile(resolve("deploy/first-node",file));await writeFile(resolve(output,file),bytes);artifacts.push({file,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});}
const manifest={schema:"qorpera.runtime-node-observer-package/v1",runtime:{node:">=22.19.0",platform:"linux"},artifacts};
await writeFile(resolve(output,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`);console.log(JSON.stringify({output,...manifest}));
