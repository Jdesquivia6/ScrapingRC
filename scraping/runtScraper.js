const { connectToChrome } = require('./connectToChrome');
const fs = require('fs');
const path = require('path');

const URL = 'https://runtpro.runt.gov.co/#/consultar-direcciones-pn';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function random(min = 800, max = 2500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanDelay(page, min, max) {
  await page.waitForTimeout(random(min, max));
}

async function humanScroll(page) {
  await page.mouse.wheel(0, random(200, 800));
  await humanDelay(page, 400, 1200);
}

async function humanClearAndType(page, selector, value) {
  const input = page.locator(selector);
  await input.waitFor({ timeout: 10000 });

  await input.click();
  await humanDelay(page, 200, 600);

  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await humanDelay(page, 100, 300);

  await page.keyboard.press('Backspace');
  await humanDelay(page, 300, 700);

  await input.type(String(value), {
    delay: random(80, 160)
  });

  await humanDelay(page, 500, 1200);
}

async function openTipoDocumentoSelect(page) {
  await page.locator('mat-form-field', { hasText: 'Tipo de Documento' }).click();
  await page.locator('.cdk-overlay-pane mat-option').first().waitFor({ timeout: 10000 });
}

async function selectTipoDocumento(page, tipoDocumento) {
  await openTipoDocumentoSelect(page);
  await humanDelay(page, 400, 1200);

  await page.locator('mat-option .mat-option-text', {
    hasText: tipoDocumento
  }).click();

  await humanDelay(page, 800, 1800);
}

async function clickBuscar(page) {
  await humanScroll(page);
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

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await humanDelay(page, 1500, 3000);

  await selectTipoDocumento(page, tipoDocumento);

  await humanClearAndType(page, 'input[formcontrolname="nroDocumento"]', numeroDocumento);

  await clickBuscar(page);

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await humanDelay(page, 2000, 4000);

  const screenshotsDir = path.join(__dirname, '../screenshots');
  const screenshotPath = await takeScreenshot(
    page,
    screenshotsDir,
    `runt-${numeroDocumento}.png`
  );

  return {
    ok: true,
    message: 'Consulta ejecutada',
    screenshotPath
  };
};

exports.scrapeDireccionesPNBatch = async ({ tipoDocumento, documentos }) => {
  const { page } = await connectToChrome();

  console.log('Sesión Runt detectada (BATCH HUMANO)');

  const screenshotsDir = path.join(__dirname, '../screenshots');
  ensureDir(screenshotsDir);

  const results = [];

  for (let i = 0; i < documentos.length; i++) {
    const doc = String(documentos[i]).trim();

    if (!doc) {
      results.push({
        documento: documentos[i],
        ok: false,
        error: 'Documento vacío'
      });
      continue;
    }

    try {
      if (i % 2 === 0) {
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await humanDelay(page, 1500, 3000);
        await selectTipoDocumento(page, tipoDocumento);
      }

      await humanClearAndType(page, 'input[formcontrolname="nroDocumento"]', doc);

      await clickBuscar(page);

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(page, 2500, 5000);

      const screenshotPath = await takeScreenshot(
        page,
        screenshotsDir,
        `runt-${doc}.png`
      );

      results.push({
        documento: doc,
        ok: true,
        message: 'Consulta ejecutada',
        screenshotPath
      });

      await humanDelay(page, 3000, 7000);

    } catch (err) {
      const screenshotPath = await takeScreenshot(
        page,
        screenshotsDir,
        `runt-${doc}-error.png`
      );

      results.push({
        documento: doc,
        ok: false,
        error: err.message,
        screenshotPath
      });

      await humanDelay(page, 4000, 8000);
    }
  }

  return results;
};
