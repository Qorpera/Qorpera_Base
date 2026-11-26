import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
	CLOUD_CODING_COMMAND_PAGE_BYTES,
	type CloudCodingCommandReceipt,
	IDENTITY_TOKENS_CSS_PATH,
	isUuid,
	type JsonValue,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
	parseEconomicsDocument,
	parseStrategyHypothesesDocument,
	parseStrategyLandscapeDocument,
	parseStrategyPlaysDocument,
	parseSurfaceChartDocument,
	readSurfaceLayout,
	resolveSurfaceSource,
	SURFACE_LAYOUT_PATH,
	type SurfaceChartDocument,
	type SurfaceLayoutRead,
	type SurfaceReadBlock,
	type SurfaceReadNode,
	type SurfaceSource,
	type SurfaceStarterKind,
	type SurfaceTab,
	starterSurfaceLayout,
	surfaceCompanyPath,
	surfaceGlobMatches,
	surfaceLegacyModelKey,
} from "@qorpera/contracts";
import { decodeInspectImageOutput } from "./cloud-coding-image-inspect.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { FolderImageRefusal, type FolderImageView, folderImageView, oneImageAtATime } from "./cloud-folder-images.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import type { StudioChatGptVoiceMachine } from "./cloud-studio-voice-recorder.ts";

export const STUDIO_INSPECT_SURFACE_SCHEMA = "qorpera.studio-surface-inspect/v1";

export type InspectSurfaceTheme = "light" | "dark";
export type InspectSurfaceViewport = "desktop" | "mobile";

const WORK_ROOT = "/tmp/qorpera-studio-inspect";
const UPLOAD_CHUNK_BYTES = 14_000;
const MAX_UPLOAD_CHUNKS = 16;
const CAPTURE_TIMEOUT_MS = 45_000;
const SETUP_TIMEOUT_MS = 20_000;
const CANCEL_ON_ABORT_MS = 5_000;
const MAX_INLINE_IMAGE_BYTES = 24_000;
const MAX_TOTAL_INLINE_IMAGES_BYTES = 64_000;
const MAX_INLINE_SVG_BYTES = 24_000;
const MAX_TOTAL_INLINE_SVG_BYTES = 64_000;
const MAX_INLINE_MODULE_BYTES = 32_000;
const MAX_TOTAL_INLINE_MODULES_BYTES = 64_000;
const MAX_PREVIEW_HTML_BYTES = 256_000;
const MAX_CAPTURE_HEIGHT = 1800;
const MAX_SCROLL_Y = 6000;
const MAX_BASE64_OUTPUT_BYTES = Math.ceil((8 * 1024 * 1024) / 3) * 4 + 256;
const SCRIPT_END = "QORPERA_STUDIO_INSPECT_END";

const MAX_STAGED_BUNDLE_BYTES = 220_000;
const MAX_STAGED_PREVIEW_IMAGES = 6;
const MAX_STAGED_PREVIEW_IMAGE_BYTES = 40_000;
const MAX_STAGED_GLB_UPLOAD_BYTES = 140_000;

const CAPTURE_SCRIPT_CJS = [
	'const { spawn } = require("node:child_process");',
	'const crypto = require("node:crypto");',
	'const fs = require("node:fs");',
	'const http = require("node:http");',
	'const path = require("node:path");',
	'const zlib = require("node:zlib");',
	"const [work, widthRaw, heightRaw, mobileRaw, fullRaw, scrollYRaw, folderRootRaw] = process.argv.slice(2);",
	"const width = Number(widthRaw) || 1280;",
	"const height = Number(heightRaw) || 800;",
	'const mobile = mobileRaw === "1";',
	'const fullPage = fullRaw === "1";',
	"const scrollY = Math.max(0, Math.min(6000, Number(scrollYRaw) || 0));",
	"const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });",
	"const findChrome = () => {",
	"  if (process.env.QORPERA_INSPECT_CHROMIUM) return process.env.QORPERA_INSPECT_CHROMIUM;",
	'  for (const p of ["/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {',
	"    if (fs.existsSync(p)) return p;",
	"  }",
	'  return "chromium";',
	"};",
	"const MIME = {",
	'  ".html": "text/html; charset=utf-8",',
	'  ".htm": "text/html; charset=utf-8",',
	'  ".css": "text/css; charset=utf-8",',
	'  ".js": "application/javascript; charset=utf-8",',
	'  ".mjs": "application/javascript; charset=utf-8",',
	'  ".json": "application/json; charset=utf-8",',
	'  ".svg": "image/svg+xml",',
	'  ".png": "image/png",',
	'  ".jpg": "image/jpeg",',
	'  ".jpeg": "image/jpeg",',
	'  ".webp": "image/webp",',
	'  ".glb": "model/gltf-binary",',
	"};",
	'const ASSET_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "model/gltf-binary"]);',
	'const inside = (root, p) => { const r = path.relative(root, p); return Boolean(r && r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)); };',
	"(async () => {",
	'  if (!work || !path.isAbsolute(work)) throw new Error("work must be absolute");',
	'  const siteDir = path.join(work, "site");',
	'  const stagedDir = path.join(siteDir, "staged");',
	'  const gzPath = path.join(siteDir, "index.html.gz.b64");',
	'  const htmlPath = path.join(siteDir, "index.html");',
	"  if (fs.existsSync(gzPath)) {",
	'    const gz = Buffer.from(fs.readFileSync(gzPath, "utf8"), "base64");',
	"    fs.writeFileSync(htmlPath, zlib.gunzipSync(gz));",
	"    try { fs.unlinkSync(gzPath); } catch {}",
	"  }",
	'  const cwdReal = fs.realpathSync(".");',
	'  let tmpReal = "/tmp"; try { tmpReal = fs.realpathSync("/tmp"); } catch {}',
	"  const localAssets = new Map();",
	"  const staleLocalAssets = new Set();",
	'  const stagedGz = path.join(siteDir, "staged.json.gz.b64");',
	"  if (fs.existsSync(stagedGz)) {",
	'    const bundle = JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync(stagedGz, "utf8"), "base64")).toString("utf8"));',
	"    try { fs.unlinkSync(stagedGz); } catch {}",
	"    if (bundle && typeof bundle.files === 'object' && bundle.files) {",
	"      for (const [rel, entry] of Object.entries(bundle.files)) {",
	'        if (!rel || rel.startsWith("/") || rel.includes("\\\\") || rel.includes("\\0")) continue;',
	"        const target = path.resolve(stagedDir, rel);",
	"        if (!inside(stagedDir, target)) continue;",
	"        fs.mkdirSync(path.dirname(target), { recursive: true });",
	'        if (entry && typeof entry.b64 === "string") fs.writeFileSync(target, Buffer.from(entry.b64, "base64"));',
	'        else if (entry && typeof entry.text === "string") fs.writeFileSync(target, entry.text, "utf8");',
	"      }",
	"    }",
	"    if (bundle && typeof bundle.local === 'object' && bundle.local) {",
	"      for (const [rel, entry] of Object.entries(bundle.local)) {",
	'        const src = typeof entry === "string" ? entry : entry && typeof entry.src === "string" ? entry.src : null;',
	'        const sha256 = entry && typeof entry === "object" && typeof entry.sha256 === "string" ? entry.sha256 : null;',
	"        if (!src) continue;",
	"        try {",
	"          const real = fs.realpathSync(src);",
	"          const st = fs.statSync(real);",
	"          if ((inside(cwdReal, real) || inside(tmpReal, real)) && st.isFile() && st.size <= 8 * 1024 * 1024 && MIME[path.extname(real).toLowerCase()]) {",
	"            localAssets.set(rel, { real, sha256 });",
	"          }",
	"        } catch {}",
	"      }",
	"    }",
	"  }",
	"  let companyDir = null;",
	"  if (folderRootRaw) {",
	'    const candidate = path.resolve("/company", folderRootRaw);',
	'    try { const real = fs.realpathSync(candidate); const comp = fs.realpathSync("/company"); if (inside(comp, real)) companyDir = real; } catch {}',
	"  }",
	"  const sendFile = (res, filePath, allowedSet) => {",
	"    const mime = MIME[path.extname(filePath).toLowerCase()];",
	"    if (!mime || (allowedSet && !allowedSet.has(mime))) { res.writeHead(404); res.end(); return; }",
	'    res.writeHead(200, { "Content-Type": mime });',
	"    fs.createReadStream(filePath).pipe(res);",
	"  };",
	"  const sendLocal = (res, rel, hit) => {",
	"    try {",
	"      const st = fs.statSync(hit.real);",
	"      if (!st.isFile() || st.size > 8 * 1024 * 1024) return { ok: false, stale: false };",
	"      const mime = MIME[path.extname(hit.real).toLowerCase()];",
	"      if (!mime) return { ok: false, stale: false };",
	"      const data = fs.readFileSync(hit.real);",
	'      if (hit.sha256 && crypto.createHash("sha256").update(data).digest("hex") !== hit.sha256) {',
	"        return { ok: false, stale: true };",
	"      }",
	'      res.writeHead(200, { "Content-Type": mime });',
	"      res.end(data);",
	"      return { ok: true, stale: false };",
	"    } catch { return { ok: false, stale: false }; }",
	"  };",
	"  const server = http.createServer((req, res) => {",
	'    const reqPath = (req.url || "/").split("?")[0];',
	'    if (companyDir && reqPath.startsWith("/company-asset/")) {',
	'      let rel = ""; try { rel = decodeURIComponent(reqPath.slice("/company-asset/".length)); } catch { res.writeHead(400); res.end(); return; }',
	"      try { const resolved = fs.realpathSync(path.resolve(companyDir, rel)); if (!inside(companyDir, resolved) || !fs.statSync(resolved).isFile()) { res.writeHead(404); res.end(); return; } sendFile(res, resolved, ASSET_MIME); return; } catch { res.writeHead(404); res.end(); return; }",
	"    }",
	'    if (reqPath.startsWith("/staged/") || reqPath.startsWith("/staged-asset/")) {',
	'      const prefix = reqPath.startsWith("/staged-asset/") ? "/staged-asset/" : "/staged/";',
	'      let rel = ""; try { rel = decodeURIComponent(reqPath.slice(prefix.length)).replace(/^\\/+/, ""); } catch { res.writeHead(400); res.end(); return; }',
	'      if (!rel || rel.includes("\\\\") || rel.includes("\\0")) { res.writeHead(404); res.end(); return; }',
	"      const localHit = localAssets.get(rel);",
	"      const localResult = localHit ? sendLocal(res, rel, localHit) : { ok: false, stale: false };",
	"      if (localResult.ok) return;",
	"      const stagedTarget = path.resolve(stagedDir, rel);",
	"      if (inside(stagedDir, stagedTarget) && fs.existsSync(stagedTarget) && fs.statSync(stagedTarget).isFile()) { sendFile(res, stagedTarget, null); return; }",
	"      if (localResult.stale) staleLocalAssets.add(rel);",
	'      if (companyDir && prefix === "/staged/") { try { const compHit = fs.realpathSync(path.resolve(companyDir, rel)); if (inside(companyDir, compHit) && fs.statSync(compHit).isFile()) { sendFile(res, compHit, null); return; } } catch {} }',
	'      res.writeHead(404); res.end("not found"); return;',
	"    }",
	'    const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\\/+/, "");',
	"    const resolved = path.resolve(siteDir, rel);",
	"    if (!inside(siteDir, resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {",
	'      res.writeHead(404); res.end("not found"); return;',
	"    }",
	"    sendFile(res, resolved, null);",
	"  });",
	'  await new Promise((res) => server.listen(0, "127.0.0.1", res));',
	"  const port = server.address().port;",
	'  const userData = path.join(work, "chrome");',
	'  const proc = spawn(findChrome(), ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--remote-debugging-port=0", "--user-data-dir=" + userData, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });',
	"  let ws = null;",
	"  try {",
	'    let wsUrl = null, errBuf = "", spawnErr = null;',
	'    proc.on("error", (err) => { spawnErr = err; });',
	'    proc.stderr.setEncoding("utf8");',
	'    proc.stderr.on("data", (c) => { errBuf = (errBuf + c).slice(-4096); const m = /DevTools listening on (ws:\\/\\/[^\\s]+)/.exec(errBuf); if (m) wsUrl = m[1]; });',
	"    const bootBy = Date.now() + 20000;",
	"    while (!wsUrl && !spawnErr && proc.exitCode === null && Date.now() < bootBy) await sleep(50);",
	"    if (spawnErr) throw spawnErr;",
	'    if (!wsUrl) throw new Error("chromium did not open devtools: " + errBuf.slice(-240));',
	'    const base = wsUrl.replace(/^ws:\\/\\//, "http://").replace(/\\/devtools\\/.*/, "");',
	"    let targetWs = null;",
	"    for (let i = 0; i < 40 && !targetWs; i++) {",
	'      const list = await fetch(base + "/json/list").then((r) => r.json()).catch(() => []);',
	'      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);',
	"      if (page) targetWs = page.webSocketDebuggerUrl; else await sleep(50);",
	"    }",
	'    if (!targetWs) throw new Error("no browser page target");',
	"    ws = new WebSocket(targetWs);",
	'    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("devtools socket failed")); });',
	"    let nextId = 0; const pending = new Map(); let loadResolve = null;",
	"    const loaded = new Promise((res) => { loadResolve = res; });",
	"    const rejectAll = (msg) => { for (const p of pending.values()) p.rej(new Error(msg)); pending.clear(); };",
	'    ws.onclose = () => rejectAll("devtools socket closed");',
	'    ws.onerror = () => rejectAll("devtools socket error");',
	"    ws.onmessage = (ev) => {",
	"      const msg = JSON.parse(String(ev.data));",
	"      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result); }",
	'      if (msg.method === "Page.loadEventFired" && loadResolve) { loadResolve(); loadResolve = null; }',
	"    };",
	'    const send = (method, params = {}) => new Promise((res, rej) => { if (ws.readyState !== 1) return rej(new Error("devtools socket not open")); const id = ++nextId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });',
	'    await send("Page.enable");',
	'    await send("Runtime.enable");',
	'    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });',
	'    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/index.html" });',
	"    await Promise.race([loaded, sleep(12000)]);",
	'    const settleExpr = "(async()=>{if(document.fonts&&document.fonts.ready)await document.fonts.ready.catch(()=>{});const deadline=Date.now()+3000;while(Date.now()<deadline){const pendingStage=[...document.querySelectorAll(\\"[data-glb-url]\\")].some((el)=>!el.dataset.stageReady&&!el.dataset.stageError);if(!pendingStage)break;await new Promise((r)=>setTimeout(r,40));}await new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));const brokenImages=[];const scan=(doc)=>{try{for(const img of doc.querySelectorAll(\\"img\\")){if(!img.complete||img.naturalWidth===0){const label=img.getAttribute(\\"src\\")||img.getAttribute(\\"alt\\")||\\"image\\";if(brokenImages.length<8)brokenImages.push(label.slice(0,120));}}}catch{}};scan(document);for(const f of document.querySelectorAll(\\"iframe\\")){try{if(f.contentDocument)scan(f.contentDocument);}catch{}}const stage3dErrors=[...document.querySelectorAll(\\"[data-stage-error]\\")].map((el)=>el.dataset.stageError||\\"3D load failed\\").slice(0,4);const scrollHeight=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight||0));return {scrollHeight,brokenImages,stage3dErrors};})()";',
	'    const settle = await send("Runtime.evaluate", { expression: settleExpr, awaitPromise: true, returnByValue: true });',
	"    const rawVal = settle && settle.result ? settle.result.value : null;",
	"    const scrollHeight = Number(typeof rawVal === 'number' ? rawVal : rawVal && rawVal.scrollHeight) || height;",
	"    const brokenImages = rawVal && Array.isArray(rawVal.brokenImages) ? rawVal.brokenImages : [];",
	"    const stage3dErrors = rawVal && Array.isArray(rawVal.stage3dErrors) ? rawVal.stage3dErrors : [];",
	"    const y = fullPage ? 0 : Math.min(scrollY, Math.max(0, scrollHeight - height));",
	`    const captureHeight = fullPage ? Math.max(height, Math.min(${MAX_CAPTURE_HEIGHT}, scrollHeight)) : height;`,
	'    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y, width, height: captureHeight, scale: 1 } });',
	'    if (!shot || typeof shot.data !== "string" || !shot.data.length) throw new Error("empty screenshot");',
	'    const data = Buffer.from(shot.data, "base64");',
	'    const hash = crypto.createHash("sha256").update(data).digest("hex");',
	'    const writeAll = async (s) => { if (!process.stdout.write(s)) await new Promise((r) => process.stdout.once("drain", r)); };',
	'    await writeAll("QORPERA_META:" + JSON.stringify({ scrollHeight, scrollY: y, captureHeight, brokenImages, stage3dErrors, staleLocalAssets: [...staleLocalAssets] }) + "\\n");',
	'    await writeAll("QORPERA_IMG:" + data.length + ":" + hash + ":\\n");',
	'    for (let i = 0; i < data.length; i += 49152) await writeAll(data.subarray(i, Math.min(data.length, i + 49152)).toString("base64"));',
	"  } finally {",
	"    try { if (ws) ws.close(); } catch {}",
	'    try { proc.kill("SIGKILL"); } catch {}',
	"    try { server.close(); } catch {}",
	"    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}",
	"  }",
	"})().catch((e) => { process.stderr.write(String(e && e.message ? e.message : e) + '\\n'); try { fs.rmSync(work, { recursive: true, force: true }); } catch {} process.exit(1); });",
].join("\n");

