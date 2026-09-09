import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {build} from "esbuild";
const repository=resolve(import.meta.dirname,".."),image=process.env.QORPERA_OFFICE_TEST_IMAGE;
if(process.argv.length!==2||!image||!/^(?:[^\s]+@)?sha256:[0-9a-f]{64}$/.test(image))throw new Error("Select a prepared digest-pinned local QORPERA_OFFICE_TEST_IMAGE");
const temp=await mkdtemp(join(tmpdir(),"qorpera-service-restart-control-"));
try {
	const cert=join(temp,"cert"),key=join(temp,"key");assert.equal(spawnSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost"],{encoding:"utf8",timeout:15000}).status,0);
	for(const [name,entry] of [["probe","company-computer-service-start-control-probe"],["restart-probe","company-computer-service-restart-control-probe"]])await build({absWorkingDir:repository,entryPoints:[`packages/runtime/test/fixtures/${entry}.ts`],outfile:join(temp,name+".mjs"),bundle:true,platform:"node",format:"esm",target:"node22.19",logLevel:"silent"});
	const args=["run","--rm","--pull","never","--platform","linux/amd64","--network","none","--read-only","--memory","256m","--memory-swap","256m","--cpus","1","--pids-limit","64","--security-opt","no-new-privileges","--cap-drop","ALL","--cap-add","CHOWN","--cap-add","DAC_OVERRIDE","--user","0:0","--tmpfs","/etc/qorpera-office:rw,nosuid,nodev,size=20m,mode=0755","--tmpfs","/run/qorpera-office-preparation:rw,nosuid,nodev,size=48m,mode=0700"];
	for(const [source,target] of [[join(temp,"probe.mjs"),"/probe.mjs"],[join(temp,"restart-probe.mjs"),"/restart-probe.mjs"],[cert,"/fixture-cert"],[key,"/fixture-key"]])args.push("--mount",`type=bind,src=${source},dst=${target},readonly`);
	const result=spawnSync("docker",[...args,image,"node","/restart-probe.mjs","--parent"],{stdio:"inherit",timeout:240000});assert.equal(result.status,0,"Protected service restart proof failed");
} finally {await rm(temp,{recursive:true,force:true});}
