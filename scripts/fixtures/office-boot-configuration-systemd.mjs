import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, cp, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bootConfigurationFixture, bootFixtureEncode as encode, bootFixtureHash as hash } from "/fixture/data.mjs";
import { parseRecoveryDirectoryMount } from "/fixture/mount.mjs";

const command = (file,args) => { const r = spawnSync(file,args,{encoding:"utf8",timeout:120000}); assert.equal(r.status,0,r.stdout+" "+r.stderr); return r.stdout.trim(); };
const ctl = (...args) => command("/usr/bin/systemctl",args);
const property = (unit,key) => ctl("show",unit,"--property="+key,"--value");
const pkg = "/run/boot-proof-package";
await cp("/fixture/package",pkg,{recursive:true}); await chmod(pkg,0o755);
const manifest = await readFile(pkg+"/manifest.json");
for (const file of JSON.parse(manifest).artifacts) await chmod(pkg+"/"+file.file,0o444);
await chmod(pkg+"/manifest.json",0o444);
const installer = pkg+"/qorpera-office-image-install.cjs";
const dependencies = JSON.parse(command("/usr/bin/node",[installer,"--measure-dependencies"]));
const spec = { schema:"qorpera.office-image-installation/v1", packageRoot:pkg, packageManifestSha256:hash(manifest), uid:1100, gid:1100, architecture:process.arch, dependencies };
await writeFile("/run/boot-proof-spec.json",JSON.stringify(spec),{mode:0o444});
command("/usr/bin/node",[installer,"--apply","--spec","/run/boot-proof-spec.json"]);
const unit = "qorpera-company-computer.service", prep = "qorpera-company-computer-preparation.service";
const idle = () => { for(const name of [unit,prep]) { assert.equal(property(name,"ActiveState"),"inactive"); assert.equal(property(name,"InvocationID"),""); assert.equal(property(name,"MainPID"),"0"); } };
idle();
// Assemble the clean image first; attach retained state only afterwards.
command("mount",["--bind","/fixture/workbench","/var/lib/qorpera-office"]);
const bootId = (await readFile("/proc/sys/kernel/random/boot_id","utf8")).trim();
const fd = await open("/var/lib/qorpera-office","r"); let mount;
try { mount = parseRecoveryDirectoryMount(await readFile("/proc/self/mountinfo","utf8"),await readFile(`/proc/self/fdinfo/${fd.fd}`,"utf8")); } finally { await fd.close(); }
assert.equal(mount.mountPoint,"/var/lib/qorpera-office"); assert.notEqual(mount.filesystem,"tmpfs");
const cert = "/run/boot-proof-cert", key = "/run/boot-proof-key";
command("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost"]);
// Layout version 2 (the production office) adds the company root to the retained receipt.
const original = process.env.QORPERA_OFFICE_FIXTURE_LAYOUT_VERSION === "2" ? { layoutVersion:2, entries:[".","company","desktop","profiles","screens","workbench"].map(path=>({path,kind:"directory",mode:0o700,bytes:0,sha256:null})) } : {};
const f = bootConfigurationFixture({ bootId,mount,uid:1100,tlsCert:await readFile(cert,"utf8"),tlsKey:await readFile(key,"utf8"),original });
assert.equal("companyRoot" in f.receipt.layout, process.env.QORPERA_OFFICE_FIXTURE_LAYOUT_VERSION === "2");
for(const [path,file] of f.originFiles) await writeFile(path,file.bytes,{mode:file.mode});
await mkdir(f.historyDirectory,{recursive:true,mode:0o700});
for(const [path,bytes] of f.archiveFiles) await writeFile(path,bytes,{mode:0o600});
const adoptionRoot = dirname(f.receipt.layout.workbenchRoot);
for(const path of [adoptionRoot,...Object.values(f.receipt.layout)]) { await mkdir(path,{mode:0o700}); await chown(path,1100,1100); }
const note = f.receipt.layout.workbenchRoot+"/note";
await writeFile(note,"edited since the original copy",{mode:0o600}); await chown(note,1100,1100);
const snapshot = async paths => Promise.all(paths.map(async path => {const stat=await lstat(path);return {path,ino:stat.ino,mode:stat.mode,uid:stat.uid,gid:stat.gid,sha256:hash(await readFile(path))};}));
const preserved = [...f.originFiles.keys(),...f.archiveFiles.keys(),note], before = await snapshot(preserved);
await writeFile(`/run/qorpera-office-preparation/boot-configuration-incoming-${f.command.requestSha256}.json`,encode(f.input),{mode:0o400});
const argv = ["-i","/usr/bin/node","/opt/qorpera-office/qorpera-company-computer-boot-configuration-control.mjs",f.command.commandId,f.command.requestSha256,bootId];
command("/usr/bin/env",argv);
const directory = `/etc/qorpera-office/boots/${bootId.replaceAll("-","")}`;
assert.deepEqual(JSON.parse(await readFile(directory+"/configuration-completion.json","utf8")),f.completion);
assert.deepEqual(JSON.parse(await readFile(directory+"/adoption.json","utf8")),f.receipt);
const newFiles=[directory+"/adoption.json",directory+"/configuration-claim.json",directory+"/configuration-completion.json",...Object.keys(f.completion.files).map(name=>directory+"/credentials/"+name)];
const installed = await snapshot(newFiles);
command("/usr/bin/env",argv); assert.deepEqual(await snapshot(newFiles),installed); assert.deepEqual(await snapshot(preserved),before); idle();

