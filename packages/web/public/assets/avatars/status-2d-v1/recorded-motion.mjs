import { recordedClips } from './recorded-clips.mjs';
import { workingPalette } from './working-palette.mjs';

const sheets={};
let source, eyeMask, soft, colors, front;
// Prepared frames by state and frame, least recently used first, each cropped to what it holds:
// the eyes' raster and the two stroke layers, each with a clear pixel around it so a stretched
// draw smooths its edge as the whole 160px layer did. A frame's preparation never changes and
// the clips repeat (Working is one 10.8 s loop), so after a first pass figures no longer decode
// frames at all. About 10 MB for every frame of every clip; the oldest go past BUDGET bytes.
const slots=new Map(), BUDGET=32*1024*1024;
let current, held=0;
// Full-frame arrays that prepare() fills from small read-backs (see readBox).
const pixelsAt=new Uint8ClampedArray(160*160*4), coreAt=new Uint8ClampedArray(160*160*4), expandedAt=new Uint8ClampedArray(160*160*4);
// Copies the box [x0,y0,x1,y1] of ctx's canvas into `into` (a 160x160 RGBA array) at its place,
// leaving the rest zero. prepare() reads only the eyes' and the strokes' boxes, about a tenth of
// the frame, so read-backs (the slowest step, Safari's above all) shrink while every value used
// stays the same.
function readBox(ctx,box,into) {
  into.fill(0);
  if(!box)return into;
  const [x0,y0,x1,y1]=box,w=x1-x0,h=y1-y0;
  if(w<=0||h<=0)return into;
  const d=ctx.getImageData(x0,y0,w,h).data;
  for(let row=0;row<h;row++)into.set(d.subarray(row*w*4,(row+1)*w*4),((y0+row)*160+x0)*4);
  return into;
}
const clampBox=(box)=>[Math.max(0,box[0]),Math.max(0,box[1]),Math.min(160,box[2]),Math.min(160,box[3])];
const loading = new Map();
// A canvas holding the box [x0,y0,x1,y1] of a 160px layer: `from` is the layer's ImageData, or
// its canvas (read back at once), or null. Never drawn from a shared canvas: WebKit may run such a
// copy only after later calls have changed the shared canvas (the next frame's preparation).
function crop(from,box) {
  if(!box)return null;
  const [x0,y0,x1,y1]=box,w=x1-x0,h=y1-y0,canvas=document.createElement('canvas');
  canvas.width=w;canvas.height=h;
  const pixels=from instanceof ImageData?from:from.getContext('2d').getImageData(x0,y0,w,h);
  canvas.getContext('2d').putImageData(pixels,from instanceof ImageData?-x0:0,from instanceof ImageData?-y0:0,from instanceof ImageData?x0:0,from instanceof ImageData?y0:0,w,h);
  return {canvas,x:x0,y:y0};
}

export function loadRecordedMotion(state, base) {
  if (!recordedClips[state]) return Promise.resolve();
  if (loading.has(state)) return loading.get(state);
  if (!source) {
    [source, eyeMask, soft, colors, front] = Array.from({length:5}, () => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=160;return canvas;
    });
    // prepare() reads source and eyeMask back every new frame: keep them in memory rather than on
    // the GPU, where each getImageData is a stall (Safari's GPU process most of all).
    // colors and front are read back once per new frame too, but stay as they were: in WebKit a
    // willReadFrequently canvas draws with another backend, whose destination-in leaves strokes
    // outside the front layer's circle.
    for (const canvas of [source, eyeMask]) canvas.getContext('2d', {willReadFrequently:true});
  }
  const run=Promise.all(recordedClips[state].atlases.map(async file=>{
    const image=new Image();image.src=new URL(file,base);await image.decode();return image;
  })).then(images=>{sheets[state]=images;}).catch(error=>{loading.delete(state);throw error;});
  loading.set(state,run);
  return run;
}

