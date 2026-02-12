const { connectToChrome } = require('./connectToChrome');
const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function openTipoDocumentoSelect(page) {
  await page.locator('mat-form-field', { hasText: 'Tipo de Documento' }).click();
  await page.locator('.cdk-overlay-pane mat-option').first().waitFor({ timeout: 10000 });
}

async function selectTipoDocumento(page, tipoDocumento) {
  await openTipoDocumentoSelect(page);
  await page.locator('mat-option .mat-option-text', { hasText: tipoDocumento }).click();
}

async function fillDocumento(page, numeroDocumento) {
  const input = page.locator('input[formcontrolname="nroDocumento"]');
  await input.waitFor({ timeout: 10000 });
  await input.fill('');
  await input.fill(String(numeroDocumento));
}

async function clickBuscar(page) {
  await page.locator('button[type="submit"]', { hasText: 'Buscar' }).click();
}

async function takeScreenshot(page, screenshotsDir, filename) {
  ensureDir(screenshotsDir);
  const screenshotPath = path.join(screenshotsDir, filename);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

exports.scrapeDireccionesPN = async ({ tipoDocumento, numeroDocumento }) => {
  const { page } = await connectToChrome();

  console.log('Sesión Runt detectada');

  await page.goto('https://runtpro.runt.gov.co/#/consultar-direcciones-pn', {
    waitUntil: 'domcontentloaded'
  });

  await page.waitForTimeout(1500);

  await selectTipoDocumento(page, tipoDocumento);
  await fillDocumento(page, numeroDocumento);
  await clickBuscar(page);

  await page.waitForTimeout(4000);

  const screenshotsDir = path.join(__dirname, '../screenshots');
  const screenshotPath = await takeScreenshot(page, screenshotsDir, `runt-${numeroDocumento}.png`);

  return {
    ok: true,
    message: 'Consulta ejecutada',
    screenshotPath
  };
};

exports.scrapeDireccionesPNBatch = async ({ tipoDocumento, documentos }) => {
  const { page } = await connectToChrome();

  console.log('Sesión Runt detectada (BATCH)');

  await page.goto('https://runtpro.runt.gov.co/#/consultar-direcciones-pn', {
    waitUntil: 'domcontentloaded'
  });

  await page.waitForTimeout(1500);

  await selectTipoDocumento(page, tipoDocumento);

  const screenshotsDir = path.join(__dirname, '../screenshots');
  ensureDir(screenshotsDir);

  const results = [];

  for (const numeroDocumento of documentos) {
    const doc = String(numeroDocumento).trim();

    if (!doc) {
      results.push({ documento: numeroDocumento, ok: false, error: 'Documento vacío' });
      continue;
    }

    try {
      await fillDocumento(page, doc);
      await clickBuscar(page);

      await page.waitForTimeout(3000);

      const screenshotPath = await takeScreenshot(page, screenshotsDir, `runt-${doc}.png`);

      results.push({
        documento: doc,
        ok: true,
        message: 'Consulta ejecutada',
        screenshotPath
      });

      await page.waitForTimeout(800);
    } catch (err) {
      const screenshotPath = await takeScreenshot(page, screenshotsDir, `runt-${doc}-error.png`);

      results.push({
        documento: doc,
        ok: false,
        error: err.message,
        screenshotPath
      });

      await page.waitForTimeout(1000);
    }
  }

  return results;
};
