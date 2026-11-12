// Use the locked development dependency on Linux CI and local workstations.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.TT_PLAYWRIGHT_MODULE || path.join(__dirname, '../../frontend/node_modules/playwright'));

function launchOptions() {
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.TT_CHROME_EXECUTABLE || (fs.existsSync(macChrome) ? macChrome : undefined);
  return { headless: true, ...(executablePath ? { executablePath } : {}) };
}

module.exports = { chromium, launchOptions };