const GLB_PREVIEW_SCRIPT = `<script>(()=>{
const hexRgb=(h)=>{const c=String(h||"").replace("#","").trim();const f=c.length===3?c[0]+c[0]+c[1]+c[1]+c[2]+c[2]:c.slice(0,6);const n=parseInt(f,16);return Number.isFinite(n)?[(n>>16)&255,(n>>8)&255,n&255]:null;};
const mul4=(a,b)=>{const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];return o;};
const trs=(n)=>{if(Array.isArray(n.matrix)&&n.matrix.length===16)return new Float32Array(n.matrix);const t=n.translation||[0,0,0],r=n.rotation||[0,0,0,1],s=n.scale||[1,1,1];const [x,y,z,w]=r;const x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;return new Float32Array([(1-(yy+zz))*s[0],(xy+wz)*s[0],(xz-wy)*s[0],0,(xy-wz)*s[1],(1-(xx+zz))*s[1],(yz+wx)*s[1],0,(xz+wy)*s[2],(yz-wx)*s[2],(1-(xx+yy))*s[2],0,t[0],t[1],t[2],1]);};
const xform=(m,x,y,z)=>[m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];
const renderStage=async(el)=>{
  const canvas=el.querySelector("canvas");if(!canvas)return;
  const ctx=canvas.getContext("2d");if(!ctx){el.dataset.stageReady="1";return;}
  try{
    const res=await fetch(el.dataset.glbUrl);if(!res.ok)throw new Error("HTTP "+res.status);
    const buf=await res.arrayBuffer();const dv=new DataView(buf);
    if(buf.byteLength<20||dv.getUint32(0,true)!==0x46546C67)throw new Error("invalid GLB header");
    let at=12,gltf=null,bin=null;
    while(at+8<=buf.byteLength){const len=dv.getUint32(at,true),type=dv.getUint32(at+4,true);const slice=new Uint8Array(buf,at+8,Math.min(len,buf.byteLength-at-8));if(type===0x4E4F534A)gltf=JSON.parse(new TextDecoder().decode(slice));else if(type===0x004E4942)bin=slice;at+=8+len;}
    if(!gltf||!bin)throw new Error("missing GLB JSON or BIN chunk");
    const acc=(idx)=>{const a=gltf.accessors[idx],bv=gltf.bufferViews[a.bufferView];const off=(bv.byteOffset||0)+(a.byteOffset||0),stride=bv.byteStride||0;return {a,off,stride};};
    const readVec3=(idx)=>{const {a,off,stride}=acc(idx);const step=stride||12;const out=new Float32Array(a.count*3);const v=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);for(let i=0;i<a.count;i++){const o=off+i*step;out[i*3]=v.getFloat32(o,true);out[i*3+1]=v.getFloat32(o+4,true);out[i*3+2]=v.getFloat32(o+8,true);}return out;};
    const readIdx=(idx)=>{const {a,off}=acc(idx);const v=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);const out=new Uint32Array(a.count);for(let i=0;i<a.count;i++){out[i]=a.componentType===5125?v.getUint32(off+i*4,true):a.componentType===5123?v.getUint16(off+i*2,true):v.getUint8(off+i);}return out;};
    let tintNames=[];try{tintNames=JSON.parse(el.dataset.tint||"[]");}catch{}
    const tintRgb=hexRgb(el.dataset.tintHex);
    const tris=[];const id=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    const walk=(ni,pm)=>{const n=gltf.nodes[ni];if(!n)return;const m=mul4(pm,trs(n));if(n.mesh!==undefined&&gltf.meshes&&gltf.meshes[n.mesh]){for(const p of gltf.meshes[n.mesh].primitives||[]){if(p.mode!==undefined&&p.mode!==4)continue;if(p.attributes?.POSITION===undefined)continue;const pos=readVec3(p.attributes.POSITION);const idx=p.indices!==undefined?readIdx(p.indices):null;const mat=p.material!==undefined&&gltf.materials?gltf.materials[p.material]:null;const bf=mat?.pbrMetallicRoughness?.baseColorFactor||[0.76,0.75,0.73,1];let rgb=[Math.round(bf[0]*255),Math.round(bf[1]*255),Math.round(bf[2]*255)];if(tintRgb&&mat&&tintNames.includes(mat.name))rgb=tintRgb;const cnt=idx?idx.length:pos.length/3;const step=Math.max(3,Math.floor(cnt/36000)*3);for(let i=0;i+2<cnt;i+=step){const ia=idx?idx[i]:i,ib=idx?idx[i+1]:i+1,ic=idx?idx[i+2]:i+2;tris.push([xform(m,pos[ia*3],pos[ia*3+1],pos[ia*3+2]),xform(m,pos[ib*3],pos[ib*3+1],pos[ib*3+2]),xform(m,pos[ic*3],pos[ic*3+1],pos[ic*3+2]),rgb]);}}}for(const ch of n.children||[])walk(ch,m);};
    const scene=(gltf.scenes&&gltf.scenes[gltf.scene||0])||null;for(const r of scene?.nodes||[])walk(r,id);
    if(!tris.length)throw new Error("GLB has no renderable triangles");
    let x0=1e9,y0=1e9,z0=1e9,x1=-1e9,y1=-1e9,z1=-1e9;for(const t of tris)for(let k=0;k<3;k++){const p=t[k];if(p[0]<x0)x0=p[0];if(p[0]>x1)x1=p[0];if(p[1]<y0)y0=p[1];if(p[1]>y1)y1=p[1];if(p[2]<z0)z0=p[2];if(p[2]>z1)z1=p[2];}
    const cx=(x0+x1)/2,cy=(y0+y1)/2,cz=(z0+z1)/2,span=Math.max(x1-x0,y1-y0,z1-z0,1e-5),sc=1.85/span;
    const yaw=(Number(el.dataset.yaw)||30)*Math.PI/180,pitch=(Number(el.dataset.pitch)||14)*Math.PI/180;
    const cyaw=Math.cos(yaw),syaw=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
    const rot=(p)=>{const x=(p[0]-cx)*sc,y=(p[1]-cy)*sc,z=(p[2]-cz)*sc;const rx=x*cyaw+z*syaw,rz=-x*syaw+z*cyaw;return [rx,y*cp-rz*sp,y*sp+rz*cp];};
    const W=canvas.width,H=canvas.height;ctx.clearRect(0,0,W,H);
    ctx.fillStyle="rgba(20,20,24,0.09)";ctx.beginPath();ctx.ellipse(W/2,H*0.8,145,22,0,0,Math.PI*2);ctx.fill();
    const L=[-0.42,0.78,0.46];
    const proj=tris.map((t)=>{const a=rot(t[0]),b=rot(t[1]),c=rot(t[2]);const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;const d=Math.abs(nx*L[0]+ny*L[1]+nz*L[2]);const sh=0.36+d*0.64,spec=Math.pow(d,10)*32;const f=(p)=>{const k=410/Math.max(1.2,5.0-p[2]);return [W/2+p[0]*k,H*0.48-p[1]*k];};return {z:(a[2]+b[2]+c[2])/3,p:[f(a),f(b),f(c)],c:\`rgb(\${Math.min(255,Math.round(t[3][0]*sh+spec))},\${Math.min(255,Math.round(t[3][1]*sh+spec))},\${Math.min(255,Math.round(t[3][2]*sh+spec))})\`};}).sort((a,b)=>a.z-b.z);
    for(const item of proj){ctx.beginPath();ctx.moveTo(item.p[0][0],item.p[0][1]);ctx.lineTo(item.p[1][0],item.p[1][1]);ctx.lineTo(item.p[2][0],item.p[2][1]);ctx.closePath();ctx.fillStyle=item.c;ctx.fill();}
    el.dataset.stageReady="1";
  }catch(e){el.dataset.stageError=String(e&&e.message?e.message:e);}
};
for(const el of document.querySelectorAll(".pv-stage-3d[data-glb-url]"))void renderStage(el);
})();</script>`;

export interface StudioInspectBinaryMeta {
	readonly bytes: number;
	readonly mediaType: string;
	readonly inCompanyMount?: boolean;
}

export interface StudioInspectLocalAsset {
	readonly sourcePath: string;
	readonly sha256: string;
}

export interface StudioInspectSnapshot {
	readonly surfaceTitle: string;
	readonly folderRoot: string;
	readonly starter: SurfaceStarterKind;
	readonly files: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, { readonly bytes: Uint8Array; readonly mediaType: string }>>;
	readonly knownBinaries?: Readonly<Record<string, StudioInspectBinaryMeta>>;
	readonly localAssetPaths?: Readonly<Record<string, StudioInspectLocalAsset>>;
}

export interface InspectSurfaceToolOptions {
	readonly machine: StudioChatGptVoiceMachine;
	readonly loadSnapshot: (
		signal: AbortSignal,
		options?: { readonly changeId?: string },
	) => Promise<StudioInspectSnapshot>;
	readonly pollMs?: number;
}

