// electron-builder afterPack hook: sign the macOS app ourselves.
//
// macOS ties Screen Recording / Accessibility grants to the app's signature. An ad-hoc signature
// changes with every build, so each update looked like a new app and lost its permissions. CI signs
// with one fixed self-signed certificate instead (MAC_SIGN_IDENTITY, see the build workflow), which
// keeps the grants across updates. Without it (local builds, forks) we fall back to ad-hoc.
// electron-builder's own signing is off (mac.identity: null) because it rejects untrusted certs.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const identity = process.env.MAC_SIGN_IDENTITY || '-';
  console.log(`  • signing ${app} with ${identity === '-' ? 'ad-hoc signature' : 'ShoreShot certificate'}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' });
};
