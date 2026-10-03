const fs = require('node:fs/promises');
const path = require('node:path');

function trustedSender(event, expectedURL) {
  return Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === expectedURL);
}

async function resolvePortraitImage(name, imageDirectory, allowedImages) {
  if (typeof name !== 'string' || !allowedImages.has(name) || path.basename(name) !== name) return null;
  try {
    const directory = await fs.realpath(imageDirectory);
    const file = await fs.realpath(path.join(directory, name));
    if (path.dirname(file) !== directory || !(await fs.stat(file)).isFile()) return null;
    return file;
  } catch { return null; }
}

module.exports = { trustedSender, resolvePortraitImage };