// A separate real oneshot exercises the installed unit's six credential lines.
// It grants no ordinary office admission and emits only file hashes.
const credentials = (await readFile("/etc/systemd/system/"+unit,"utf8")).split("\n").filter(line=>line.startsWith("LoadCredential=")); assert.equal(credentials.length,6);
const reader = "/run/boot-proof-reader.mjs", output = "/run/boot-proof-reader.json";
await writeFile(reader,'import {readFile,readdir} from "node:fs/promises"; import {createHash} from "node:crypto"; const root=process.env.CREDENTIALS_DIRECTORY; const result={}; for(const name of await readdir(root)){const b=await readFile(root+"/"+name);result[name]={bytes:b.length,sha256:createHash("sha256").update(b).digest("hex")};} console.log(JSON.stringify(result));',{mode:0o444});
await writeFile("/etc/systemd/system/boot-proof-reader.service",["[Service]","Type=oneshot","User=qorpera-office","Group=qorpera-office","NoNewPrivileges=yes","CapabilityBoundingSet=",...credentials,"ExecStart=/usr/bin/node "+reader,"StandardOutput=file:"+output,""].join("\n"),{mode:0o644});
ctl("daemon-reload"); ctl("start","boot-proof-reader.service");
const expectedCredentials=Object.fromEntries(credentials.map(line=>{const [id,path]=line.slice("LoadCredential=".length).split(":");return [id,f.completion.files[path.slice(path.lastIndexOf("/")+1)]];}));
assert.deepEqual(JSON.parse(await readFile(output,"utf8")),expectedCredentials); idle();
assert.deepEqual(await snapshot(preserved),before); assert.deepEqual(await snapshot(newFiles),installed);
await unlink(directory+"/credentials/config.json");
const missing=spawnSync("/usr/bin/env",argv,{encoding:"utf8",timeout:120000}); assert.equal(missing.status,1,missing.stderr); assert.match(missing.stderr,/Office boot configuration/);
await assert.rejects(lstat(directory+"/credentials/config.json"),{code:"ENOENT"}); idle();
console.log(JSON.stringify({schema:"qorpera.office-boot-configuration-systemd-proof/v1",actualSystemd:true,actualPackagedRootHelper:true,actualKernelFlock:true,actualPersistentFilesystem:mount.filesystem,actualSelectedCredentials:6,originalRecordsPreserved:before.length,installedRecordsPreservedOnReplay:installed.length,missingAcknowledgedCredentialRefused:true,ordinaryServiceAndPreparationNeverStarted:true,syntheticPriorBootAndSqlAndVm:true,realKvm:false,realNas:false,deployed:false,packageManifestSha256:hash(manifest)}));
