const fs = require('fs');
const path = require('path');
const { connectToChrome } = require('./connectToChrome');

const URL_RUNT = 'https://runtpro.runt.gov.co/#/recaudosliquidaciones/liquidar-tramite';

const SOLICITANTE_TIPO_DOCUMENTO = 'NIT';
const SOLICITANTE_NUMERO_DOCUMENTO = '901769233';

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');

function ensureDownloadDir() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }
}

function normalizarTexto(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor).trim();
}

function normalizarMayus(valor) {
  return normalizarTexto(valor).toUpperCase();
}

function random(min = 600, max = 1400) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pausa(page, min = 600, max = 1400) {
  await page.waitForTimeout(random(min, max));
}

async function seleccionarOpcionMatSelect(page, selector, textoOpcion) {
  const valor = normalizarTexto(textoOpcion);
  if (!valor) return;

  const select = page.locator(selector).first();
  await select.waitFor({ state: 'visible', timeout: 15000 });

  await pausa(page, 400, 900);
  await select.click();
  await pausa(page, 500, 1000);

  const opcion = page.locator('mat-option').filter({ hasText: valor }).first();

  if (await opcion.count()) {
    await opcion.waitFor({ state: 'visible', timeout: 10000 });
    await pausa(page, 300, 700);
    await opcion.click();
    await pausa(page, 700, 1300);
    return;
  }

  const opcionTexto = page.locator('.mat-option-text').filter({ hasText: valor }).first();

  if (await opcionTexto.count()) {
    await opcionTexto.waitFor({ state: 'visible', timeout: 10000 });
    await pausa(page, 300, 700);
    await opcionTexto.click();
    await pausa(page, 700, 1300);
    return;
  }

  throw new Error(`No se encontró la opción "${valor}" en ${selector}`);
}

async function escribirLento(locator, valor) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.fill('');

  for (const ch of String(valor)) {
    await locator.type(ch, { delay: random(90, 180) });
  }
}

async function llenarInput(locator, valor) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.fill('');
  await locator.type(String(valor), { delay: 35 });
}

async function esperarNombreSolicitante(page) {
  const nombreInput = page.locator('[formcontrolname="formNombreSolicitante"]').first();
  await nombreInput.waitFor({ state: 'visible', timeout: 15000 });

  await page.waitForFunction(
    el => !!el && !!el.value && el.value.trim().length > 0,
    await nombreInput.elementHandle(),
    { timeout: 20000 }
  );

  return await nombreInput.inputValue();
}

async function dispararConsultaNit(page) {
  const inputDocumento = page.locator('[formcontrolname="formNumDocumento"]').first();
  const nombreInput = page.locator('[formcontrolname="formNombreSolicitante"]').first();

  await pausa(page, 500, 1000);

  await inputDocumento.press('Tab');
  await pausa(page, 1200, 2200);

  let nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) {
    return nombre;
  }

  await page.mouse.click(80, 80);
  await pausa(page, 1500, 2500);

  nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) {
    return nombre;
  }

  await inputDocumento.click();
  await pausa(page, 400, 800);
  await inputDocumento.press('Tab');
  await pausa(page, 1800, 3000);

  nombre = await nombreInput.inputValue().catch(() => '');
  return nombre;
}

async function diligenciarSolicitante(page) {
  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formTipoDocumento"]',
    SOLICITANTE_TIPO_DOCUMENTO
  );

  await pausa(page, 700, 1300);

  const numeroInput = page.locator('[formcontrolname="formNumDocumento"]').first();
  await escribirLento(numeroInput, SOLICITANTE_NUMERO_DOCUMENTO);

  const nombreDetectado = await dispararConsultaNit(page);

  if (!nombreDetectado || !nombreDetectado.trim()) {
    throw new Error('No fue posible cargar automáticamente el nombre del solicitante a partir del NIT');
  }

  const nombreSolicitante = await esperarNombreSolicitante(page);

  return {
    tipoDocumentoSolicitante: SOLICITANTE_TIPO_DOCUMENTO,
    numeroDocumentoSolicitante: SOLICITANTE_NUMERO_DOCUMENTO,
    nombreSolicitante
  };
}

async function seleccionarRegistro(page, registro) {
  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formRegistro"]',
    normalizarMayus(registro)
  );

  await pausa(page, 1200, 2200);
}

async function procesarRegistroConPlaca(page, placa) {
  const placaNormalizada = normalizarMayus(placa);

  if (!placaNormalizada) {
    throw new Error('La placa es obligatoria para este tipo de registro');
  }

  const inputPlaca = page.locator('input[placeholder="Ingrese el número de placa."]').first();
  await inputPlaca.waitFor({ state: 'visible', timeout: 15000 });

  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 500, 900);
  await inputPlaca.press('Tab');
  await pausa(page, 1200, 2200);

  const valorActual = normalizarMayus(await inputPlaca.inputValue().catch(() => ''));

  await inputPlaca.click();
  await pausa(page, 300, 700);
  await inputPlaca.fill('');
  await pausa(page, 300, 700);

  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 500, 900);
  await inputPlaca.press('Tab');
  await pausa(page, 1500, 2600);

  return {
    placa: placaNormalizada,
    validacionIntermedia: valorActual
  };
}