export interface RenderedStudioPreview {
	readonly html: string;
	readonly activeTab: { readonly id: string; readonly title: string };
	readonly tabs: readonly { readonly id: string; readonly title: string }[];
	readonly renderedBlocks: readonly { readonly type: string; readonly heading: string; readonly filled: boolean }[];
	readonly warnings: readonly string[];
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function sanitizeInlineCss(css: string): string {
	return css.replace(/<\/style/gi, "<\\/style").replace(/@import\s+[^;]+;/gi, "");
}

function sanitizeInlineSvg(svg: string): string {
	return svg
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveCompanyPath(folderRoot: string, bindingPath: string): string | undefined {
	try {
		return surfaceCompanyPath(folderRoot, bindingPath);
	} catch {
		return undefined;
	}
}

function createSnapshotReader(snapshot: StudioInspectSnapshot) {
	const parsed = new Map<string, unknown>();
	const readJson = (bindingPath: string): unknown => {
		const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
		if (!path) return undefined;
		if (!parsed.has(path)) {
			const text = snapshot.files[path];
			let val: unknown;
			if (text !== undefined) {
				try {
					val = JSON.parse(text);
				} catch {
					val = undefined;
				}
			}
			parsed.set(path, val);
		}
		return parsed.get(path);
	};
	return {
		readSource(source: SurfaceSource | undefined): { readonly found: boolean; readonly value: unknown } {
			if (source === undefined) return { found: false, value: undefined };
			return resolveSurfaceSource(source, readJson);
		},
		fileText(bindingPath: string): string | undefined {
			const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
			return path ? snapshot.files[path] : undefined;
		},
		binary(bindingPath: string): { readonly bytes: Uint8Array; readonly mediaType: string } | undefined {
			const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
			return path ? snapshot.binaries[path] : undefined;
		},
		knownBinary(bindingPath: string): { readonly path: string; readonly meta: StudioInspectBinaryMeta } | undefined {
			const path = resolveCompanyPath(snapshot.folderRoot, bindingPath);
			if (!path) return undefined;
			const meta = snapshot.knownBinaries?.[path];
			return meta ? { path, meta } : undefined;
		},
	};
}

function formatNum(value: number, unit?: string): string {
	if (!Number.isFinite(value)) return "–";
	const abs = Math.abs(value);
	const body =
		abs >= 1_000_000
			? `${(value / 1_000_000).toFixed(1)}M`
			: abs >= 10_000
				? `${(value / 1_000).toFixed(1)}k`
				: Number.isInteger(value)
					? String(value)
					: value.toFixed(1);
	if (!unit) return body;
	if (unit === "$" || unit === "€" || unit === "£") return `${unit}${body}`;
	if (unit === "%") return `${body}%`;
	return `${body} ${unit}`;
}

function resolveSvgColor(raw: string | undefined, fallback: string, palette: readonly string[], dark: boolean): string {
	if (!raw) return fallback;
	const trimmed = raw.trim();
	const cssVar = /^var\((--[a-z0-9-]+)\)$/i.exec(trimmed);
	if (cssVar) {
		const name = cssVar[1]!.toLowerCase();
		if (name.includes("accent") || name.includes("primary")) return palette[0]!;
		if (name.includes("muted") || name.includes("soft")) return dark ? "#b8b7b2" : "#686866";
		if (name.includes("danger") || name.includes("error")) return dark ? "#ff9084" : "#b33a2f";
		if (name.includes("success") || name.includes("positive")) return dark ? "#5ed6a9" : "#0f7a55";
		return fallback;
	}
	return escapeHtml(trimmed);
}

function resolveAxisSpan(
	values: readonly number[],
	explicitMin: number | undefined,
	explicitMax: number | undefined,
	defaultZeroFloor: boolean,
): { readonly min: number; readonly max: number } {
	const dataMin = values.length > 0 ? Math.min(...values) : 0;
	const dataMax = values.length > 0 ? Math.max(...values) : 1;
	let min = explicitMin ?? (defaultZeroFloor ? Math.min(0, dataMin) : dataMin);
	let max = explicitMax ?? Math.max(defaultZeroFloor ? 1 : dataMin + 1, dataMax);
	if (min >= max) {
		if (explicitMax !== undefined && explicitMin === undefined) min = max - Math.max(1, Math.abs(max));
		else max = min + Math.max(1, Math.abs(min));
	}
	return { min, max };
}

function renderChartSvg(doc: SurfaceChartDocument, dark: boolean): string {
	const palette = dark
		? ["#e5835c", "#5ed6a9", "#6aa8ff", "#f2c35d", "#d49bff", "#ff9084"]
		: ["#d76f45", "#0f7a55", "#2b6cb0", "#b7791f", "#7c4dff", "#b33a2f"];
	const text = dark ? "#f4f3f0" : "#161615";
	const muted = dark ? "#b8b7b2" : "#686866";
	const grid = dark ? "rgba(255,255,255,0.09)" : "rgba(18,18,17,0.08)";
	const W = 720;
	const H = 310;

	if (doc.kind === "pie") {
		const slices = (doc.series?.[0]?.data ?? [])
			.map((entry, idx) => {
				const value =
					entry === null
						? 0
						: typeof entry === "number"
							? entry
							: typeof entry.value === "number"
								? entry.value
								: entry.value[1];
				const name =
					(entry && typeof entry === "object" && entry.name) || doc.categories?.[idx] || `Item ${idx + 1}`;
				const rawColor = entry && typeof entry === "object" ? entry.color : undefined;
				return {
					name,
					value: Math.max(0, value),
					color: resolveSvgColor(rawColor, palette[idx % palette.length]!, palette, dark),
				};
			})
			.filter((s) => s.value > 0);
		const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
		const cx = 210;
		const cy = 155;
		const r = 110;
		const inner = doc.donut ? 62 : 0;
		let angle = -Math.PI / 2;
		const paths = slices
			.map((s) => {
				const span = (s.value / total) * Math.PI * 2;
				const end = angle + span;
				const large = span > Math.PI ? 1 : 0;
				const x1 = cx + Math.cos(angle) * r;
				const y1 = cy + Math.sin(angle) * r;
				const x2 = cx + Math.cos(end) * r;
				const y2 = cy + Math.sin(end) * r;
				let d: string;
				if (inner > 0) {
					const ix1 = cx + Math.cos(end) * inner;
					const iy1 = cy + Math.sin(end) * inner;
					const ix2 = cx + Math.cos(angle) * inner;
					const iy2 = cy + Math.sin(angle) * inner;
					d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix2} ${iy2} Z`;
				} else {
					d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
				}
				angle = end;
				return `<path d="${d}" fill="${s.color}" stroke="${dark ? "#181918" : "#fff"}" stroke-width="2"/>`;
			})
			.join("");
		const legend = slices
			.slice(0, 8)
			.map(
				(s, idx) =>
					`<g transform="translate(380,${46 + idx * 28})"><circle cx="6" cy="6" r="5" fill="${s.color}"/><text x="20" y="10" fill="${text}" font-size="13">${escapeHtml(s.name)} — ${formatNum(s.value, doc.unit)} (${Math.round((s.value / total) * 100)}%)</text></g>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${paths}${legend}</svg>`;
	}

	if (doc.kind === "funnel") {
		const stages = (doc.series?.[0]?.data ?? []).map((entry, idx) => ({
			name: (entry && typeof entry === "object" && entry.name) || doc.categories?.[idx] || `Stage ${idx + 1}`,
			value:
				entry === null
					? 0
					: typeof entry === "number"
						? entry
						: typeof entry.value === "number"
							? entry.value
							: entry.value[1],
			color: resolveSvgColor(
				entry && typeof entry === "object" ? entry.color : undefined,
				palette[idx % palette.length]!,
				palette,
				dark,
			),
		}));
		const maxVal = Math.max(...stages.map((s) => s.value), 1);
		const rowH = Math.min(46, Math.floor((H - 30) / Math.max(stages.length, 1)));
		const bars = stages
			.map((s, idx) => {
				const w = Math.max(90, Math.round((s.value / maxVal) * 520));
				const x = Math.round((W - w) / 2);
				const y = 16 + idx * (rowH + 6);
				return `<rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="8" fill="${s.color}" opacity="0.9"/><text x="${W / 2}" y="${y + rowH / 2 + 5}" text-anchor="middle" fill="#fff" font-size="13" font-weight="650">${escapeHtml(s.name)} · ${formatNum(s.value, doc.unit)}</text>`;
			})
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${bars}</svg>`;
	}

	if (doc.kind === "sankey") {
		const nodes = doc.nodes ?? [];
		const links = doc.links ?? [];
		const sources = new Set(links.map((l) => l.source));
		const targets = new Set(links.map((l) => l.target));
		const left = nodes.filter((n) => sources.has(n.name) && !targets.has(n.name));
		const right = nodes.filter((n) => targets.has(n.name) && !sources.has(n.name));
		const middle = nodes.filter((n) => !left.includes(n) && !right.includes(n));
		const cols = [left, middle, right].filter((c) => c.length > 0);
		const pos = new Map<string, { x: number; y: number; color: string }>();
		cols.forEach((col, cIdx) => {
			const x = cols.length === 1 ? W / 2 : 120 + (cIdx * (W - 240)) / (cols.length - 1);
			col.forEach((n, rIdx) => {
				const y = 40 + ((rIdx + 0.5) * (H - 80)) / Math.max(col.length, 1);
				pos.set(n.name, {
					x,
					y,
					color: resolveSvgColor(n.color, palette[(cIdx * 3 + rIdx) % palette.length]!, palette, dark),
				});
			});
		});
		const maxFlow = Math.max(...links.map((l) => l.value), 1);
		const edgesSvg = links
			.map((l) => {
				const a = pos.get(l.source);
				const b = pos.get(l.target);
				if (!a || !b) return "";
				const strokeW = Math.max(3, Math.round((l.value / maxFlow) * 26));
				const mx = (a.x + b.x) / 2;
				return `<path d="M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}" fill="none" stroke="${a.color}" stroke-opacity="0.38" stroke-width="${strokeW}"/>`;
			})
			.join("");
		const nodesSvg = [...pos.entries()]
			.map(
				([name, p]) =>
					`<rect x="${p.x - 6}" y="${p.y - 16}" width="12" height="32" rx="3" fill="${p.color}"/><text x="${p.x > W / 2 ? p.x + 12 : p.x - 12}" y="${p.y + 4}" text-anchor="${p.x > W / 2 ? "start" : "end"}" fill="${text}" font-size="12" font-weight="600">${escapeHtml(name)}</text>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${edgesSvg}${nodesSvg}</svg>`;
	}

	if (doc.kind === "radar" && doc.indicators && doc.indicators.length >= 3) {
		const cx = 360;
		const cy = 155;
		const r = 105;
		const n = doc.indicators.length;
		const rings = [0.33, 0.66, 1]
			.map((scale) => {
				const pts = doc
					.indicators!.map((_, i) => {
						const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
						return `${cx + Math.cos(a) * r * scale},${cy + Math.sin(a) * r * scale}`;
					})
					.join(" ");
				return `<polygon points="${pts}" fill="none" stroke="${grid}" stroke-width="1"/>`;
			})
			.join("");
		const labels = doc.indicators
			.map((ind, i) => {
				const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
				const lx = cx + Math.cos(a) * (r + 22);
				const ly = cy + Math.sin(a) * (r + 18);
				return `<text x="${lx}" y="${ly}" text-anchor="middle" fill="${muted}" font-size="11.5">${escapeHtml(ind.name)}</text>`;
			})
			.join("");
		const polys = (doc.series ?? [])
			.map((s, sIdx) => {
				const color = resolveSvgColor(s.color, palette[sIdx % palette.length]!, palette, dark);
				const pts = doc
					.indicators!.map((ind, i) => {
						const raw = s.data[i];
						const v =
							typeof raw === "number"
								? raw
								: raw && typeof raw === "object" && typeof raw.value === "number"
									? raw.value
									: 0;
						const ratio = Math.max(0, Math.min(1, v / ind.max));
						const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
						return `${cx + Math.cos(a) * r * ratio},${cy + Math.sin(a) * r * ratio}`;
					})
					.join(" ");
				return `<polygon points="${pts}" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2.2"/>`;
			})
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${rings}${polys}${labels}</svg>`;
	}

	if (doc.kind === "heatmap" && doc.xCategories && doc.yCategories && doc.cells) {
		const cols = doc.xCategories.length;
		const rows = doc.yCategories.length;
		const left = 96;
		const top = 16;
		const cellW = Math.max(16, Math.floor((W - left - 20) / Math.max(cols, 1)));
		const cellH = Math.max(18, Math.floor((H - top - 36) / Math.max(rows, 1)));
		const vals = doc.cells.map((c) => c[2]);
		const min = Math.min(...vals);
		const max = Math.max(...vals);
		const span = max - min || 1;
		const rects = doc.cells
			.map(([x, y, v]) => {
				const opacity = 0.12 + ((v - min) / span) * 0.85;
				const px = left + x * cellW;
				const py = top + y * cellH;
				return `<rect x="${px + 1}" y="${py + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="4" fill="${palette[0]}" fill-opacity="${opacity.toFixed(2)}"/><text x="${px + cellW / 2}" y="${py + cellH / 2 + 4}" text-anchor="middle" fill="${text}" font-size="10.5">${formatNum(v, doc.unit)}</text>`;
			})
			.join("");
		const yLabels = doc.yCategories
			.map(
				(label, idx) =>
					`<text x="${left - 8}" y="${top + idx * cellH + cellH / 2 + 4}" text-anchor="end" fill="${muted}" font-size="11">${escapeHtml(label)}</text>`,
			)
			.join("");
		const xLabels = doc.xCategories
			.map(
				(label, idx) =>
					`<text x="${left + idx * cellW + cellW / 2}" y="${top + rows * cellH + 18}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(label)}</text>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${rects}${yLabels}${xLabels}</svg>`;
	}

	const seriesList = doc.series ?? [];
	const seriesColors = seriesList.map((s, sIdx) =>
		resolveSvgColor(s.color, palette[sIdx % palette.length]!, palette, dark),
	);
	const allNums: number[] = [];
	const allXs: number[] = [];
	for (const s of seriesList) {
		for (let idx = 0; idx < s.data.length; idx += 1) {
			const item = s.data[idx];
			if (typeof item === "number") {
				allNums.push(item);
				allXs.push(idx);
			} else if (item && typeof item === "object") {
				if (typeof item.value === "number") {
					allNums.push(item.value);
					allXs.push(idx);
				} else {
					allXs.push(item.value[0]);
					allNums.push(item.value[1]);
				}
			}
		}
	}
	const count = Math.max(...seriesList.map((s) => s.data.length), doc.categories?.length ?? 0, 1);
	const cats = doc.categories ?? Array.from({ length: count }, (_, i) => String(i + 1));
	const legend =
		seriesList.length > 1
			? seriesList
					.map(
						(s, idx) =>
							`<g transform="translate(${62 + idx * 130}, 10)"><circle cx="5" cy="4" r="4" fill="${seriesColors[idx]}"/><text x="14" y="8" fill="${muted}" font-size="11.5">${escapeHtml(s.name.slice(0, 16))}</text></g>`,
					)
					.join("")
			: "";

