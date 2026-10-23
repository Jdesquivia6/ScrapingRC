const { chromium } = require('playwright');

// La conexión CDP se cachea a nivel de proceso. Antes se abria una conexión nueva
// por cada documento y nunca se cerraba, asi que un job de 90 items dejaba 90
// conexiones CDP vivas y el navegador CDP iba acumulandolas.
let conexion = null;

async function connectToChrome() {
  if (
    conexion &&
    conexion.browser.isConnected() &&
    !conexion.page.isClosed()
  ) {
    return conexion;
  }

  // Si algo quedo colgado o Chrome se reinicio, se descarta y se reconecta.
  await disconnectChrome().catch(() => {});

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

  conexion = { browser, context, page };
  return conexion;
}

async function disconnectChrome() {
  if (!conexion) return;
  const { browser } = conexion;
  conexion = null;
  await browser.disconnect().catch(() => {});
}

module.exports = { connectToChrome, disconnectChrome };
