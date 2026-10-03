const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Local integrity signature only. This does not authenticate a developer or notarize.
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], {stdio:'inherit'});
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {stdio:'inherit'});
};