	if (doc.kind === "bar" && doc.horizontal === true) {
		const { min: minV, max: maxV } = resolveAxisSpan(
			allNums,
			doc.xAxisMin ?? doc.yAxisMin,
			doc.xAxisMax ?? doc.yAxisMax,
			true,
		);
		const padL = 112;
		const padR = 24;
		const padT = seriesList.length > 1 ? 30 : 20;
		const padB = 34;
		const plotW = W - padL - padR;
		const plotH = H - padT - padB;
		const xFor = (val: number) => padL + ((Math.max(minV, Math.min(maxV, val)) - minV) / (maxV - minV || 1)) * plotW;
		const x0 = xFor(Math.max(minV, Math.min(maxV, 0)));
		const gridLines = [0, 0.25, 0.5, 0.75, 1]
			.map((f) => {
				const val = minV + (maxV - minV) * f;
				const x = xFor(val);
				return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="${grid}" stroke-dasharray="3 4"/><text x="${x}" y="${H - 14}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(formatNum(val, doc.unit))}</text>`;
			})
			.join("");
		const groupH = plotH / count;
		const barH = Math.max(8, Math.min(28, (groupH * 0.72) / Math.max(seriesList.length, 1)));
		let shapes = "";
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			s.data.forEach((item, idx) => {
				const val =
					typeof item === "number"
						? item
						: item && typeof item === "object" && typeof item.value === "number"
							? item.value
							: 0;
				const barColor =
					item && typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				const y = padT + idx * groupH + (groupH - barH * seriesList.length) / 2 + sIdx * barH;
				const x1 = xFor(val);
				shapes += `<rect x="${Math.min(x0, x1)}" y="${y}" width="${Math.max(2, Math.abs(x1 - x0))}" height="${Math.max(2, barH - 2)}" rx="4" fill="${barColor}"/>`;
			});
			for (const line of s.markLine ?? []) {
				if (line.value < minV || line.value > maxV) continue;
				const mx = xFor(line.value);
				const label = line.label
					? `${line.label} · ${formatNum(line.value, doc.unit)}`
					: formatNum(line.value, doc.unit);
				shapes += `<line x1="${mx}" y1="${padT}" x2="${mx}" y2="${H - padB}" stroke="${muted}" stroke-dasharray="4 4" stroke-width="1.25"/><text x="${mx}" y="${padT - 5}" text-anchor="middle" fill="${muted}" font-size="10.5">${escapeHtml(label)}</text>`;
			}
		});
		const yLabels = cats
			.map(
				(cat, idx) =>
					`<text x="${padL - 8}" y="${padT + (idx + 0.5) * groupH + 4}" text-anchor="end" fill="${muted}" font-size="11">${escapeHtml(cat.slice(0, 16))}</text>`,
			)
			.join("");
		return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${legend}${gridLines}${shapes}${yLabels}</svg>`;
	}

	const { min: minY, max: maxY } = resolveAxisSpan(allNums, doc.yAxisMin, doc.yAxisMax, true);
	const padL = 62;
	const padR = 20;
	const padT = 26;
	const padB = 40;
	const plotW = W - padL - padR;
	const plotH = H - padT - padB;
	const yFor = (val: number) =>
		padT + plotH - ((Math.max(minY, Math.min(maxY, val)) - minY) / (maxY - minY || 1)) * plotH;
	const gridLines = [0, 0.25, 0.5, 0.75, 1]
		.map((f) => {
			const val = minY + (maxY - minY) * f;
			const y = yFor(val);
			return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${grid}" stroke-dasharray="3 4"/><text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="${muted}" font-size="11">${escapeHtml(formatNum(val, doc.unit))}</text>`;
		})
		.join("");

	let shapes = "";
	if (doc.kind === "bar") {
		const groupW = plotW / count;
		const barW = Math.max(8, Math.min(36, (groupW * 0.72) / Math.max(seriesList.length, 1)));
		const y0 = yFor(Math.max(minY, Math.min(maxY, 0)));
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			s.data.forEach((item, idx) => {
				const val =
					typeof item === "number"
						? item
						: item && typeof item === "object" && typeof item.value === "number"
							? item.value
							: 0;
				const barColor =
					item && typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				const x = padL + idx * groupW + (groupW - barW * seriesList.length) / 2 + sIdx * barW;
				const y1 = yFor(val);
				shapes += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${barW - 2}" height="${Math.max(2, Math.abs(y1 - y0))}" rx="4" fill="${barColor}"/>`;
			});
		});
	} else if (doc.kind === "scatter") {
		const { min: minX, max: maxX } = resolveAxisSpan(allXs, doc.xAxisMin, doc.xAxisMax, true);
		const xFor = (val: number) => padL + ((val - minX) / (maxX - minX || 1)) * plotW;
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			s.data.forEach((item, idx) => {
				if (item === null) return;
				const xVal = typeof item === "number" ? idx : typeof item.value === "number" ? idx : item.value[0];
				const yVal = typeof item === "number" ? item : typeof item.value === "number" ? item.value : item.value[1];
				const pointColor =
					typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				shapes += `<circle cx="${xFor(xVal)}" cy="${yFor(yVal)}" r="6" fill="${pointColor}" fill-opacity="0.85"/>`;
			});
		});
	} else {
		seriesList.forEach((s, sIdx) => {
			const seriesColor = seriesColors[sIdx]!;
			const pts: { x: number; y: number; color: string }[] = [];
			s.data.forEach((item, idx) => {
				if (item === null) return;
				const val = typeof item === "number" ? item : typeof item.value === "number" ? item.value : item.value[1];
				const x = padL + (count === 1 ? plotW / 2 : (idx / (count - 1)) * plotW);
				const pointColor =
					typeof item === "object" && item.color
						? resolveSvgColor(item.color, seriesColor, palette, dark)
						: seriesColor;
				pts.push({ x, y: yFor(val), color: pointColor });
			});
			if (pts.length > 0) {
				const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
				if (doc.kind === "area") {
					const baseY = yFor(minY);
					const area = `${path} L ${pts[pts.length - 1]!.x.toFixed(1)} ${baseY.toFixed(1)} L ${pts[0]!.x.toFixed(1)} ${baseY.toFixed(1)} Z`;
					shapes += `<path d="${area}" fill="${seriesColor}" fill-opacity="0.18"/>`;
				}
				shapes += `<path d="${path}" fill="none" stroke="${seriesColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
				shapes += pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="${p.color}"/>`).join("");
			}
		});
	}
	for (const s of seriesList) {
		for (const line of s.markLine ?? []) {
			if (line.value < minY || line.value > maxY) continue;
			const my = yFor(line.value);
			const label = line.label
				? `${line.label} · ${formatNum(line.value, doc.unit)}`
				: formatNum(line.value, doc.unit);
			shapes += `<line x1="${padL}" y1="${my}" x2="${W - padR}" y2="${my}" stroke="${muted}" stroke-dasharray="4 4" stroke-width="1.25"/><text x="${W - padR - 4}" y="${my - 5}" text-anchor="end" fill="${muted}" font-size="10.5">${escapeHtml(label)}</text>`;
		}
	}
	let xLabels = "";
	if (doc.kind === "scatter") {
		const { min: minX, max: maxX } = resolveAxisSpan(allXs, doc.xAxisMin, doc.xAxisMax, true);
		xLabels = [0, 0.25, 0.5, 0.75, 1]
			.map((f) => {
				const val = minX + (maxX - minX) * f;
				const x = padL + f * plotW;
				return `<text x="${x}" y="${H - 14}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(formatNum(val))}</text>`;
			})
			.join("");
	} else {
		const step = Math.max(1, Math.ceil(cats.length / 10));
		xLabels = cats
			.map((cat, idx) => {
				if (idx % step !== 0 && idx !== cats.length - 1) return "";
				const x =
					padL +
					(doc.kind === "bar"
						? (idx + 0.5) * (plotW / count)
						: count === 1
							? plotW / 2
							: (idx / (count - 1)) * plotW);
				return `<text x="${x}" y="${H - 14}" text-anchor="middle" fill="${muted}" font-size="11">${escapeHtml(cat.slice(0, 14))}</text>`;
			})
			.join("");
	}
	return `<svg viewBox="0 0 ${W} ${H}" class="pv-svg">${legend}${gridLines}${shapes}${xLabels}</svg>`;
}

interface PreviewRenderContext {
	readonly assetUrls?: Readonly<Record<string, string>>;
	readonly activeTintHex?: string;
	needsGlbScript: boolean;
}

function extractColorSwatches(value: unknown): { readonly name: string; readonly value: string }[] {
	const entries: { name: string; value: string }[] = [];
	if (isPlainRecord(value)) {
		for (const [k, v] of Object.entries(value)) {
			if (typeof v === "string" && v.trim()) entries.push({ name: k, value: v.trim() });
		}
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (
				isPlainRecord(item) &&
				typeof item.name === "string" &&
				typeof (item.hex ?? item.value ?? item.color) === "string"
			) {
				entries.push({ name: item.name, value: String(item.hex ?? item.value ?? item.color).trim() });
			}
		}
	}
	return entries;
}

function resolveStageGlbPath(folderRoot: string, modelSource: SurfaceSource, glbName: string): string | undefined {
	const clean = glbName.trim().replace(/^\/+/, "");
	if (!clean) return undefined;
	const firstSource = Array.isArray(modelSource) ? modelSource[0] : modelSource;
	const sourceStr = typeof firstSource === "string" ? (firstSource.split("#", 1)[0] ?? "") : "";
	const slash = sourceStr.lastIndexOf("/");
	const rel = slash > 0 && !clean.includes("/") ? `${sourceStr.slice(0, slash + 1)}${clean}` : clean;
	return resolveCompanyPath(folderRoot, rel);
}

function findLegacyModelConfig(snapshot: StudioInspectSnapshot): Record<string, unknown> | null {
	const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
	for (const path of Object.keys(snapshot.files).sort()) {
		if (rootPrefix && !path.startsWith(rootPrefix)) continue;
		if (!path.toLowerCase().endsWith(".json") || /(?:^|\/)object\.json$|\.report\.json$/i.test(path)) continue;
		try {
			const parsed = JSON.parse(snapshot.files[path]!) as unknown;
			if (!isPlainRecord(parsed)) continue;
			const key = surfaceLegacyModelKey(parsed);
			if (key && isPlainRecord(parsed[key])) return parsed[key] as Record<string, unknown>;
		} catch {}
	}
	return null;
}

