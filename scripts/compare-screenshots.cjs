const fs=require('node:fs');
const path=require('node:path');
const {PNG}=require('pngjs');
const directory=path.resolve(__dirname,'../.verification');
const results=[];
for(const size of ['1440x920','2048x1280']){
  for(const density of ['normal','dense']){
    const name=`${size}-${density}`;
    const before=PNG.sync.read(fs.readFileSync(path.join(directory,`baseline-${name}.png`)));
    const after=PNG.sync.read(fs.readFileSync(path.join(directory,`react-${name}.png`)));
    if(before.width!==after.width||before.height!==after.height)throw new Error('Screenshot dimensions differ');
    let whole=0,main=0,meaningfulMain=0,mainMaxDelta=0;const diff=new PNG({width:before.width,height:before.height});
    for(let y=0;y<before.height;y++)for(let x=0;x<before.width;x++){
      const i=(y*before.width+x)*4;
      const changed=[0,1,2,3].some(c=>before.data[i+c]!==after.data[i+c]);
      const delta=Math.max(...[0,1,2].map(c=>Math.abs(before.data[i+c]-after.data[i+c])));
      if(x>=250){mainMaxDelta=Math.max(mainMaxDelta,delta);if(delta>2)meaningfulMain++;}
      if(changed){whole++;if(x>=250)main++;}
      diff.data[i]=changed?255:after.data[i]*.2;diff.data[i+1]=changed?50:after.data[i+1]*.2;diff.data[i+2]=changed?100:after.data[i+2]*.2;diff.data[i+3]=255;
    }
    fs.writeFileSync(path.join(directory,`diff-${name}.png`),PNG.sync.write(diff));
    results.push({size,density,totalPixels:before.width*before.height,changedPixels:whole,changedPercent:whole/(before.width*before.height)*100,mainChangedPixels:main,mainChangedPercent:main/((before.width-250)*before.height)*100,mainMaxChannelDelta:mainMaxDelta,mainPixelsAboveTwoLevels:meaningfulMain,note:'Exact differences include 1–2/255 renderer rounding. Main excludes the sidebar; sidebar footer/tip becomes visible after fixing viewport scrolling.'});
  }
}
fs.writeFileSync(path.join(directory,'visual-comparison.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.mainPixelsAboveTwoLevels>0))process.exitCode=1;
