import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import test from "node:test";

test("packages a headless node observer and fixed namespace helper with immutable manifest",async()=>{
	const root=await mkdtemp(join(tmpdir(),"node-observer-package-")),out=join(root,"package");
	try {
		const packaged=spawnSync(process.execPath,["scripts/package-runtime-node-observer.mjs","--out",out],{cwd:resolve(import.meta.dirname,".."),encoding:"utf8",timeout:30000});assert.equal(packaged.status,0,packaged.stderr);
		const manifest=JSON.parse(await readFile(join(out,"manifest.json"),"utf8"));assert.equal(manifest.schema,"qorpera.runtime-node-observer-package/v1");assert.equal(manifest.artifacts.length,5);
		for(const a of manifest.artifacts){const bytes=await readFile(join(out,a.file));assert.equal(bytes.length,a.bytes);assert.equal(createHash("sha256").update(bytes).digest("hex"),a.sha256);}
		const bytes=await readFile(join(out,"qorpera-node-observer.cjs"));for(const path of ["packages/runtime/","packages/shell/","packages/member-web/","packages/cloud-client/"])assert(!bytes.includes(path));
		const options={cwd:tmpdir(),encoding:"utf8",timeout:10000};
		const help=spawnSync(process.execPath,["--jitless","--disable-proto=throw","--disallow-code-generation-from-strings",join(out,"qorpera-node-observer.cjs"),"--help"],options);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/separate protected node-observer.key/);
		const invalid=spawnSync(process.execPath,[join(out,"qorpera-node-observer.cjs"),"--config","/arbitrary"],options);assert.equal(invalid.status,2);assert.equal(invalid.stderr,"NODE_OBSERVER_ARGUMENTS_INVALID\n");
		const repeated=spawnSync(process.execPath,["scripts/package-runtime-node-observer.mjs","--out",out],{...options,cwd:resolve(import.meta.dirname,"..")});assert.notEqual(repeated.status,0);assert.deepEqual(JSON.parse(await readFile(join(out,"manifest.json"),"utf8")),manifest);
	} finally {await rm(root,{recursive:true,force:true});}
});