function renderBlockHtml(
	block: SurfaceReadBlock,
	snapshot: StudioInspectSnapshot,
	reader: ReturnType<typeof createSnapshotReader>,
	dark: boolean,
	inlineBudget: { imageUsed: number; svgUsed: number; moduleUsed: number },
	renderedBlocks: { readonly type: string; readonly heading: string; readonly filled: boolean }[],
	warnings: string[],
	previewCtx: PreviewRenderContext,
): string {
	const heading = "heading" in block && typeof block.heading === "string" ? block.heading : block.type;
	const wrap = (title: string, body: string, filled: boolean) => {
		renderedBlocks.push({ type: block.type, heading: title, filled });
		return `<section class="pv-section" data-block="${escapeHtml(block.type)}"><div class="pv-section-head"><h2>${escapeHtml(title)}</h2></div>${body}</section>`;
	};

	switch (block.type) {
		case "title": {
			const nameRead = reader.readSource(block.name);
			const lineRead = reader.readSource(block.line);
			const name =
				typeof nameRead.value === "string" && nameRead.value.trim() ? nameRead.value.trim() : snapshot.surfaceTitle;
			const line = typeof lineRead.value === "string" ? lineRead.value.trim() : "";
			renderedBlocks.push({ type: "title", heading: name, filled: Boolean(line || name) });
			return `<header class="pv-hero"><h1>${escapeHtml(name)}</h1>${line ? `<p class="pv-hero-line">${escapeHtml(line)}</p>` : ""}</header>`;
		}
		case "facts": {
			const items: { label: string; value: string }[] = [];
			if ("items" in block) {
				for (const item of block.items) {
					const got = reader.readSource(item.from);
					items.push({
						label: item.label,
						value: got.found && got.value !== null && got.value !== undefined ? String(got.value) : "?",
					});
				}
			} else {
				const got = reader.readSource(block.from);
				if (isPlainRecord(got.value)) {
					for (const [k, v] of Object.entries(got.value)) {
						if (block.skip.includes(k) || items.length >= block.take) continue;
						if (typeof v === "string" || typeof v === "number") items.push({ label: k, value: String(v) });
					}
				} else if (Array.isArray(got.value)) {
					for (const row of got.value) {
						if (items.length >= block.take) break;
						if (isPlainRecord(row) && typeof row.label === "string") {
							items.push({ label: row.label, value: String(row.value ?? "?") });
						}
					}
				}
			}
			const filled = items.some((i) => i.value !== "?");
			if (!filled) warnings.push(`Facts block "${heading}" has no populated figures.`);
			const grid = `<div class="pv-facts">${items.map((i) => `<div class="pv-fact"><div class="pv-fact-val">${escapeHtml(i.value)}</div><div class="pv-fact-lbl">${escapeHtml(i.label)}</div></div>`).join("")}</div>`;
			return block.heading
				? wrap(block.heading, grid, filled)
				: (() => {
						renderedBlocks.push({ type: "facts", heading: "Facts", filled });
						return `<section class="pv-section">${grid}</section>`;
					})();
		}
		case "chart": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseSurfaceChartDocument(read.value) : null;
			const title = block.heading ?? doc?.title ?? "Chart";
			if (!doc) {
				warnings.push(`Chart block "${title}" has no valid chart data.`);
				return wrap(title, `<div class="pv-empty">No chart data yet</div>`, false);
			}
			const caption = block.caption ?? doc.note;
			return wrap(
				title,
				`${doc.subtitle ? `<p class="pv-sub">${escapeHtml(doc.subtitle)}</p>` : ""}<div class="pv-chart-card">${renderChartSvg(doc, dark)}</div>${caption ? `<p class="pv-caption">${escapeHtml(caption)}</p>` : ""}`,
				true,
			);
		}
		case "plays": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseStrategyPlaysDocument(read.value) : null;
			const title = block.heading ?? "Competing plays";
			if (!doc) {
				warnings.push(`Plays block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No plays staged yet</div>`, false);
			}
			const cards = doc.plays
				.map(
					(play) =>
						`<article class="pv-card${play.status === "recommended" ? " is-accent" : ""}"><div class="pv-card-top"><strong>${escapeHtml(play.name)}</strong>${play.status === "recommended" ? `<span class="pv-badge is-accent">Recommended</span>` : ""}</div>${play.thesis ? `<p>${escapeHtml(play.thesis)}</p>` : ""}</article>`,
				)
				.join("");
			return wrap(
				title,
				`${doc.summary ? `<p class="pv-sub">${escapeHtml(doc.summary)}</p>` : ""}<div class="pv-grid">${cards}</div>`,
				true,
			);
		}
		case "economics": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseEconomicsDocument(read.value) : null;
			const title = block.heading ?? doc?.title ?? "Unit economics";
			if (!doc) {
				warnings.push(`Economics block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No economics model yet</div>`, false);
			}
			const levers = doc.inputs
				.slice(0, 6)
				.map(
					(input) =>
						`<div class="pv-fact"><div class="pv-fact-val">${escapeHtml(formatNum(input.value, input.unit))}</div><div class="pv-fact-lbl">${escapeHtml(input.label)}</div></div>`,
				)
				.join("");
			const scenarios = (doc.scenarios ?? [])
				.map((scenario) => `<span class="pv-pill">${escapeHtml(scenario.name)}</span>`)
				.join("");
			return wrap(
				title,
				`${doc.subtitle ? `<p class="pv-sub">${escapeHtml(doc.subtitle)}</p>` : ""}${scenarios ? `<div class="pv-pills">${scenarios}</div>` : ""}<div class="pv-facts">${levers}</div>`,
				true,
			);
		}
		case "hypotheses": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseStrategyHypothesesDocument(read.value) : null;
			const title = block.heading ?? "Hypotheses";
			if (!doc) {
				warnings.push(`Hypotheses block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No hypotheses yet</div>`, false);
			}
			const rows = doc.hypotheses
				.slice(0, 8)
				.map(
					(item) =>
						`<div class="pv-hyp-row"><span class="pv-badge is-${escapeHtml(item.impact)}">${escapeHtml(item.impact)}</span><strong>${escapeHtml(item.bet)}</strong><span class="pv-muted">${escapeHtml(item.status)}</span></div>`,
				)
				.join("");
			return wrap(title, `<div class="pv-list">${rows}</div>`, true);
		}
		case "landscape": {
			const read = reader.readSource(block.from);
			const doc = read.found ? parseStrategyLandscapeDocument(read.value) : null;
			const title = block.heading ?? "Competitive landscape";
			if (!doc) {
				warnings.push(`Landscape block "${title}" is empty.`);
				return wrap(title, `<div class="pv-empty">No rivals mapped yet</div>`, false);
			}
			const placed = doc.players.filter((p) => typeof p.x === "number" && typeof p.y === "number");
			const mapSvg =
				doc.axes && placed.length >= 2
					? `<div class="pv-chart-card"><svg viewBox="0 0 640 280" class="pv-svg"><rect x="44" y="16" width="560" height="224" rx="12" fill="none" stroke="${dark ? "rgba(255,255,255,0.12)" : "rgba(18,18,17,0.12)"}"/><line x1="324" y1="16" x2="324" y2="240" stroke="${dark ? "rgba(255,255,255,0.08)" : "rgba(18,18,17,0.08)"}" stroke-dasharray="4 4"/><line x1="44" y1="128" x2="604" y2="128" stroke="${dark ? "rgba(255,255,255,0.08)" : "rgba(18,18,17,0.08)"}" stroke-dasharray="4 4"/>${placed
							.map((p) => {
								const cx = 44 + (Math.max(0, Math.min(100, p.x!)) / 100) * 560;
								const cy = 240 - (Math.max(0, Math.min(100, p.y!)) / 100) * 224;
								const fill = p.isUs ? (dark ? "#e5835c" : "#d76f45") : dark ? "#908f8a" : "#555";
								return `<circle cx="${cx}" cy="${cy}" r="${p.isUs ? 9 : 6}" fill="${fill}"/><text x="${cx + 10}" y="${cy + 4}" fill="${dark ? "#f4f3f0" : "#161615"}" font-size="12" font-weight="${p.isUs ? "700" : "500"}">${escapeHtml(p.name)}</text>`;
							})
							.join(
								"",
							)}<text x="324" y="264" text-anchor="middle" fill="${dark ? "#b8b7b2" : "#686866"}" font-size="11.5">${escapeHtml(doc.axes.xLabel)} · ${escapeHtml(doc.axes.yLabel)}</text></svg></div>`
					: "";
			const chips = doc.players
				.map(
					(p) =>
						`<span class="pv-pill${p.isUs ? " is-accent" : ""}">${escapeHtml(p.name)}${p.pricing ? ` · ${escapeHtml(p.pricing)}` : ""}</span>`,
				)
				.join("");
			return wrap(
				title,
				`${doc.wedge ? `<p class="pv-wedge"><strong>Our wedge:</strong> ${escapeHtml(doc.wedge)}</p>` : ""}${mapSvg}<div class="pv-pills">${chips}</div>`,
				true,
			);
		}
		case "palette": {
			const read = reader.readSource(block.from);
			const entries: { name: string; value: string }[] = [];
			if (isPlainRecord(read.value)) {
				for (const [k, v] of Object.entries(read.value)) {
					if (typeof v === "string") entries.push({ name: k, value: v });
				}
			} else if (Array.isArray(read.value)) {
				for (const item of read.value) {
					if (
						isPlainRecord(item) &&
						typeof item.name === "string" &&
						typeof (item.hex ?? item.value) === "string"
					) {
						entries.push({ name: item.name, value: String(item.hex ?? item.value) });
					}
				}
			}
			const title = block.heading ?? "Palette";
			if (entries.length === 0) return wrap(title, `<div class="pv-empty">No palette colours yet</div>`, false);
			return wrap(
				title,
				`<div class="pv-swatches">${entries.map((c) => `<div class="pv-swatch"><span class="pv-swatch-chip" style="background:${escapeHtml(c.value)}"></span><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.value)}</small></div>`).join("")}</div>`,
				true,
			);
		}
		case "brand_mark": {
			const title = block.heading ?? "Mark";
			const resolvedPath = resolveCompanyPath(snapshot.folderRoot, block.from);
			const stagedUrl = resolvedPath ? previewCtx.assetUrls?.[resolvedPath] : undefined;
			const svgText = reader.fileText(block.from);
			const bin = reader.binary(block.from);
			const known = reader.knownBinary(block.from);
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			let visual = "";
			if (stagedUrl) {
				visual = `<img class="pv-mark-img" src="${escapeHtml(stagedUrl)}" alt="${escapeHtml(title)}"/>`;
			} else if (svgText && /<svg[\s>]/i.test(svgText)) {
				const rawBytes = Buffer.byteLength(svgText, "utf8");
				if (rawBytes <= MAX_INLINE_SVG_BYTES) {
					const sanitized = sanitizeInlineSvg(svgText);
					const svgBytes = Buffer.byteLength(sanitized, "utf8");
					if (inlineBudget.svgUsed + svgBytes <= MAX_TOTAL_INLINE_SVG_BYTES) {
						inlineBudget.svgUsed += svgBytes;
						visual = `<div class="pv-mark-svg">${sanitized}</div>`;
					}
				}
				if (!visual) {
					const kb = Math.max(1, Math.round(rawBytes / 1024));
					visual = `<div class="pv-art-badge">SVG · ${kb} KB</div>`;
				}
			} else if (
				bin &&
				bin.bytes.byteLength <= MAX_INLINE_IMAGE_BYTES &&
				inlineBudget.imageUsed + bin.bytes.byteLength <= MAX_TOTAL_INLINE_IMAGES_BYTES
			) {
				inlineBudget.imageUsed += bin.bytes.byteLength;
				const b64 = Buffer.from(bin.bytes).toString("base64");
				visual = `<img class="pv-mark-img" src="data:${escapeHtml(bin.mediaType)};base64,${b64}" alt="${escapeHtml(title)}"/>`;
			} else if (bin) {
				visual = `<div class="pv-art-badge">${escapeHtml(bin.mediaType)} · ${Math.round(bin.bytes.byteLength / 1024)} KB</div>`;
			} else if (known) {
				const rel = known.path.startsWith(rootPrefix) ? known.path.slice(rootPrefix.length) : undefined;
				if (known.meta.inCompanyMount && rel && known.meta.mediaType.startsWith("image/")) {
					visual = `<img class="pv-mark-img" src="/company-asset/${encodeURI(rel)}" alt="${escapeHtml(title)}"/>`;
				} else {
					visual = `<div class="pv-art-badge">${escapeHtml(known.meta.mediaType)} · ${Math.round(known.meta.bytes / 1024)} KB</div>`;
				}
			}
			if (!visual) {
				warnings.push(`Brand mark "${title}" (${block.from}) is missing.`);
				return wrap(title, `<div class="pv-empty">No mark staged yet</div>`, false);
			}
			const grounds = block.grounds.map((g) => `<div class="pv-mark-ground is-${g}">${visual}</div>`).join("");
			return wrap(title, `<div class="pv-marks">${grounds}</div>`, true);
		}
		case "table": {
			const read = reader.readSource(block.from);
			const rows = Array.isArray(read.value) ? read.value.filter(isPlainRecord) : [];
			const title = block.heading ?? "Table";
			if (rows.length === 0) return wrap(title, `<div class="pv-empty">No rows yet</div>`, false);
			const cols =
				block.columns?.map((c) => ({ key: c.key, label: c.label })) ??
				Object.keys(rows[0]!)
					.slice(0, 8)
					.map((k) => ({ key: k, label: k }));
			const head = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
			const body = rows
				.slice(0, 20)
				.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(r[c.key] ?? ""))}</td>`).join("")}</tr>`)
				.join("");
			return wrap(
				title,
				`<div class="pv-table-wrap"><table class="pv-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
				true,
			);
		}
		case "cards": {
			const title = block.heading ?? "Cards";
			const cards: { title: string; body: string; badge?: string }[] = [];
			if ("items" in block) {
				for (const item of block.items) {
					const got = reader.readSource(item.from);
					if (got.found && got.value !== undefined && got.value !== null) {
						cards.push({
							title: item.title,
							body: typeof got.value === "string" ? got.value : JSON.stringify(got.value),
						});
					}
				}
			} else {
				const got = reader.readSource(block.from);
				if (Array.isArray(got.value)) {
					for (const item of got.value) {
						if (!isPlainRecord(item)) continue;
						const cardTitle = String(item[block.title] ?? "");
						const lines = block.lines
							.map((k) => String(item[k] ?? ""))
							.filter(Boolean)
							.join(" · ");
						const badge = block.badge && item[block.badge] ? String(item[block.badge]) : undefined;
						cards.push({ title: cardTitle, body: lines, ...(badge ? { badge } : {}) });
					}
				}
			}
			if (cards.length === 0) return wrap(title, `<div class="pv-empty">No cards yet</div>`, false);
			return wrap(
				title,
				`<div class="pv-grid">${cards.map((c) => `<article class="pv-card"><div class="pv-card-top"><strong>${escapeHtml(c.title)}</strong>${c.badge ? `<span class="pv-badge">${escapeHtml(c.badge)}</span>` : ""}</div><p>${escapeHtml(c.body.slice(0, 320))}</p></article>`).join("")}</div>`,
				true,
			);
		}
		case "spec_list": {
			const read = reader.readSource(block.from);
			const title = block.heading ?? "Specifications";
			if (!isPlainRecord(read.value)) return wrap(title, `<div class="pv-empty">No specs yet</div>`, false);
			const skip = new Set(block.skip ?? []);
			const rows = Object.entries(read.value)
				.filter(([k]) => !skip.has(k))
				.slice(0, 20)
				.map(
					([k, v]) =>
						`<div class="pv-spec-row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v))}</strong></div>`,
				)
				.join("");
			return wrap(
				title,
				rows ? `<div class="pv-specs">${rows}</div>` : `<div class="pv-empty">No specs yet</div>`,
				Boolean(rows),
			);
		}
		case "artifacts": {
			const title = block.heading ?? "Artifacts";
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			const candidates = [
				...new Set([
					...Object.keys(snapshot.files),
					...Object.keys(snapshot.binaries),
					...Object.keys(snapshot.knownBinaries ?? {}),
				]),
			]
				.filter((p) => p.startsWith(rootPrefix) && p !== `${rootPrefix}${SURFACE_LAYOUT_PATH}`)
				.filter((p) => {
					const rel = p.slice(rootPrefix.length);
					const matched =
						!block.match || block.match.some((g) => surfaceGlobMatches(g, g.startsWith("/") ? `/${p}` : rel));
					const skipped = block.skip?.some((g) => surfaceGlobMatches(g, g.startsWith("/") ? `/${p}` : rel));
					return matched && !skipped;
				})
				.slice(0, 12);
			if (candidates.length === 0) return wrap(title, `<div class="pv-empty">No artifacts staged yet</div>`, false);
			const cards = candidates
				.map((fullPath) => {
					const rel = fullPath.slice(rootPrefix.length);
					const bin = snapshot.binaries[fullPath];
					const known = snapshot.knownBinaries?.[fullPath];
					const txt = snapshot.files[fullPath];
					const stagedUrl = previewCtx.assetUrls?.[fullPath];
					const mediaType = bin?.mediaType ?? known?.mediaType ?? "";
					if (stagedUrl && mediaType.startsWith("image/")) {
						return `<figure class="pv-art-card"><img src="${escapeHtml(stagedUrl)}" alt="${escapeHtml(rel)}"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (
						bin?.mediaType.startsWith("image/") &&
						bin.bytes.byteLength <= MAX_INLINE_IMAGE_BYTES &&
						inlineBudget.imageUsed + bin.bytes.byteLength <= MAX_TOTAL_INLINE_IMAGES_BYTES
					) {
						inlineBudget.imageUsed += bin.bytes.byteLength;
						const b64 = Buffer.from(bin.bytes).toString("base64");
						return `<figure class="pv-art-card"><img src="data:${escapeHtml(bin.mediaType)};base64,${b64}" alt="${escapeHtml(rel)}"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (bin) {
						const kb = Math.max(1, Math.round(bin.bytes.byteLength / 1024));
						return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">${escapeHtml(rel.split(".").pop()?.toUpperCase() ?? "FILE")} · ${kb} KB</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (known?.inCompanyMount && known.mediaType.startsWith("image/")) {
						return `<figure class="pv-art-card"><img src="/company-asset/${encodeURI(rel)}" alt="${escapeHtml(rel)}"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (known) {
						const kb = Math.max(1, Math.round(known.bytes / 1024));
						return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">${escapeHtml(rel.split(".").pop()?.toUpperCase() ?? "FILE")} · ${kb} KB</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					if (txt && rel.toLowerCase().endsWith(".svg") && /<svg[\s>]/i.test(txt)) {
						const rawBytes = Buffer.byteLength(txt, "utf8");
						if (rawBytes <= MAX_INLINE_SVG_BYTES) {
							const sanitized = sanitizeInlineSvg(txt);
							const svgBytes = Buffer.byteLength(sanitized, "utf8");
							if (inlineBudget.svgUsed + svgBytes <= MAX_TOTAL_INLINE_SVG_BYTES) {
								inlineBudget.svgUsed += svgBytes;
								return `<figure class="pv-art-card"><div class="pv-art-svg">${sanitized}</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
							}
						}
						const kb = Math.max(1, Math.round(rawBytes / 1024));
						return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">SVG · ${kb} KB</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
					}
					return `<figure class="pv-art-card is-doc"><div class="pv-art-badge">${escapeHtml(rel.split(".").pop()?.toUpperCase() ?? "FILE")}</div><figcaption>${escapeHtml(rel)}</figcaption></figure>`;
				})
				.join("");
			return wrap(title, `<div class="pv-art-grid">${cards}</div>`, true);
		}
		case "report": {
			const title = block.heading ?? "Reports";
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			const matches =
				"from" in block
					? [resolveCompanyPath(snapshot.folderRoot, block.from)].filter((p): p is string =>
							Boolean(p && (snapshot.files[p] || snapshot.binaries[p] || snapshot.knownBinaries?.[p])),
						)
					: [
							...new Set([
								...Object.keys(snapshot.files),
								...Object.keys(snapshot.binaries),
								...Object.keys(snapshot.knownBinaries ?? {}),
							]),
						].filter((p) => {
							if (!p.startsWith(rootPrefix)) return false;
							const rel = p.slice(rootPrefix.length);
							return surfaceGlobMatches(block.match, block.match.startsWith("/") ? `/${p}` : rel);
						});
			if (matches.length === 0) return wrap(title, `<div class="pv-empty">No reports staged yet</div>`, false);
			const items = matches
				.slice(0, 6)
				.map((p) => {
					const txt = snapshot.files[p];
					if (txt && p.endsWith(".json")) {
						try {
							const parsed = JSON.parse(txt) as Record<string, unknown>;
							const rTitle = typeof parsed.title === "string" ? parsed.title : (p.split("/").pop() ?? p);
							const lead =
								typeof parsed.summary === "string"
									? parsed.summary
									: typeof parsed.subtitle === "string"
										? parsed.subtitle
										: "";
							return `<article class="pv-card"><strong>${escapeHtml(rTitle)}</strong>${lead ? `<p>${escapeHtml(lead.slice(0, 220))}</p>` : ""}</article>`;
						} catch {
							return `<article class="pv-card"><strong>${escapeHtml(p.split("/").pop() ?? p)}</strong></article>`;
						}
					}
					return `<article class="pv-card"><strong>${escapeHtml(p.split("/").pop() ?? p)}</strong></article>`;
				})
				.join("");
			return wrap(title, `<div class="pv-grid">${items}</div>`, true);
		}
		case "explainer": {
			const title = block.heading ?? "Explainer";
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			const matches =
				"from" in block
					? [resolveCompanyPath(snapshot.folderRoot, block.from)].filter((p): p is string =>
							Boolean(p && snapshot.files[p]),
						)
					: Object.keys(snapshot.files).filter((p) => {
							if (!p.startsWith(rootPrefix)) return false;
							return surfaceGlobMatches(block.match, p.slice(rootPrefix.length));
						});
			if (matches.length === 0) return wrap(title, `<div class="pv-empty">No explainer staged yet</div>`, false);
			return wrap(
				title,
				`<div class="pv-grid">${matches.map((p) => `<article class="pv-card is-accent"><strong>${escapeHtml(p.slice(rootPrefix.length))}</strong><p>Animated breakdown ready</p></article>`).join("")}</div>`,
				true,
			);
		}
		case "module": {
			const title = block.heading ?? "Interactive module";
			const htmlPath = resolveCompanyPath(snapshot.folderRoot, `${block.from.replace(/\/+$/, "")}/index.html`);
			const html = htmlPath ? snapshot.files[htmlPath] : undefined;
			if (!html || !htmlPath) {
				warnings.push(`Module block "${title}" (${block.from}/index.html) is missing.`);
				return wrap(title, `<div class="pv-empty">Module not built yet</div>`, false);
			}
			const h = typeof block.height === "number" ? block.height : 560;
			const stagedUrl = previewCtx.assetUrls?.[htmlPath];
			if (stagedUrl) {
				return wrap(
					title,
					`<iframe class="pv-module" style="height:${h}px" sandbox="allow-scripts allow-same-origin" src="${escapeHtml(stagedUrl)}"></iframe>`,
					true,
				);
			}
			const escaped = escapeHtml(html);
			const modBytes = Buffer.byteLength(escaped, "utf8");
			if (
				modBytes <= MAX_INLINE_MODULE_BYTES &&
				inlineBudget.moduleUsed + modBytes <= MAX_TOTAL_INLINE_MODULES_BYTES
			) {
				inlineBudget.moduleUsed += modBytes;
				return wrap(
					title,
					`<iframe class="pv-module" style="height:${h}px" sandbox="allow-scripts" srcdoc="${escaped}"></iframe>`,
					true,
				);
			}
			const kb = Math.max(1, Math.round(Buffer.byteLength(html, "utf8") / 1024));
			return wrap(
				title,
				`<div class="pv-art-card is-doc"><div class="pv-art-badge">HTML MODULE · ${kb} KB</div><figcaption>${escapeHtml(block.from)}/index.html</figcaption></div>`,
				true,
			);
		}
		case "swatch_row": {
			const read = reader.readSource(block.from);
			const swatches = extractColorSwatches(read.value);
			if (swatches.length === 0) {
				warnings.push("Colorways swatch_row has no colour entries yet.");
				return wrap("Colourways", `<div class="pv-empty">No colourways staged yet</div>`, false);
			}
			const dots = swatches
				.map(
					(swatch, index) =>
						`<span class="pv-dot-chip${index === 0 ? " is-on" : ""}"><span class="pv-dot" style="background:${escapeHtml(swatch.value)}"></span><span>${escapeHtml(swatch.name)}</span></span>`,
				)
				.join("");
			renderedBlocks.push({ type: "swatch_row", heading: "Colourways", filled: true });
			return `<section class="pv-section" data-block="swatch_row"><div class="pv-swatch-row">${dots}</div></section>`;
		}
		case "type_specimen": {
			const title = block.heading ?? "Typography";
			const read = reader.readSource(block.from);
			const entries: { role: string; family: string }[] = [];
			if (isPlainRecord(read.value)) {
				for (const [role, val] of Object.entries(read.value)) {
					if (typeof val === "string" && val.trim()) entries.push({ role, family: val.trim() });
				}
			}
			if (entries.length === 0) {
				return wrap(title, `<div class="pv-empty">No typefaces configured yet</div>`, false);
			}
			const rows = entries
				.map(
					(entry) =>
						`<div class="pv-type-row"><small>${escapeHtml(entry.role)} · ${escapeHtml(entry.family)}</small><div class="pv-type-sample" style="font-family:${escapeHtml(entry.family)},sans-serif">Aa Bb Cc — The quick brown fox jumps over the lazy dog 0123456789</div></div>`,
				)
				.join("");
			return wrap(title, `<div class="pv-type-list">${rows}</div>`, true);
		}
		case "stage_3d": {
			const read = reader.readSource(block.model);
			const obj = isPlainRecord(read.value) ? read.value : null;
			const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
			if (obj && typeof obj.model === "string" && obj.model.trim()) {
				const glbName = obj.model.trim();
				const glbPath = resolveStageGlbPath(snapshot.folderRoot, block.model, glbName);
				const known = glbPath ? snapshot.knownBinaries?.[glbPath] : undefined;
				const rel = glbPath?.startsWith(rootPrefix) ? glbPath.slice(rootPrefix.length) : undefined;
				const glbUrl =
					(glbPath ? previewCtx.assetUrls?.[glbPath] : undefined) ??
					(known?.inCompanyMount && rel ? `/company-asset/${encodeURI(rel)}` : undefined);
				const hasGlb = Boolean(glbUrl || (glbPath && (snapshot.binaries[glbPath] || known)));
				if (!hasGlb) {
					warnings.push(`Stage 3D references "${glbName}" which has not been staged yet.`);
					return wrap("3D Model", `<div class="pv-empty">Missing 3D model: ${escapeHtml(glbName)}</div>`, false);
				}
				const view = isPlainRecord(obj.view) ? obj.view : null;
				const yaw = typeof view?.yaw === "number" && Number.isFinite(view.yaw) ? view.yaw : 30;
				const pitch = typeof view?.pitch === "number" && Number.isFinite(view.pitch) ? view.pitch : 14;
				const parts = Array.isArray(obj.parts) ? obj.parts.length : 0;
				const tintList = Array.isArray(obj.tint)
					? obj.tint.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
					: [];
				const tintHex = previewCtx.activeTintHex ?? "";
				const metaChips = [
					escapeHtml(glbName),
					...(parts > 0 ? [`${parts} parts`] : []),
					...(tintList.length > 0 ? [`tint: ${escapeHtml(tintList.join(", "))}`] : []),
				]
					.map((label) => `<span class="pv-pill">${label}</span>`)
					.join("");
				if (glbUrl) {
					previewCtx.needsGlbScript = true;
					renderedBlocks.push({ type: "stage_3d", heading: "3D Model", filled: true });
					return `<section class="pv-section" data-block="stage_3d"><div class="pv-stage-3d" data-glb-url="${escapeHtml(glbUrl)}" data-yaw="${yaw}" data-pitch="${pitch}" data-tint="${escapeHtml(JSON.stringify(tintList))}" data-tint-hex="${escapeHtml(tintHex)}"><canvas class="pv-stage-canvas" width="760" height="360"></canvas><div class="pv-stage-meta">${metaChips}</div></div></section>`;
				}
				renderedBlocks.push({ type: "stage_3d", heading: "3D Model", filled: true });
				return `<section class="pv-section" data-block="stage_3d"><div class="pv-stage-3d"><div class="pv-art-badge">GLB · ${escapeHtml(glbName)}</div><div class="pv-stage-meta">${metaChips}</div></div></section>`;
			}
			const legacy = obj && typeof obj.kind === "string" ? obj : findLegacyModelConfig(snapshot);
			if (legacy) {
				const kind = legacy.kind === "headband" ? "headband" : "device";
				const tint = previewCtx.activeTintHex || "#b8b0d8";
				const dims = typeof legacy.dimensions === "string" ? legacy.dimensions : "";
				const layers = Array.isArray(legacy.layers)
					? legacy.layers.filter((item): item is string => typeof item === "string").slice(0, 5)
					: [];
				warnings.push("Stage 3D is using a stand-in preview; build and stage a real .glb 3D model for stage_3d.");
				const standInSvg =
					kind === "headband"
						? `<svg viewBox="0 0 760 280" class="pv-svg"><ellipse cx="380" cy="212" rx="180" ry="26" fill="rgba(20,20,24,0.09)"/><ellipse cx="380" cy="136" rx="170" ry="62" fill="none" stroke="${escapeHtml(tint)}" stroke-width="36"/><ellipse cx="380" cy="136" rx="154" ry="52" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="6"/></svg>`
						: `<svg viewBox="0 0 760 280" class="pv-svg"><ellipse cx="380" cy="218" rx="150" ry="22" fill="rgba(20,20,24,0.09)"/><rect x="230" y="76" width="300" height="118" rx="22" fill="${escapeHtml(tint)}" stroke="rgba(20,20,24,0.16)" stroke-width="2"/></svg>`;
				const meta = ["Stand-in preview", ...(dims ? [dims] : []), ...layers]
					.map((item) => `<span class="pv-pill">${escapeHtml(item)}</span>`)
					.join("");
				renderedBlocks.push({ type: "stage_3d", heading: "3D Model", filled: true });
				return `<section class="pv-section" data-block="stage_3d"><div class="pv-stage-3d">${standInSvg}<div class="pv-stage-meta">${meta}</div></div></section>`;
			}
			warnings.push("Stage 3D block has no object.json or .glb 3D model yet.");
			return wrap(
				"3D Model",
				`<div class="pv-empty">Empty 3D stage — stage a .glb model and object.json</div>`,
				false,
			);
		}
		default:
			return wrap("Block", `<div class="pv-empty">Unknown block</div>`, false);
	}
}

