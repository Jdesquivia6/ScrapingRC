const { connectToChrome } = require('./connectToChrome');
const fs = require('fs');
const path = require('path');

exports.scrapeComparendos = async (numeroComparendo) => {
  const { page } = await connectToChrome();

  console.log('Sesión Civitrans detectada');

  let apiResponse = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();

      if (url.includes('comparendo')) {
        const json = await response.json();

        if (json?.code === 'unauthorized') {
          throw new Error(
            'Sesión expirada. Requiere login humano.'
          );
        }

        if (json?.comp) {
          apiResponse = json;
        }
      }
    } catch (error) {
      console.error('Listener error:', error.message);
    }
  });

  // await page.goto(
  //   'http://contravenciones.civitrans.com.co:4200/#/comparendos/consultar-comparendo',
  //   { waitUntil: 'networkidle' }
  // );

  await page.goto(
    'https://runtpro.runt.gov.co/#/home',
    { waitUntil: 'networkidle' }
  );

  await page.waitForTimeout(2500);

  await page
    .locator('input[formcontrolname="noComparendo"]')
    .fill(numeroComparendo);

  await page
    .locator('button')
    .filter({ hasText: 'Consultar' })
    .click();

  await page.waitForTimeout(3000);

  const screenshotsDir = path.join(__dirname, '../screenshots');

  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
  }

  const screenshotPath = path.join(
    screenshotsDir,
    `comparendo-${numeroComparendo}.png`
  );

  await page.screenshot({
    path: screenshotPath,
    fullPage: true
  });

  console.log('Screenshot guardado:', screenshotPath);

  if (!apiResponse) {
    return {
      ok: false,
      message: 'No se recibió respuesta del comparendo'
    };
  }

  return apiResponse;
};