function prepare(state,frame) {
  const key=state+':'+frame;
  if(current?.key===key)return;
  const hit=slots.get(key);
  if(hit){slots.delete(key);slots.set(key,hit);current=hit;return;}
  // Prepared on the shared 160px layers, then cropped into the frame's slot (the end of this function).
  const into={key};
  const data=recordedClips[state].frames[frame], tile=frame%130, sheet=sheets[state][Math.floor(frame/130)];
  const eyePath=new Path2D();into.eyePath=eyePath;
  for(const ring of data.eyes) {
    if(!ring.length)continue;eyePath.moveTo(...ring[0]);
    for(let i=1;i<ring.length;i++)eyePath.lineTo(...ring[i]);eyePath.closePath();
  }
  // The eyes' box (their contours, with room for the 2px outline and its smoothing) and the strokes'
  // box (their runs, with the fringe pixel around them): nothing outside them is read below.
  let eyeBox=null,runBox=null;
  for(const ring of data.eyes)for(const [x,y] of ring)eyeBox=eyeBox?[Math.min(eyeBox[0],x),Math.min(eyeBox[1],y),Math.max(eyeBox[2],x),Math.max(eyeBox[3],y)]:[x,y,x,y];
  if(eyeBox)eyeBox=clampBox([Math.floor(eyeBox[0])-3,Math.floor(eyeBox[1])-3,Math.ceil(eyeBox[2])+3,Math.ceil(eyeBox[3])+3]);
  for(let i=0;i<data.runs.length;i+=3){
    const y=data.runs[i],x0=data.runs[i+1],x1=x0+data.runs[i+2];
    runBox=runBox?[Math.min(runBox[0],x0),Math.min(runBox[1],y),Math.max(runBox[2],x1),Math.max(runBox[3],y+1)]:[x0,y,x1,y+1];
  }
  if(runBox)runBox=clampBox([runBox[0]-2,runBox[1]-2,runBox[2]+2,runBox[3]+2]);
  const both=eyeBox&&runBox?[Math.min(eyeBox[0],runBox[0]),Math.min(eyeBox[1],runBox[1]),Math.max(eyeBox[2],runBox[2]),Math.max(eyeBox[3],runBox[3])]:eyeBox??runBox;
  // Only that box of the recording's tile is copied out (and read back).
  if(both)source.getContext('2d').drawImage(sheet,(tile%10)*160+both[0],Math.floor(tile/10)*160+both[1],both[2]-both[0],both[3]-both[1],both[0],both[1],both[2]-both[0],both[3]-both[1]);
  const c=colors.getContext('2d'), pixels=readBox(source.getContext('2d'),both,pixelsAt), overlay=c.createImageData(160,160);
  // Recover the recording's soft eye edges instead of enlarging the hard
  // pixel-cell contours used for inspection. Keep edge fragments within the
  // source silhouette so its dark background cannot become part of an eye.
  const mask=eyeMask.getContext('2d');mask.clearRect(0,0,160,160);mask.fillStyle=mask.strokeStyle='#fff';mask.fill(eyePath);
  const core=readBox(mask,eyeBox,coreAt);
  mask.lineWidth=2;mask.lineJoin='round';mask.stroke(eyePath);
  const expanded=readBox(mask,eyeBox,expandedAt),eyes=mask.createImageData(160,160);
  // The raster pixels the eyes cover, so a caller can work on that box alone.
  let ex0=160,ey0=160,ex1=-1,ey1=-1;
  const [lx,ly,hx,hy]=eyeBox??[0,0,0,0];
  for(let y=ly;y<hy;y++)for(let x=lx;x<hx;x++) {
    const i=(y*160+x)*4;
    const interior=(x+.5-data.c[0])**2+(y+.5-data.c[1])**2<(data.c[2]-2.5)**2;
    if(!(interior?expanded:core)[i+3])continue;
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(Math.max(r,g,b)-Math.min(r,g,b)>25)continue;
    eyes.data.set([255,255,255,Math.round(255-(r+g+b)/3)],i);
    if(x<ex0)ex0=x;if(x>ex1)ex1=x;if(y<ey0)ey0=y;if(y>ey1)ey1=y;
  }
  into.eyeBox=ex1<0?null:[ex0,ey0,ex1+1,ey1+1];
  into.eyes=crop(eyes,into.eyeBox&&clampBox([into.eyeBox[0]-1,into.eyeBox[1]-1,into.eyeBox[2]+1,into.eyeBox[3]+1]));
  // Recover transparency from the recording's background, avoiding dark
  // fringes when its colored strokes are displayed on a light surface.
  const backgroundAt=(x,y)=>(x+.5-data.c[0])**2+(y+.5-data.c[1])**2<data.c[2]**2?[255,255,255]:[8,10,8];
  const fit=(index,color,background)=>{
    const v=color.map((n,j)=>n-background[j]),p=[0,1,2].map(j=>pixels[index+j]-background[j]);
    const a=Math.max(0,Math.min(1,p.reduce((sum,n,j)=>sum+n*v[j],0)/v.reduce((sum,n)=>sum+n*n,0)));
    return [a,p.reduce((sum,n,j)=>sum+(n-v[j]*a)**2,0)];
  };
  const choice=new Int8Array(160*160).fill(-1),strength=new Float32Array(160*160);
  let left=160,top=160,right=-1,bottom=-1;
  for(let i=0;i<data.runs.length;i+=3)for(let x=data.runs[i+1];x<data.runs[i+1]+data.runs[i+2];x++) {
    const y=data.runs[i],cell=y*160+x,background=backgroundAt(x,y);
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    let best=Infinity;
    workingPalette.forEach((color,k)=>{const [a,error]=fit(cell*4,color,background);if(error<best){best=error;choice[cell]=k;strength[cell]=a;}});
  }
  left=Math.max(0,left-1);top=Math.max(0,top-1);right=Math.min(159,right+1);bottom=Math.min(159,bottom+1);
  // The per-pixel match leaves stray specks inside a stroke and a hard edge
  // where the recording's soft fringe lies outside the stroke mask. Settle a
  // speck on the colour most of its neighbours chose, and let the fringe
  // pixels take their neighbours' colour at the transparency the recording
  // shows, away from the body's rim where the background changes.
  const counts=new Uint8Array(workingPalette.length);
  const around=(x,y,source)=>{
    counts.fill(0);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
      if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=160||ny>=160)continue;
      const k=source[ny*160+nx];if(k>=0)counts[k]++;
    }
    let majority=-1,most=0;counts.forEach((n,k)=>{if(n>most){most=n;majority=k;}});
    return [majority,most];
  };
  const settled=Int8Array.from(choice);
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++) {
    const cell=y*160+x;if(choice[cell]<0)continue;
    const [majority,most]=around(x,y,choice);
    if(majority!==choice[cell]&&most>=3&&counts[choice[cell]]<=1) {
      settled[cell]=majority;strength[cell]=fit(cell*4,workingPalette[majority],backgroundAt(x,y))[0];
    }
  }
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++) {
    const cell=y*160+x;
    let k=settled[cell],a=strength[cell];
    if(k<0) {
      const [majority,most]=around(x,y,settled);
      if(majority<0||most<2||Math.abs(Math.hypot(x+.5-data.c[0],y+.5-data.c[1])-data.c[2])<2)continue;
      a=fit(cell*4,workingPalette[majority],backgroundAt(x,y))[0];
      if(a<.12)continue;
      k=majority;
    }
    overlay.data.set([...workingPalette[k],Math.round(a*255)],cell*4);
  }
  c.putImageData(overlay,0,0);
  // Soften the pixel steps by half a source pixel, as the body's silhouette is.
  soft.getContext('2d').clearRect(0,0,160,160);
  const sc=soft.getContext('2d');sc.filter='blur(0.5px)';sc.drawImage(colors,0,0);sc.filter='none';
  c.clearRect(0,0,160,160);c.drawImage(soft,0,0);
  const f=front.getContext('2d');f.clearRect(0,0,160,160);f.globalCompositeOperation='source-over';f.drawImage(colors,0,0);
  f.globalCompositeOperation='destination-in';f.beginPath();f.arc(data.c[0],data.c[1],data.c[2]+1,0,Math.PI*2);f.fill();f.globalCompositeOperation='source-over';
  // The strokes reach a pixel past their runs, and the half-pixel blur a little further.
  const strokes=right<left||bottom<top?null:clampBox([left-4,top-4,right+5,bottom+5]);
  into.colors=crop(colors,strokes);
  into.front=crop(front,strokes);
  into.bytes=[into.eyes,into.colors,into.front].reduce((sum,part)=>sum+(part?part.canvas.width*part.canvas.height*4:0),0)+256;
  slots.set(key,into);current=into;held+=into.bytes;
  for(const [old,slot] of slots){if(held<=BUDGET||old===key)break;slots.delete(old);held-=slot.bytes;}
}

