const { chromium } = require('playwright');

async function connectToChrome() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');

  let context = browser.contexts()[0];
  if (!context) {
    context = await browser.newContext();
  }

  const pages = context.pages();

  // Preferir una pestaña ya abierta en RUNT. Si no existe, crear una propia:
  // nunca secuestramos pages[0], que suele ser la pestaña del operador.
  let page = pages.find(p => p.url().includes('runtpro.runt.gov.co'));

  if (!page) {
    page = await context.newPage();
  }

  return { browser, context, page };
}

module.exports = { connectToChrome };