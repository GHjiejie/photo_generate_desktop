const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { version } = require('../package.json');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This release script targets Apple Silicon macOS.');
}
const output = path.resolve(__dirname,'../release-react');
const app = path.join(output,'mac-arm64','Portrait Studio.app');
const stem = `Portrait-Studio-React-${version}-arm64`;
const staging = fs.mkdtempSync(path.join(os.tmpdir(),'portrait-dmg-'));
try {
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
  execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,path.join(output,`${stem}.zip`)],{stdio:'inherit'});
  execFileSync('/usr/bin/ditto',[app,path.join(staging,'Portrait Studio.app')],{stdio:'inherit'});
  fs.symlinkSync('/Applications',path.join(staging,'Applications'));
  execFileSync('/usr/bin/hdiutil',['create','-volname','Portrait Studio','-srcfolder',staging,'-format','UDZO','-ov',path.join(output,`${stem}.dmg`)],{stdio:'inherit'});
  execFileSync('/usr/bin/hdiutil',['verify',path.join(output,`${stem}.dmg`)],{stdio:'inherit'});
  console.log(`Created ${stem}.dmg and ${stem}.zip in ${output}`);
} finally { fs.rmSync(staging,{recursive:true,force:true}); }