export function drawRecordedReference(canvas,state,frame,outline=false) {
  // prepare() copies only the boxes it reads, so the whole tile comes from its sheet here.
  prepare(state,frame);const ctx=canvas.getContext('2d'),tile=frame%130,sheet=sheets[state][Math.floor(frame/130)];
  ctx.drawImage(sheet,(tile%10)*160,Math.floor(tile/10)*160,160,160,0,0,canvas.width,canvas.height);
  if(outline){ctx.save();ctx.scale(canvas.width/160,canvas.height/160);ctx.strokeStyle='#35cbae';ctx.lineWidth=.6;ctx.stroke(current.eyePath);ctx.restore();}
  canvas.dataset.frame=String(frame);
  canvas.dataset.activity=state;
}

// One fixed transform for the complete eye field. No eye reassignment,
// angle reconstruction, gaze gain, silhouette clamp or temporal easing.
// The Working sequencer may mirror or turn the whole field about the
// source body's centre, and slide it in source pixels while a join settles.
// `t` is a canvas context, or the matrix recordedEyesBox follows: both take the same steps.
function placeEyeField(t,eyes,field) {
  const scale=(eyes[0].height+eyes[1].height)/2/26.788061;
  t.translate((eyes[0].x+eyes[1].x)/2,(eyes[0].y+eyes[1].y)/2);
  t.scale(scale,scale);t.translate(-96.495,-71.789);
  if(field){t.translate(80,80);t.rotate(field.tilt*Math.PI/180);t.scale(field.mirror?-1:1,1);t.translate(field.x-80,field.y-80);}
}