async function procesarRegistroConDocumento(page, tipoDocumento, numeroDocumento) {
  const tipoDoc = normalizarMayus(tipoDocumento);
  const nroDoc = normalizarTexto(numeroDocumento);

  if (!tipoDoc) {
    throw new Error('El tipoDocumento es obligatorio para este registro');
  }

  if (!nroDoc) {
    throw new Error('El numeroDocumento es obligatorio para este registro');
  }

  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formRegistroTipoDocumento"]',
    tipoDoc
  );

  await pausa(page, 700, 1300);

  const inputDocumento = page.locator('[formcontrolname="formRegistroNumDocumento"]').first();
  await escribirLento(inputDocumento, nroDoc);
  await pausa(page, 500, 900);
  await inputDocumento.press('Tab');

  await pausa(page, 1200, 2200);

  return {
    tipoDocumento: tipoDoc,
    numeroDocumento: nroDoc
  };
}

async function seleccionarTramite(page, tramite) {
  const valor = normalizarTexto(tramite);
  if (!valor) {
    throw new Error('El trámite es obligatorio');
  }

  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formTramite"]',
    valor
  );

  await pausa(page, 1200, 2200);
  return valor;
}

async function seleccionarClasificacion(page, clasificacion) {
  const valor = normalizarTexto(clasificacion);
  if (!valor) return null;

  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formClasificacion"]',
    valor
  );

  await pausa(page, 1200, 2200);
  return valor;
}

async function seleccionarTarifa(page, tarifa) {
  const valor = normalizarTexto(tarifa);
  if (!valor) return null;

  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formTarifaAplicar"]',
    valor
  );

  await pausa(page, 1200, 2200);
  return valor;
}

async function leerTablaTramites(page) {
  const filas = page.locator('table tbody tr');
  const total = await filas.count();
  const data = [];

  for (let i = 0; i < total; i++) {
    const fila = filas.nth(i);
    const columnas = fila.locator('td');
    const cantidad = await columnas.count();

    const valores = [];
    for (let j = 0; j < cantidad; j++) {
      valores.push((await columnas.nth(j).innerText()).trim());
    }

    data.push({
      id: valores[0] || '',
      nombre: valores[1] || '',
      tarifa: valores[2] || ''
    });
  }

  return data;
}

async function generarYDescargar(page) {
  ensureDownloadDir();

  const boton = page.locator('button:has-text("Generar")').first();
  await boton.waitFor({ state: 'visible', timeout: 15000 });

  const disabled = await boton.isDisabled().catch(() => false);
  if (disabled) {
    throw new Error('El botón Generar está deshabilitado. Falta completar o validar algún campo.');
  }

  await pausa(page, 1200, 2200);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    boton.click()
  ]);

  const fileName = download.suggestedFilename();
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  await download.saveAs(filePath);

  return {
    fileName,
    filePath
  };
}

async function prepararPagina(page) {
  // await page.setViewportSize({ width: 1366, height: 900 });

  const urlActual = page.url();

  if (!urlActual.includes('/#/recaudosliquidaciones/liquidar-tramite')) {
    await page.goto(URL_RUNT, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  }

  await pausa(page, 2500, 4000);
}

async function scrapeLiquidacionTramite({
  registro,
  placa,
  tipoDocumento,
  numeroDocumento,
  tramite,
  clasificacion,
  tarifa
}) {
  let browser;
  let context;
  let page;

  try {
    const session = await connectToChrome();
    browser = session.browser;
    context = session.context;
    page = session.page;

    await prepararPagina(page);

    const datosSolicitante = await diligenciarSolicitante(page);

    const registroNormalizado = normalizarMayus(registro);
    await seleccionarRegistro(page, registroNormalizado);

    let datosAdicionales = {};

    if (['RNA', 'RNMA', 'RNRS'].includes(registroNormalizado)) {
      datosAdicionales = await procesarRegistroConPlaca(page, placa);
    } else if (['RNC', 'RNPNJ'].includes(registroNormalizado)) {
      datosAdicionales = await procesarRegistroConDocumento(page, tipoDocumento, numeroDocumento);
    } else if (registroNormalizado === 'RNET') {
      datosAdicionales = {};
    } else {
      throw new Error(`Registro no soportado: ${registroNormalizado}`);
    }

    const tramiteSeleccionado = await seleccionarTramite(page, tramite);
    const clasificacionSeleccionada = await seleccionarClasificacion(page, clasificacion);
    const tarifaSeleccionada = await seleccionarTarifa(page, tarifa);

    const tramitesTabla = await leerTablaTramites(page);
    const descarga = await generarYDescargar(page);

    return {
      ok: true,
      mensaje: 'Liquidación generada correctamente',
      data: {
        registro: registroNormalizado,
        ...datosSolicitante,
        ...datosAdicionales,
        tramite: tramiteSeleccionado,
        clasificacion: clasificacionSeleccionada,
        tarifa: tarifaSeleccionada,
        tramitesTabla,
        descarga
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  } finally {
    // No cerramos page ni browser porque reutilizamos la sesión abierta en Chrome.
  }
}

module.exports = {
  scrapeLiquidacionTramite
};