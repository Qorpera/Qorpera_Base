import { recordedClips } from './recorded-clips.mjs';
import { workingPalette } from './working-palette.mjs';

const sheets={};
let cached='', eyePath;
let source, colors, front, eyeMask, eyeRaster;
const loading = new Map();

export function loadRecordedMotion(state, base) {
  if (!recordedClips[state]) return Promise.resolve();
  if (loading.has(state)) return loading.get(state);
  if (!source) {
    [source, colors, front, eyeMask, eyeRaster] = Array.from({length:5}, () => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=160;return canvas;
    });
  }
  const run=Promise.all(recordedClips[state].atlases.map(async file=>{
    const image=new Image();image.src=new URL(file,base);await image.decode();return image;
  })).then(images=>{sheets[state]=images;}).catch(error=>{loading.delete(state);throw error;});
  loading.set(state,run);
  return run;
}

function prepare(state,frame) {
  const key=state+':'+frame;
  if(cached===key)return;
  const data=recordedClips[state].frames[frame], tile=frame%130, sheet=sheets[state][Math.floor(frame/130)];
  source.getContext('2d').drawImage(sheet,(tile%10)*160,Math.floor(tile/10)*160,160,160,0,0,160,160);
  eyePath=new Path2D();
  for(const ring of data.eyes) {
    if(!ring.length)continue;eyePath.moveTo(...ring[0]);
    for(let i=1;i<ring.length;i++)eyePath.lineTo(...ring[i]);eyePath.closePath();
  }
  const c=colors.getContext('2d'), pixels=source.getContext('2d').getImageData(0,0,160,160).data, overlay=c.createImageData(160,160);
  // Recover the recording's soft eye edges instead of enlarging the hard
  // pixel-cell contours used for inspection. Keep edge fragments within the
  // source silhouette so its dark background cannot become part of an eye.
  const mask=eyeMask.getContext('2d');mask.clearRect(0,0,160,160);mask.fillStyle=mask.strokeStyle='#fff';mask.fill(eyePath);
  const core=mask.getImageData(0,0,160,160).data;
  mask.lineWidth=2;mask.lineJoin='round';mask.stroke(eyePath);
  const expanded=mask.getImageData(0,0,160,160).data,eyes=mask.createImageData(160,160);
  for(let y=0;y<160;y++)for(let x=0;x<160;x++) {
    const i=(y*160+x)*4;
    const interior=(x+.5-data.c[0])**2+(y+.5-data.c[1])**2<(data.c[2]-2.5)**2;
    if(!(interior?expanded:core)[i+3])continue;
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
    if(Math.max(r,g,b)-Math.min(r,g,b)>25)continue;
    eyes.data.set([255,255,255,Math.round(255-(r+g+b)/3)],i);
  }
  eyeRaster.getContext('2d').putImageData(eyes,0,0);
  for(let i=0;i<data.runs.length;i+=3)for(let x=data.runs[i+1];x<data.runs[i+1]+data.runs[i+2];x++) {
    const y=data.runs[i], index=(y*160+x)*4;
    const inside=(x+.5-data.c[0])**2+(y+.5-data.c[1])**2<data.c[2]**2;
    const background=inside?[255,255,255]:[8,10,8];
    let best=Infinity,chosen=workingPalette[0],alpha=1;
    for(const color of workingPalette) {
      const v=color.map((n,j)=>n-background[j]),p=[0,1,2].map(j=>pixels[index+j]-background[j]);
      const a=Math.max(0,Math.min(1,p.reduce((sum,n,j)=>sum+n*v[j],0)/v.reduce((sum,n)=>sum+n*n,0)));
      const error=p.reduce((sum,n,j)=>sum+(n-v[j]*a)**2,0);
      if(error<best){best=error;chosen=color;alpha=a;}
    }
    // Recover transparency from the recording's background, avoiding dark
    // fringes when its colored strokes are displayed on a light surface.
    overlay.data.set([...chosen,Math.round(alpha*255)],index);
  }
  c.putImageData(overlay,0,0);
  const f=front.getContext('2d');f.clearRect(0,0,160,160);f.globalCompositeOperation='source-over';f.drawImage(colors,0,0);
  f.globalCompositeOperation='destination-in';f.beginPath();f.arc(data.c[0],data.c[1],data.c[2]+1,0,Math.PI*2);f.fill();f.globalCompositeOperation='source-over';
  cached=key;
}

export function drawRecordedReference(canvas,state,frame,outline=false) {
  prepare(state,frame);const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0,canvas.width,canvas.height);
  if(outline){ctx.save();ctx.scale(canvas.width/160,canvas.height/160);ctx.strokeStyle='#35cbae';ctx.lineWidth=.6;ctx.stroke(eyePath);ctx.restore();}
  canvas.dataset.frame=String(frame);
  canvas.dataset.activity=state;
}

export function drawRecordedEyes(ctx,eyes,state,frame) {
  prepare(state,frame);
  const scale=(eyes[0].height+eyes[1].height)/2/26.788061;
  ctx.save();ctx.fillStyle='#fff';
  // One fixed transform for the complete eye field. No eye reassignment,
  // angle reconstruction, gaze gain, silhouette clamp or temporal easing.
  ctx.translate((eyes[0].x+eyes[1].x)/2,(eyes[0].y+eyes[1].y)/2);
  ctx.scale(scale,scale);ctx.translate(-96.495,-71.789);ctx.drawImage(eyeRaster,0,0);ctx.restore();
}

export function drawWorkingStrokes(ctx,frame,isFront) {
  prepare('Working',frame);
  // The original recording's visible stroke pixels, on the same frame as
  // the eyes. Source circle diameter 112 px maps to an 80-unit avatar body.
  ctx.drawImage(isFront?front:colors,50-80/112*80,50-80/112*80,160*80/112,160*80/112);
}