export function renderStudioPreviewHtml(options: {
	readonly snapshot: StudioInspectSnapshot;
	readonly tabId?: string;
	readonly theme: InspectSurfaceTheme;
	readonly assetUrls?: Readonly<Record<string, string>>;
}): RenderedStudioPreview {
	const { snapshot, theme } = options;
	const layoutPath = snapshot.folderRoot ? `${snapshot.folderRoot}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH;
	const layoutText = snapshot.files[layoutPath];
	const read = layoutText === undefined ? undefined : readSurfaceLayout(layoutText);
	const layout: SurfaceLayoutRead = read && "layout" in read ? read.layout : starterSurfaceLayout(snapshot.starter);
	const tabs = layout.tabs.map((tab) => ({ id: tab.id, title: tab.title }));
	let activeTab: SurfaceTab<SurfaceReadNode> | undefined;
	if (options.tabId) {
		activeTab = layout.tabs.find((tab) => tab.id === options.tabId);
		if (!activeTab) {
			throw new CloudToolArgumentRefusal(
				`Tab "${options.tabId}" was not found. Available tabs: ${tabs.map((t) => t.id).join(", ")}`,
			);
		}
	} else {
		activeTab = layout.tabs[0]!;
	}

	const dark = theme === "dark";
	const reader = createSnapshotReader(snapshot);
	const renderedBlocks: { readonly type: string; readonly heading: string; readonly filled: boolean }[] = [];
	const warnings: string[] = [];
	const inlineBudget = { imageUsed: 0, svgUsed: 0, moduleUsed: 0 };
	let activeTintHex: string | undefined;
	for (const node of activeTab.blocks) {
		const children = node.type === "row" ? node.blocks : [node];
		for (const child of children) {
			if (child.type === "swatch_row" && !activeTintHex) {
				const swatches = extractColorSwatches(reader.readSource(child.from).value);
				if (swatches[0]?.value) activeTintHex = swatches[0].value;
			}
		}
	}
	const previewCtx: PreviewRenderContext = {
		...(options.assetUrls ? { assetUrls: options.assetUrls } : {}),
		...(activeTintHex ? { activeTintHex } : {}),
		needsGlbScript: false,
	};
	if (read && "problem" in read) {
		warnings.push(`layout.json parse warning (using starter fallback): ${read.problem}`);
	}

	const nodesHtml = activeTab.blocks
		.map((node) => {
			if (node.type === "row") {
				const cells = node.blocks
					.map(
						(child) =>
							`<div class="pv-row-cell">${renderBlockHtml(child, snapshot, reader, dark, inlineBudget, renderedBlocks, warnings, previewCtx)}</div>`,
					)
					.join("");
				return `<div class="pv-row" style="--cols:${node.blocks.length}">${cells}</div>`;
			}
			return renderBlockHtml(node, snapshot, reader, dark, inlineBudget, renderedBlocks, warnings, previewCtx);
		})
		.join("\n");

	const tokensCss = snapshot.files[IDENTITY_TOKENS_CSS_PATH];
	const tabBar =
		tabs.length > 1
			? `<nav class="pv-tabs">${tabs.map((t) => `<span class="pv-tab${t.id === activeTab!.id ? " is-on" : ""}">${escapeHtml(t.title)}</span>`).join("")}</nav>`
			: "";

	const html = `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(snapshot.surfaceTitle)} — ${escapeHtml(activeTab.title)}</title>