export function drawRecordedEyes(ctx,eyes,state,frame,field) {
  prepare(state,frame);
  ctx.save();ctx.fillStyle='#fff';
  placeEyeField(ctx,eyes,field);
  const part=current.eyes;
  if(part)ctx.drawImage(part.canvas,part.x,part.y);
  ctx.restore();
}

// Where drawRecordedEyes would put this frame's eyes, in the caller's units:
// [left, top, right, bottom] around the raster pixels they cover, with one
// raster pixel to spare for the stretched raster's smoothing; null when the
// frame has no eye. Lets the compositor size its eye layer to the eyes.
export function recordedEyesBox(eyes,state,frame,field) {
  prepare(state,frame);
  const box=current.eyeBox;
  if(!box)return null;
  const m={a:1,b:0,c:0,d:1,e:0,f:0,
    translate(x,y){this.e+=this.a*x+this.c*y;this.f+=this.b*x+this.d*y;},
    scale(x,y){this.a*=x;this.b*=x;this.c*=y;this.d*=y;},
    rotate(r){const cos=Math.cos(r),sin=Math.sin(r),{a,b,c,d}=this;this.a=a*cos+c*sin;this.b=b*cos+d*sin;this.c=c*cos-a*sin;this.d=d*cos-b*sin;}};
  placeEyeField(m,eyes,field);
  const xs=[],ys=[];
  for(const [x,y] of [[box[0]-1,box[1]-1],[box[2]+1,box[1]-1],[box[0]-1,box[3]+1],[box[2]+1,box[3]+1]]){xs.push(m.a*x+m.c*y+m.e);ys.push(m.b*x+m.d*y+m.f);}
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}

export function drawWorkingStrokes(ctx,frame,isFront,field) {
  prepare('Working',frame);
  // The original recording's visible stroke pixels, on the same frame as
  // the eyes. Source circle diameter 112 px maps to an 80-unit avatar body.
  ctx.save();
  if(field){ctx.translate(50,50);ctx.rotate(field.tilt*Math.PI/180);ctx.scale(field.mirror?-1:1,1);ctx.translate(-50,-50);}
  // The 160px layer drawn 160*80/112 units wide: each crop at its own place and size in it.
  const part=isFront?current.front:current.colors,k=80/112;
  if(part)ctx.drawImage(part.canvas,50-80/112*80+part.x*k,50-80/112*80+part.y*k,part.canvas.width*k,part.canvas.height*k);
  ctx.restore();
}
