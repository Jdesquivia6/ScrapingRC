const { chromium } = require('playwright');

async function connectToChrome() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');

  let context = browser.contexts()[0];
  if (!context) {
    context = await browser.newContext();
  }

  const pages = context.pages();

  let page =
    pages.find(p =>
      p.url().includes('runtpro.runt.gov.co')
    ) || pages[0];

  if (!page) {
    page = await context.newPage();
  }

  return { browser, context, page };
}

module.exports = { connectToChrome };