const fs = require('node:fs');
const path = require('node:path');
const {PNG} = require('pngjs');
const directory = path.resolve(__dirname,'../.verification');
const sourceKind = process.env.PORTRAIT_STUDIO_SOURCE_VERIFICATION || 'bilingual';
const packagedKind = process.env.PORTRAIT_STUDIO_PACKAGE_VERIFICATION || 'bilingual-packaged';
const report = JSON.parse(fs.readFileSync(path.join(directory,`${sourceKind}-verification.json`),'utf8'));
const results = [];
function compare(beforeFile,afterFile,excluded){
  const before = PNG.sync.read(fs.readFileSync(path.join(directory,beforeFile)));
  const after = PNG.sync.read(fs.readFileSync(path.join(directory,afterFile)));
  if(before.width!==after.width||before.height!==after.height)throw new Error('Screenshot dimensions differ');
  let changed=0,outsideChanged=0,outsideAboveTwoLevels=0,outsideMaxDelta=0;
  const diff=new PNG({width:before.width,height:before.height});
  for(let y=0;y<before.height;y++)for(let x=0;x<before.width;x++){
    const i=(y*before.width+x)*4;
    const different=[0,1,2,3].some(c=>before.data[i+c]!==after.data[i+c]);
    const delta=Math.max(...[0,1,2].map(c=>Math.abs(before.data[i+c]-after.data[i+c])));
    const inside=excluded&&x>=excluded.left-2&&x<=excluded.right+2&&y>=excluded.top-2&&y<=excluded.bottom+2;
    if(different)changed++;
    if(!inside){if(different)outsideChanged++;if(delta>2)outsideAboveTwoLevels++;outsideMaxDelta=Math.max(outsideMaxDelta,delta);}
    diff.data[i]=different?255:after.data[i]*.2;diff.data[i+1]=different?50:after.data[i+1]*.2;diff.data[i+2]=different?100:after.data[i+2]*.2;diff.data[i+3]=255;
  }
  return {changedPixels:changed,changedPercent:changed/(before.width*before.height)*100,outsideControlChangedPixels:outsideChanged,outsideControlPixelsAboveTwoLevels:outsideAboveTwoLevels,outsideControlMaxDelta:outsideMaxDelta,diff};
}
for(const state of report.visualComparisons){
  const suffix=`${state.viewport.width}x${state.viewport.height}-${state.density}.png`;
  const preserved=compare(`react-${suffix}`,state.screenshot,state.languageControl);
  fs.writeFileSync(path.join(directory,`bilingual-diff-${suffix}`),PNG.sync.write(preserved.diff));delete preserved.diff;
  const packaged=compare(state.screenshot,`${packagedKind}-${suffix}`);delete packaged.diff;
  results.push({viewport:state.viewport,density:state.density,excludedNewLanguageControl:state.languageControl,comparedToVersion:'1.1.0',preservedLayout:preserved,packagedVsSource:packaged});
}
fs.writeFileSync(path.join(directory,'bilingual-visual-comparison.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
if(results.some(item=>item.preservedLayout.outsideControlPixelsAboveTwoLevels>0||item.packagedVsSource.outsideControlPixelsAboveTwoLevels>0))process.exitCode=1;
