const { shell } = require("electron");

async function openExternalUrl(url) {
  return shell.openExternal(url);
}

module.exports = { openExternalUrl };
