const { chromium } = require('playwright');

async function connectToChrome() {
  const browser = await chromium.connectOverCDP(
    'http://localhost:9222'
  );

  const context = browser.contexts()[0];

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  return { browser, context, page };
}

module.exports = { connectToChrome };