${tokensCss ? `<style>${sanitizeInlineCss(tokensCss)}</style>` : ""}
<style>
:root{--bg:${dark ? "#141514" : "#faf9f6"};--pane:${dark ? "#1d1f1e" : "#ffffff"};--text:${dark ? "#f4f3f0" : "#161615"};--muted:${dark ? "#b8b7b2" : "#686866"};--border:${dark ? "rgba(255,255,255,0.1)" : "rgba(18,18,17,0.09)"};--accent:var(--studio-accent,${dark ? "#e5835c" : "#d76f45"});--good:${dark ? "#5ed6a9" : "#0f7a55"};--warn:${dark ? "#f2c35d" : "#9a6300"};--bad:${dark ? "#ff9084" : "#b33a2f"};--font:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.5;-webkit-font-smoothing:antialiased}
.pv-page{max-width:1080px;margin:0 auto;padding:28px 28px 48px;display:grid;gap:24px}
.pv-tabs{display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid var(--border);padding-bottom:12px}
.pv-tab{padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;color:var(--muted)}
.pv-tab.is-on{background:var(--text);color:var(--bg)}
.pv-hero h1{margin:0;font-size:32px;letter-spacing:-0.02em;line-height:1.15}
.pv-hero-line{margin:8px 0 0;color:var(--muted);font-size:16px}
.pv-section{display:grid;gap:12px;min-width:0}
.pv-section-head h2{margin:0;font-size:17px;font-weight:680;letter-spacing:-0.01em}
.pv-sub,.pv-caption,.pv-wedge{margin:0;color:var(--muted);font-size:13.5px}
.pv-row{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:18px;align-items:start}
.pv-row-cell{min-width:0}
.pv-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.pv-fact{padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:var(--pane)}
.pv-fact-val{font-size:22px;font-weight:700;letter-spacing:-0.02em}
.pv-fact-lbl{margin-top:4px;font-size:12px;color:var(--muted)}
.pv-chart-card{border:1px solid var(--border);border-radius:16px;background:var(--pane);padding:12px}
.pv-svg{display:block;width:100%;height:auto}
.pv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.pv-card{padding:16px;border:1px solid var(--border);border-radius:16px;background:var(--pane);display:grid;gap:8px;align-content:start}
.pv-card.is-accent{border-color:var(--accent)}
.pv-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.pv-card p{margin:0;font-size:13px;color:var(--muted)}
.pv-badge{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:680;background:var(--border);color:var(--text)}
.pv-badge.is-accent{background:var(--accent);color:#fff}
.pv-badge.is-fatal{background:var(--bad);color:#fff}
.pv-badge.is-high{background:var(--warn);color:#fff}
.pv-pills{display:flex;flex-wrap:wrap;gap:6px}
.pv-pill{padding:5px 11px;border-radius:999px;border:1px solid var(--border);background:var(--pane);font-size:12px;font-weight:600}
.pv-pill.is-accent{border-color:var(--accent);color:var(--accent)}
.pv-list,.pv-specs{display:grid;border-top:1px solid var(--border)}
.pv-hyp-row,.pv-spec-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 4px;border-bottom:1px solid var(--border);font-size:13px}
.pv-muted{color:var(--muted);font-size:12px}
.pv-swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.pv-swatch{display:grid;gap:4px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--pane);font-size:12px}
.pv-swatch-chip{height:44px;border-radius:8px;border:1px solid var(--border)}
.pv-swatch-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.pv-dot-chip{display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 8px;border-radius:999px;border:1px solid var(--border);background:var(--pane);font-size:12.5px;font-weight:600}
.pv-dot-chip.is-on{border-color:var(--text)}
.pv-dot{width:18px;height:18px;border-radius:999px;border:1px solid rgba(0,0,0,0.16);display:inline-block}
.pv-type-list{display:grid;gap:12px}
.pv-type-row{padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:var(--pane);display:grid;gap:6px}
.pv-type-row small{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:0.04em}
.pv-type-sample{font-size:20px;line-height:1.3}
.pv-stage-3d{border:1px solid var(--border);border-radius:20px;background:radial-gradient(circle at 50% 42%,var(--pane) 0%,var(--bg) 100%);padding:16px;display:grid;gap:12px;justify-items:center}
.pv-stage-canvas{display:block;width:100%;max-width:760px;height:auto}
.pv-stage-meta{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.pv-marks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.pv-mark-ground{display:grid;place-items:center;min-height:140px;padding:20px;border-radius:16px;border:1px solid var(--border)}
.pv-mark-ground.is-light{background:#ffffff;color:#111}
.pv-mark-ground.is-dark{background:#111211;color:#fff}
.pv-mark-svg svg,.pv-mark-img{max-width:180px;max-height:96px;display:block}
.pv-table-wrap{overflow:hidden;border:1px solid var(--border);border-radius:14px;background:var(--pane)}
.pv-table{width:100%;border-collapse:collapse;font-size:12.5px}
.pv-table th,.pv-table td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border)}
.pv-table th{color:var(--muted);font-weight:650}
.pv-art-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.pv-art-card{margin:0;border:1px solid var(--border);border-radius:14px;background:var(--pane);overflow:hidden;display:grid}
.pv-art-card img,.pv-art-svg svg{display:block;width:100%;max-height:240px;object-fit:contain;background:var(--bg)}
.pv-art-card figcaption{padding:8px 12px;font-size:12px;color:var(--muted);border-top:1px solid var(--border)}
.pv-art-badge{display:grid;place-items:center;height:110px;font-weight:700;color:var(--muted);font-size:18px}
.pv-module{width:100%;border:1px solid var(--border);border-radius:16px;background:var(--pane)}
.pv-empty{padding:18px;border:1px dashed var(--border);border-radius:14px;color:var(--muted);font-size:13px}
@media (max-width:640px){.pv-page{padding:18px 14px 36px}.pv-row{grid-template-columns:minmax(0,1fr)}}
</style>
</head>
<body>
<main class="pv-page">
${tabBar}
${nodesHtml}
</main>
${previewCtx.needsGlbScript ? GLB_PREVIEW_SCRIPT : ""}
</body>
</html>`;

	return {
		html,
		activeTab: { id: activeTab.id, title: activeTab.title },
		tabs,
		renderedBlocks,
		warnings,
	};
}

async function runMachineStep(options: {
	readonly machine: StudioChatGptVoiceMachine;
	readonly key: string;
	readonly command: string;
	readonly timeoutMs: number;
	readonly context: CloudToolContext;
	readonly pollMs: number;
}): Promise<{ readonly exitCode: number | null; readonly state: string; readonly output: string }> {
	const { machine, key, command, timeoutMs, context, pollMs } = options;
	const { scope, operations, gateway } = machine;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		) {
			throw new Error("Coding command result differs");
		}
		return receipt;
	};

	const cancelOnAbort = async (commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CANCEL_ON_ABORT_MS);
		timer.unref?.();
		try {
			await gateway.cancel(scope, commandId, controller.signal);
		} catch {
			return;
		} finally {
			clearTimeout(timer);
		}
	};

	const childObservation = context.observation?.child("coding_run_command");
	let startedRunningId: string | null = null;
	let startContent: { kind: string; value?: unknown };
	try {
		startContent = await operations.execute({
			operation: {
				tool: "coding_run_command",
				toolVersion: "v1",
				logicalOperationKey: key,
				arguments: { operationKey: key, command, timeoutMs },
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, effect) => {
				const started = checkedReceipt(
					await gateway.start(
						scope,
						{
							commandId: effect.receiptId,
							inputSha256: effect.inputSha256,
							command,
							timeoutMs,
						},
						effect.signal,
					),
					effect.receiptId,
					effect.inputSha256,
				);
				if (started.state === "running") startedRunningId = started.commandId;
				return { content: { kind: "json", value: started as unknown as JsonValue } };
			},
			signal: context.signal,
			...(childObservation ? { observation: childObservation } : {}),
		});
	} catch (error) {
		if (context.signal.aborted && startedRunningId !== null) await cancelOnAbort(startedRunningId);
		throw error;
	}
	if (startContent.kind !== "json") throw new Error("Coding command result differs");
	let current = parseCloudCodingCommandReceipt(startContent.value);

	const readReceipt = async (commandId: string, offset: number, limit: number): Promise<CloudCodingCommandReceipt> => {
		const parsed = parseCloudCodingCommandRead({ commandId, offset, limit });
		return checkedReceipt(
			await cloudToolRequest((requestSignal) => gateway.read(scope, parsed, requestSignal), context.signal),
			commandId,
		);
	};

	const deadline = Date.now() + timeoutMs + 5_000;
	let delay = pollMs;
	while (current.state === "running") {
		if (context.signal.aborted) {
			await cancelOnAbort(current.commandId);
			context.signal.throwIfAborted();
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			await cancelOnAbort(current.commandId);
			throw new CloudToolRefusal("INSPECT_SURFACE_TIMEOUT: rendering the Studio screenshot timed out.");
		}
		try {
			await cloudControlPause(Math.min(delay, remaining), context.signal);
		} catch (error) {
			if (context.signal.aborted) await cancelOnAbort(current.commandId);
			throw error;
		}
		delay = Math.min(1000, Math.max(pollMs, Math.round(delay * 1.5)));
		current = await readReceipt(current.commandId, current.log.totalBytes, 4);
	}

	if (
		current.log.limitReached ||
		current.log.gapBytes !== undefined ||
		current.log.totalBytes > MAX_BASE64_OUTPUT_BYTES
	) {
		throw new CloudToolRefusal("INSPECT_SURFACE_TOO_LARGE: screenshot exceeded the transfer bound.");
	}
	const chunks: string[] = [];
	let cursor = 0;
	if (current.log.offset === 0 && current.output.length > 0) {
		chunks.push(current.output);
		cursor = current.log.nextOffset;
	}
	const total = current.log.totalBytes;
	while (cursor < total) {
		context.signal.throwIfAborted();
		const page = await readReceipt(
			current.commandId,
			cursor,
			Math.max(4, Math.min(CLOUD_CODING_COMMAND_PAGE_BYTES, total - cursor)),
		);
		if (page.log.offset !== cursor || page.log.nextOffset <= cursor) break;
		chunks.push(page.output);
		cursor = page.log.nextOffset;
	}
	return { exitCode: current.exitCode, state: current.state, output: chunks.join("") };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function prepareInspectAssets(
	snapshot: StudioInspectSnapshot,
	tabId: string | undefined,
	signal: AbortSignal,
): Promise<{
	readonly assetUrls: Record<string, string>;
	readonly bundle: {
		readonly files: Record<string, { readonly b64?: string; readonly text?: string }>;
		readonly local: Record<string, { readonly src: string; readonly sha256: string }>;
	};
}> {
	const assetUrls: Record<string, string> = {};
	const bundleFiles: Record<string, { readonly b64?: string; readonly text?: string }> = {};
	const bundleLocal: Record<string, { readonly src: string; readonly sha256: string }> = {};
	const rootPrefix = snapshot.folderRoot ? `${snapshot.folderRoot}/` : "";
	const relOf = (fullPath: string): string | null => {
		if (!rootPrefix) return fullPath.replace(/^\/+/, "") || null;
		return fullPath.startsWith(rootPrefix) ? fullPath.slice(rootPrefix.length) : null;
	};

	for (const [fullPath, local] of Object.entries(snapshot.localAssetPaths ?? {})) {
		const rel = relOf(fullPath);
		if (!rel) continue;
		bundleLocal[rel] = { src: local.sourcePath, sha256: local.sha256 };
		assetUrls[fullPath] = `/staged-asset/${encodeURI(rel)}`;
	}
	for (const [fullPath, meta] of Object.entries(snapshot.knownBinaries ?? {})) {
		if (assetUrls[fullPath] || !meta.inCompanyMount) continue;
		const rel = relOf(fullPath);
		if (!rel) continue;
		assetUrls[fullPath] = `/company-asset/${encodeURI(rel)}`;
	}

	let bundleBytes = 0;
	let previewImages = 0;
	const tryBundleBinary = async (
		fullPath: string,
		entry: { readonly bytes: Uint8Array; readonly mediaType: string },
		setUrl: boolean,
	): Promise<void> => {
		if (bundleBytes >= MAX_STAGED_BUNDLE_BYTES) return;
		const rel = relOf(fullPath);
		if (!rel || bundleFiles[rel]) return;
		if (entry.mediaType.startsWith("image/") && previewImages < MAX_STAGED_PREVIEW_IMAGES) {
			let pngBytes: Uint8Array | null = null;
			if (entry.bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
				pngBytes = entry.bytes;
			} else {
				try {
					const resized = await oneImageAtATime(signal, async () =>
						folderImageView(entry.bytes, {
							maxWidth: 480,
							maxHeight: 360,
							maxBytes: MAX_STAGED_PREVIEW_IMAGE_BYTES,
						}),
					);
					pngBytes = resized.png;
				} catch {
					pngBytes = null;
				}
			}
			if (pngBytes && bundleBytes + pngBytes.byteLength <= MAX_STAGED_BUNDLE_BYTES) {
				bundleFiles[rel] = { b64: Buffer.from(pngBytes).toString("base64") };
				bundleBytes += pngBytes.byteLength;
				previewImages += 1;
				if (setUrl) assetUrls[fullPath] = `/staged/${encodeURI(rel)}`;
			}
		} else if (
			entry.mediaType === "model/gltf-binary" &&
			entry.bytes.byteLength <= MAX_STAGED_GLB_UPLOAD_BYTES &&
			bundleBytes + entry.bytes.byteLength <= MAX_STAGED_BUNDLE_BYTES
		) {
			bundleFiles[rel] = { b64: Buffer.from(entry.bytes).toString("base64") };
			bundleBytes += entry.bytes.byteLength;
			if (setUrl) assetUrls[fullPath] = `/staged/${encodeURI(rel)}`;
		}
	};
	for (const [fullPath, entry] of Object.entries(snapshot.binaries)) {
		if (assetUrls[fullPath]) continue;
		await tryBundleBinary(fullPath, entry, true);
	}
	for (const [fullPath, entry] of Object.entries(snapshot.binaries)) {
		if (!snapshot.localAssetPaths?.[fullPath]) continue;
		await tryBundleBinary(fullPath, entry, false);
	}

	const layoutPath = snapshot.folderRoot ? `${snapshot.folderRoot}/${SURFACE_LAYOUT_PATH}` : SURFACE_LAYOUT_PATH;
	const layoutText = snapshot.files[layoutPath];
	const read = layoutText === undefined ? undefined : readSurfaceLayout(layoutText);
	const layout: SurfaceLayoutRead = read && "layout" in read ? read.layout : starterSurfaceLayout(snapshot.starter);
	const activeTab = (tabId ? layout.tabs.find((tab) => tab.id === tabId) : layout.tabs[0]) ?? layout.tabs[0];
	if (activeTab) {
		const blocks = activeTab.blocks.flatMap((node) => (node.type === "row" ? node.blocks : [node]));
		for (const block of blocks) {
			if (block.type !== "module") continue;
			const folder = resolveCompanyPath(snapshot.folderRoot, block.from.replace(/\/+$/, ""));
			if (!folder) continue;
			const prefix = `${folder}/`;
			const indexPath = `${prefix}index.html`;
			const indexRel = relOf(indexPath);
			if (!indexRel || snapshot.files[indexPath] === undefined) continue;
			let addedIndex = false;
			for (const [fullPath, text] of Object.entries(snapshot.files)) {
				if (!fullPath.startsWith(prefix)) continue;
				const rel = relOf(fullPath);
				if (!rel) continue;
				const size = Buffer.byteLength(text, "utf8");
				if (bundleBytes + size > MAX_STAGED_BUNDLE_BYTES) continue;
				bundleFiles[rel] = { text };
				bundleBytes += size;
				if (fullPath === indexPath) addedIndex = true;
			}
			if (addedIndex) {
				assetUrls[indexPath] = `/staged/${encodeURI(indexRel)}`;
			}
		}
	}

	return { assetUrls, bundle: { files: bundleFiles, local: bundleLocal } };
}

export function createInspectSurfaceTool(options: InspectSurfaceToolOptions): CloudNativeTool {
	const pollMs = options.pollMs ?? 150;
	const parseArgs = (
		value: unknown,
	): {
		readonly tab?: string;
		readonly theme: InspectSurfaceTheme;
		readonly viewport: InspectSurfaceViewport;
		readonly fullPage: boolean;
		readonly scrollY: number;
		readonly changeId?: string;
	} => {
		const allowed = ["tab", "theme", "viewport", "fullPage", "scrollY", "changeId"];
		if (
			value !== undefined &&
			value !== null &&
			(!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)))
		) {
			throw new CloudToolArgumentRefusal(
				"inspect_surface accepts optional tab, theme, viewport, fullPage, scrollY, and changeId",
			);
		}
		const rec = isPlainRecord(value) ? value : {};
		const tab =
			rec.tab === undefined
				? undefined
				: typeof rec.tab === "string" && rec.tab.trim().length > 0 && rec.tab.trim().length <= 64
					? rec.tab.trim()
					: null;
		if (tab === null) {
			throw new CloudToolArgumentRefusal("tab must be a non-empty tab ID string");
		}
		const theme =
			rec.theme === undefined ? "light" : rec.theme === "light" || rec.theme === "dark" ? rec.theme : null;
		if (theme === null) {
			throw new CloudToolArgumentRefusal('theme must be "light" or "dark"');
		}
		const viewport =
			rec.viewport === undefined
				? "desktop"
				: rec.viewport === "desktop" || rec.viewport === "mobile"
					? rec.viewport
					: null;
		if (viewport === null) {
			throw new CloudToolArgumentRefusal('viewport must be "desktop" or "mobile"');
		}
		const fullPage = rec.fullPage === undefined ? false : typeof rec.fullPage === "boolean" ? rec.fullPage : null;
		if (fullPage === null) {
			throw new CloudToolArgumentRefusal("fullPage must be a boolean");
		}
		const scrollY =
			rec.scrollY === undefined
				? 0
				: typeof rec.scrollY === "number" &&
						Number.isInteger(rec.scrollY) &&
						rec.scrollY >= 0 &&
						rec.scrollY <= MAX_SCROLL_Y
					? rec.scrollY
					: null;
		if (scrollY === null) {
			throw new CloudToolArgumentRefusal(`scrollY must be an integer between 0 and ${MAX_SCROLL_Y}`);
		}
		const changeId =
			rec.changeId === undefined
				? undefined
				: typeof rec.changeId === "string" && isUuid(rec.changeId.trim())
					? rec.changeId.trim().toLowerCase()
					: null;
		if (changeId === null) {
			throw new CloudToolArgumentRefusal("changeId must be a valid UUID");
		}
		return {
			...(tab ? { tab } : {}),
			theme,
			viewport,
			fullPage,
			scrollY,
			...(changeId ? { changeId } : {}),
		};
	};

	return {
		name: "inspect_surface" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		images: true,
		description: [
			"Render this Studio surface (including active Preview changes, 3D GLB stages, colourway dots, visuals, charts, and live modules) in headless Chromium and return a crisp 1:1 PNG screenshot inline so you can visually audit layout, imagery, 3D geometry, contrast, spacing, and broken images.",
			"Defaults to a readable viewport screenshot (1280x800 desktop or 390x844 mobile); pass scrollY to inspect lower bands, fullPage: true for up to 1800px, or changeId to inspect a specific option-group variant.",
		].join("\n"),
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				tab: {
					type: "string",
					maxLength: 64,
					description: "Optional tab ID to render (defaults to the first tab).",
				},
				theme: {
					type: "string",
					enum: ["light", "dark"],
					description: "Color theme to render (defaults to light).",
				},
				viewport: {
					type: "string",
					enum: ["desktop", "mobile"],
					description: "Viewport preset: desktop (1280x800) or mobile (390x844). Defaults to desktop.",
				},
				fullPage: {
					type: "boolean",
					description: "Capture up to 1800px tall (true) or crisp single viewport at scrollY (false, default).",
				},
				scrollY: {
					type: "integer",
					minimum: 0,
					maximum: MAX_SCROLL_Y,
					description: "Vertical scroll offset in CSS px when fullPage is false (default 0).",
				},
				changeId: {
					type: "string",
					description: "Optional staged change UUID to overlay (useful when inspecting an optionGroup variant).",
				},
			},
		},
		parseArguments(value) {
			const args = parseArgs(value);
			return {
				...(args.tab ? { tab: args.tab } : {}),
				theme: args.theme,
				viewport: args.viewport,
				fullPage: args.fullPage,
				scrollY: args.scrollY,
				...(args.changeId ? { changeId: args.changeId } : {}),
			};
		},
		async execute(rawArgs, context: CloudToolContext) {
			const args = parseArgs(rawArgs);
			const snapshot = await options.loadSnapshot(
				context.signal,
				args.changeId ? { changeId: args.changeId } : undefined,
			);
			const prepared = await prepareInspectAssets(snapshot, args.tab, context.signal);
			const rendered = renderStudioPreviewHtml({
				snapshot,
				...(args.tab ? { tabId: args.tab } : {}),
				theme: args.theme,
				assetUrls: prepared.assetUrls,
			});
			const htmlBytes = Buffer.from(rendered.html, "utf8");
			if (htmlBytes.byteLength > MAX_PREVIEW_HTML_BYTES) {
				throw new CloudToolRefusal("INSPECT_SURFACE_TOO_LARGE: rendered preview exceeded the size limit.");
			}
			const gzB64 = gzipSync(htmlBytes).toString("base64");
			const hasStagedBundle =
				Object.keys(prepared.bundle.files).length > 0 || Object.keys(prepared.bundle.local).length > 0;
			const stagedGzB64 = hasStagedBundle
				? gzipSync(Buffer.from(JSON.stringify(prepared.bundle), "utf8")).toString("base64")
				: "";
			const chunkCount =
				Math.ceil(gzB64.length / UPLOAD_CHUNK_BYTES) +
				(stagedGzB64 ? Math.ceil(stagedGzB64.length / UPLOAD_CHUNK_BYTES) : 0);
			if (chunkCount > MAX_UPLOAD_CHUNKS) {
				throw new CloudToolRefusal("INSPECT_SURFACE_TOO_LARGE: compressed preview exceeded the upload bound.");
			}

			const tag = createHash("sha256")
				.update(
					`${options.machine.identity.runId}:${context.callId}:${rendered.activeTab.id}:${args.theme}:${args.viewport}:${args.scrollY}:${args.changeId ?? ""}`,
				)
				.digest("hex")
				.slice(0, 20);
			const work = `${WORK_ROOT}-${tag}`;

			const init = await runMachineStep({
				machine: options.machine,
				key: `studio-inspect:${tag}:init`,
				command: `rm -rf ${work} && mkdir -p ${work}/site && cat > ${work}/capture.cjs <<'${SCRIPT_END}'\n${CAPTURE_SCRIPT_CJS}\n${SCRIPT_END}\n: > ${work}/site/index.html.gz.b64${stagedGzB64 ? ` && : > ${work}/site/staged.json.gz.b64` : ""}`,
				timeoutMs: SETUP_TIMEOUT_MS,
				context,
				pollMs,
			});
			if (init.state !== "succeeded") {
				throw new CloudToolRefusal(
					`INSPECT_SURFACE_UNAVAILABLE: could not prepare Studio preview on the coding machine (exit ${init.exitCode ?? init.state}).`,
				);
			}

			for (let offset = 0, part = 0; offset < gzB64.length; offset += UPLOAD_CHUNK_BYTES, part += 1) {
				const slice = gzB64.slice(offset, offset + UPLOAD_CHUNK_BYTES);
				const step = await runMachineStep({
					machine: options.machine,
					key: `studio-inspect:${tag}:chunk:${part}`,
					command: `printf '%s' '${slice}' >> ${work}/site/index.html.gz.b64`,
					timeoutMs: SETUP_TIMEOUT_MS,
					context,
					pollMs,
				});
				if (step.state !== "succeeded") {
					throw new CloudToolRefusal(
						`INSPECT_SURFACE_UNAVAILABLE: could not upload Studio preview chunk (exit ${step.exitCode ?? step.state}).`,
					);
				}
			}

			for (let offset = 0, part = 0; offset < stagedGzB64.length; offset += UPLOAD_CHUNK_BYTES, part += 1) {
				const slice = stagedGzB64.slice(offset, offset + UPLOAD_CHUNK_BYTES);
				const step = await runMachineStep({
					machine: options.machine,
					key: `studio-inspect:${tag}:staged:${part}`,
					command: `printf '%s' '${slice}' >> ${work}/site/staged.json.gz.b64`,
					timeoutMs: SETUP_TIMEOUT_MS,
					context,
					pollMs,
				});
				if (step.state !== "succeeded") {
					throw new CloudToolRefusal(
						`INSPECT_SURFACE_UNAVAILABLE: could not upload Studio asset chunk (exit ${step.exitCode ?? step.state}).`,
					);
				}
			}

			const dims =
				args.viewport === "mobile"
					? { width: 390, height: 844, mobile: "1" }
					: { width: 1280, height: 800, mobile: "0" };
			const folderArg = snapshot.folderRoot ? shellQuote(snapshot.folderRoot) : "''";
			const capture = await runMachineStep({
				machine: options.machine,
				key: `studio-inspect:${tag}:capture`,
				command: `if [ -x /usr/bin/node ]; then NODE_BIN=/usr/bin/node; else NODE_BIN=node; fi; NODE_OPTIONS= "$NODE_BIN" ${work}/capture.cjs ${work} ${dims.width} ${dims.height} ${dims.mobile} ${args.fullPage ? "1" : "0"} ${args.scrollY} ${folderArg} 2>/dev/null`,
				timeoutMs: CAPTURE_TIMEOUT_MS,
				context,
				pollMs,
			});

			if (capture.state !== "succeeded") {
				throw new CloudToolRefusal(
					`INSPECT_SURFACE_UNAVAILABLE: could not render Studio screenshot on the coding machine (exit ${capture.exitCode ?? capture.state}).`,
				);
			}
			let outputText = capture.output.trim();
			let scrollHeight = dims.height;
			let effectiveScrollY = args.scrollY;
			const runtimeWarnings: string[] = [];
			if (outputText.startsWith("QORPERA_META:")) {
				const nl = outputText.indexOf("\n");
				if (nl > 0) {
					try {
						const meta = JSON.parse(outputText.slice("QORPERA_META:".length, nl)) as Record<string, unknown>;
						if (typeof meta.scrollHeight === "number" && Number.isFinite(meta.scrollHeight)) {
							scrollHeight = Math.max(dims.height, Math.round(meta.scrollHeight));
						}
						if (typeof meta.scrollY === "number" && Number.isFinite(meta.scrollY)) {
							effectiveScrollY = Math.max(0, Math.round(meta.scrollY));
						}
						if (Array.isArray(meta.brokenImages) && meta.brokenImages.length > 0) {
							const listed = meta.brokenImages.filter((item): item is string => typeof item === "string");
							if (listed.length > 0) {
								runtimeWarnings.push(`Broken images detected (${listed.length}): ${listed.join(", ")}`);
							}
						}
						if (Array.isArray(meta.stage3dErrors) && meta.stage3dErrors.length > 0) {
							for (const err of meta.stage3dErrors) {
								if (typeof err === "string") runtimeWarnings.push(`3D stage render failed: ${err}`);
							}
						}
						if (Array.isArray(meta.staleLocalAssets) && meta.staleLocalAssets.length > 0) {
							const listed = meta.staleLocalAssets.filter((item): item is string => typeof item === "string");
							if (listed.length > 0) {
								runtimeWarnings.push(
									`Staged files changed on disk since staging (restage with stage_surface_artifact): ${listed.join(", ")}`,
								);
							}
						}
					} catch {}
					outputText = outputText.slice(nl + 1);
				}
			}
			const rawPng = decodeInspectImageOutput(outputText);
			if (!rawPng) {
				throw new CloudToolRefusal("INSPECT_SURFACE_UNREADABLE: rendered screenshot payload was invalid or empty.");
			}

			let view: FolderImageView;
			try {
				view = await oneImageAtATime(context.signal, async () => folderImageView(rawPng));
			} catch (error) {
				if (!(error instanceof FolderImageRefusal)) throw error;
				throw new CloudToolRefusal(`INSPECT_SURFACE_UNREADABLE: ${error.message}.`);
			}

			const hasMoreBelow = !args.fullPage && effectiveScrollY + dims.height < scrollHeight;
			const answer: Record<string, JsonValue> = {
				schema: STUDIO_INSPECT_SURFACE_SCHEMA,
				ok: true,
				kind: "surface_screenshot",
				tab: rendered.activeTab.id,
				tabTitle: rendered.activeTab.title,
				tabs: rendered.tabs.map((tab) => ({ id: tab.id, title: tab.title })),
				theme: args.theme,
				viewport: args.viewport,
				fullPage: args.fullPage,
				scrollY: effectiveScrollY,
				scrollHeight,
				hasMoreBelow,
				width: view.width,
				height: view.height,
				shownWidth: view.shownWidth,
				shownHeight: view.shownHeight,
				imageSha256: view.sha256,
				renderedBlocks: rendered.renderedBlocks.map((b) => ({
					type: b.type,
					heading: b.heading,
					filled: b.filled,
				})),
				warnings: [...rendered.warnings, ...runtimeWarnings],
			};
			return {
				kind: "json",
				value: answer,
				image: { png: view.png, sha256: view.sha256 },
			};
		},
	};
}
