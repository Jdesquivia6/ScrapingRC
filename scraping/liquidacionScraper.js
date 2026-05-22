/**
 * Scraper de liquidaciones RUNT — SOLO RNA
 *
 * Flujo real paso a paso replicando RUNT "Liquidar Trámite":
 *   1) Diligenciar solicitante (NIT + 901769233 → nombre automático)
 *   2) Seleccionar registro RNA
 *   3) Doble digitación de placa
 *   4) Seleccionar trámite (MATRICULA INICIAL | INSCRIPCIÓN ALERTA)
 *   5) Seleccionar clasificación (AUTOMOVIL | MEDIDAS CAUTELARES | MOTO | MOTOCARRO)
 *   6) Tarifa automática según combo trámite + clasificación
 *      - Con SweetAlert para MEDIDAS CAUTELARES
 *   7) Click Generar → interceptar API /liquidacion/generar → capturar PDF (base64)
 *   8) Aceptar SweetAlert de éxito
 *
 * Una sola liquidación por request.
 */

const fs = require('fs');
const path = require('path');
const { connectToChrome } = require('./connectToChrome');

const URL_RUNT = 'https://runtpro.runt.gov.co/#/recaudosliquidaciones/liquidar-tramite';

const SOLICITANTE_TIPO_DOCUMENTO = 'NIT';
const SOLICITANTE_NUMERO_DOCUMENTO = '901769233';
const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');

// ─────────────────────────────────────────────
// HELPERS GENERALES
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// HELPERS DE ESPERA ANGULAR/MATERIAL
// ─────────────────────────────────────────────

async function esperarElementoHabilitado(page, selector, timeout = 15000) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return !(el.classList.contains('ng-invalid') || el.disabled);
    },
    selector,
    { timeout }
  );
}

async function esperarNgValid(page, selector, timeout = 15000) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const clases = el.className || '';
      return clases.includes('ng-valid') && !clases.includes('ng-invalid');
    },
    selector,
    { timeout }
  );
}

async function esperarCierreOverlaysMatSelect(page) {
  await page.waitForFunction(
    () => {
      const panels = document.querySelectorAll('.mat-select-panel:not([style*="display: none"])');
      const backdrops = document.querySelectorAll('.cdk-overlay-backdrop[style*="opacity"]');
      const panelVisible = Array.from(panels).some(p => {
        const style = window.getComputedStyle(p);
        return style.display !== 'none';
      });
      const backdropVisible = Array.from(backdrops).some(b => {
        const style = window.getComputedStyle(b);
        return parseFloat(style.opacity) > 0;
      });
      return !panelVisible && !backdropVisible;
    },
    { timeout: 10000 }
  );
  await pausa(page, 200, 500);
}

// ─────────────────────────────────────────────
// INTERACCIÓN CON FORMULARIOS
// ─────────────────────────────────────────────

async function seleccionarOpcionMatSelect(page, selector, textoOpcion) {
  const valor = normalizarTexto(textoOpcion);
  if (!valor) return;

  await esperarElementoHabilitado(page, selector);
  await pausa(page, 400, 900);

  const select = page.locator(selector).first();
  await select.click();
  await pausa(page, 600, 1200);

  // Esperar que el panel se abra
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.mat-select-panel');
      if (!panel) return false;
      const style = window.getComputedStyle(panel);
      return style.display !== 'none' && style.visibility !== 'hidden';
    },
    { timeout: 10000 }
  );

  // Buscar opción por texto
  let opcion = page.locator('mat-option').filter({ hasText: valor }).first();
  if (await opcion.count()) {
    await opcion.waitFor({ state: 'visible', timeout: 10000 });
    await pausa(page, 200, 500);
    await opcion.click();
    await esperarCierreOverlaysMatSelect(page);
    return;
  }

  // Fallback por .mat-option-text
  const opcionTexto = page.locator('.mat-option-text').filter({ hasText: valor }).first();
  if (await opcionTexto.count()) {
    await opcionTexto.waitFor({ state: 'visible', timeout: 10000 });
    await pausa(page, 200, 500);
    await opcionTexto.click();
    await esperarCierreOverlaysMatSelect(page);
    return;
  }

  throw new Error(`No se encontró la opción "${valor}" en el selector ${selector}`);
}

async function escribirLento(locator, valor) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.fill('');
  for (const ch of String(valor)) {
    await locator.type(ch, { delay: random(90, 180) });
  }
}

// ─────────────────────────────────────────────
// SWEETALERT HANDLER
// ─────────────────────────────────────────────

/**
 * Espera que aparezca un SweetAlert y hace clic en el botón indicado.
 * @param {import('playwright').Page} page
 * @param {string} textoBoton - Texto del botón a clickear (ej: "Continuar", "Aceptar")
 * @param {number} timeout
 * @returns {Promise<boolean>} true si se manejó el SweetAlert
 */
async function manejarSweetAlert(page, textoBoton = 'Continuar', timeout = 10000) {
  try {
    const swal = page.locator('.swal2-popup.swal2-show');
    await swal.waitFor({ state: 'visible', timeout });
    await pausa(page, 400, 800);

    const btn = swal.locator('button.swal2-confirm').filter({ hasText: textoBoton }).first();
    if (await btn.count()) {
      await pausa(page, 300, 600);
      await btn.click();
      await pausa(page, 1000, 1800);
      return true;
    }
    return false;
  } catch {
    return false; // No apareció SweetAlert
  }
}

// ─────────────────────────────────────────────
// SECCIÓN 1: SOLICITANTE
// ─────────────────────────────────────────────

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

  // Estrategia 1: Tab
  await inputDocumento.press('Tab');
  await pausa(page, 1200, 2200);
  let nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) return nombre;

  // Estrategia 2: click fuera
  await page.mouse.click(80, 80);
  await pausa(page, 1500, 2500);
  nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) return nombre;

  // Estrategia 3: Tab otra vez
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
    throw new Error('No fue posible cargar automáticamente el nombre del solicitante');
  }

  const nombreSolicitante = await esperarNombreSolicitante(page);
  return {
    tipoDocumentoSolicitante: SOLICITANTE_TIPO_DOCUMENTO,
    numeroDocumentoSolicitante: SOLICITANTE_NUMERO_DOCUMENTO,
    nombreSolicitante: nombreSolicitante.trim()
  };
}

// ─────────────────────────────────────────────
// SECCIÓN 2: REGISTRO RNA
// ─────────────────────────────────────────────

async function seleccionarRegistroRNA(page) {
  // Puede que ya esté preseleccionado (readonly), lo intentamos por si acaso
  try {
    await seleccionarOpcionMatSelect(page, '[formcontrolname="formRegistro"]', 'RNA');
    await pausa(page, 1200, 2200);
  } catch {
    // Si falla, probablemente ya está en RNA
    await pausa(page, 500, 1000);
  }
}

// ─────────────────────────────────────────────
// SECCIÓN 3: PLACA (doble digitación)
// ─────────────────────────────────────────────

async function procesarPlaca(page, placa) {
  const placaNormalizada = normalizarMayus(placa);
  if (!placaNormalizada) {
    throw new Error('La placa es obligatoria');
  }

  const inputPlaca = page.locator(
    'app-doble-digitacion[formcontrolname="formNroPlaca"] input, ' +
    'app-doble-digitacion input[name="valor"], ' +
    'input[formcontrolname="formNroPlaca"], ' +
    'input[placeholder*="placa"]'
  ).first();
  await inputPlaca.waitFor({ state: 'visible', timeout: 15000 });

  // ── Digitación 1 ──
  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 500, 900);
  await inputPlaca.press('Tab');
  await pausa(page, 1200, 2200);

  // ── Digitación 2 (confirmación RUNT) ──
  await inputPlaca.click();
  await pausa(page, 300, 700);
  await inputPlaca.fill('');
  await pausa(page, 300, 700);
  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 500, 900);
  await inputPlaca.press('Tab');
  await pausa(page, 1500, 2600);

  // Validar ng-valid
  await esperarNgValid(page, '[formcontrolname="formNroPlaca"]', 15000);

  return { placa: placaNormalizada };
}

// ─────────────────────────────────────────────
// SECCIÓN 4: TRÁMITE
// ─────────────────────────────────────────────

async function seleccionarTramite(page, tramite) {
  const valor = normalizarTexto(tramite);
  if (!valor) throw new Error('El trámite es obligatorio');
  await seleccionarOpcionMatSelect(page, '[formcontrolname="formTramite"]', valor);
  await pausa(page, 1200, 2200);
  return valor;
}

// ─────────────────────────────────────────────
// SECCIÓN 5: CLASIFICACIÓN
// ─────────────────────────────────────────────

async function seleccionarClasificacion(page, clasificacion) {
  const valor = normalizarTexto(clasificacion);
  if (!valor) return null;

  const selectClasificacion = page.locator('[formcontrolname="formClasificacion"]').first();
  const existe = await selectClasificacion.count();
  if (!existe) return null;

  await seleccionarOpcionMatSelect(page, '[formcontrolname="formClasificacion"]', valor);
  await pausa(page, 1200, 2200);
  return valor;
}

// ─────────────────────────────────────────────
// SECCIÓN 6: TARIFA AUTOMÁTICA
// ─────────────────────────────────────────────

/**
 * Después de seleccionar trámite + clasificación, RUNT reacciona:
 *   - AUTOMOVIL / MOTO / MOTOCARRO → muestra mat-select de tarifa con la opción combinada
 *   - MEDIDAS CAUTELARES          → muestra SweetAlert "¿Desea continuar?"
 */
async function resolverTarifa(page, tramite, clasificacion) {
  await pausa(page, 2000, 3500); // Esperar a que Angular procese

  const clasifNormalizada = normalizarMayus(clasificacion);

  // ── Caso MEDIDAS CAUTELARES: SweetAlert ──
  if (clasifNormalizada === 'MEDIDAS CAUTELARES') {
    const manejado = await manejarSweetAlert(page, 'Continuar', 10000);
    if (manejado) {
      return { tipo: 'sweetalert', tarifa: null, descripcion: 'Sin tarifa (continuar SweetAlert)' };
    }
    // Si no apareció SweetAlert, caemos al flujo normal (raro pero posible)
  }

  // ── Tarifa vía mat-select ──
  const selectTarifa = page.locator('[formcontrolname="formTarifaAplicar"]').first();
  const existe = await selectTarifa.count();
  if (!existe) {
    // Ni SweetAlert ni tarifa select — puede que la tabla ya apareció
    return { tipo: 'ninguna', tarifa: null, descripcion: 'Sin tarifa requerida' };
  }

  // Construir el texto de la opción según el combo
  const tramiteNorm = normalizarTexto(tramite).toUpperCase();
  let opcionTexto;
  if (tramiteNorm.includes('MATRÍCULA INICIAL') || tramiteNorm.includes('MATRICULA INICIAL')) {
    opcionTexto = `Tramite matricula inicial ${clasifNormalizada}`;
  } else if (tramiteNorm.includes('INSCRIPCIÓN ALERTA') || tramiteNorm.includes('INSCRIPCION ALERTA')) {
    opcionTexto = `Tramite inscripción alerta ${clasifNormalizada}`;
  } else {
    // Fallback: tomar la primera opción disponible
    const opciones = await selectTarifa.locator('mat-option, .mat-option-text').allTextContents();
    opcionTexto = opciones[0] || '';
  }

  await seleccionarOpcionMatSelect(page, '[formcontrolname="formTarifaAplicar"]', opcionTexto);
  await pausa(page, 1500, 2500);

  return { tipo: 'select', tarifa: opcionTexto, descripcion: opcionTexto };
}

// ─────────────────────────────────────────────
// SECCIÓN 7: VALIDACIÓN TABLA
// ─────────────────────────────────────────────

async function leerTablaTramites(page) {
  let filas = page.locator('table tbody tr');
  let total = await filas.count();

  if (total === 0) {
    filas = page.locator('.table tbody tr, mat-table tbody tr, [role="row"]');
    total = await filas.count();
  }
  if (total === 0) return [];

  const data = [];
  for (let i = 0; i < total; i++) {
    const fila = filas.nth(i);
    const columnas = fila.locator('td');
    const cantidad = await columnas.count();
    if (cantidad === 0) continue;

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

function validarTramitesLiquidables(tramitesTabla) {
  if (!tramitesTabla || tramitesTabla.length === 0) {
    throw new Error(
      'No se encontraron trámites liquidables en la tabla. ' +
      'Verifique los datos ingresados.'
    );
  }
}

// ─────────────────────────────────────────────
// SECCIÓN 8: GENERAR PDF (API INTERCEPTION)
// ─────────────────────────────────────────────

async function generarYCapturarPDF(page) {
  ensureDownloadDir();

  // Esperar botón Generar habilitado
  const boton = page.locator('button:has-text("Generar")').first();
  await boton.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => {
      const botones = Array.from(document.querySelectorAll('button'));
      const generar = botones.find(b => b.textContent.trim().toLowerCase().startsWith('generar'));
      if (!generar) return false;
      return !generar.disabled &&
             !generar.classList.contains('ng-invalid') &&
             !generar.getAttribute('aria-disabled');
    },
    { timeout: 15000 }
  );

  const disabled = await boton.isDisabled().catch(() => true);
  if (disabled) {
    throw new Error('El botón Generar está deshabilitado. Verifique los campos obligatorios.');
  }

  await pausa(page, 1000, 2000);

  // Interceptar la respuesta de la API REST (el PDF viene como base64 en el JSON)
  const responsePromise = page.waitForResponse(
    resp => resp.url().includes('/liquidacion/generar') && resp.status() === 200,
    { timeout: 60000 }
  );

  await boton.click();
  await pausa(page, 1500, 3000);

  const response = await responsePromise;
  const data = await response.json();

  if (!data.archivoLiquidacion) {
    throw new Error('El API no devolvió archivoLiquidacion (base64)');
  }

  // Decodificar base64 a PDF
  const base64Data = data.archivoLiquidacion;
  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.length === 0) {
    throw new Error('El PDF decodificado está vacío');
  }

  const timestamp = Date.now();
  const fileName = `liquidacion_${timestamp}.pdf`;
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  fs.writeFileSync(filePath, buffer);

  return {
    fileName,
    filePath,
    tamanoBytes: buffer.length,
    liquidacionId: data.liquidacion || null,
    apiResponse: {
      liquidacion: data.liquidacion || null,
      mensaje: data.mensaje || null,
      multiliquidacion: data.multiliquidacion || null
    }
  };
}

// ─────────────────────────────────────────────
// SECCIÓN 9: ACEPTAR SWEETALERT ÉXITO
// ─────────────────────────────────────────────

async function aceptarSweetAlertExito(page) {
  await manejarSweetAlert(page, 'Aceptar', 15000);
}

// ─────────────────────────────────────────────
// PREPARACIÓN PÁGINA
// ─────────────────────────────────────────────

async function prepararPagina(page) {
  const urlActual = page.url();
  if (!urlActual.includes('/#/recaudosliquidaciones/liquidar-tramite')) {
    await page.goto(URL_RUNT, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await pausa(page, 2500, 4000);
}

// ─────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────

/**
 * Ejecuta el flujo completo de liquidación RUNT para RNA.
 *
 * @param {Object} options
 * @param {string} options.placa         - Placa del vehículo
 * @param {string} options.tramite       - "TRÁMITE MATRÍCULA INICIAL" | "TRÁMITE INSCRIPCIÓN ALERTA"
 * @param {string} options.clasificacion - AUTOMOVIL | MEDIDAS CAUTELARES | MOTO | MOTOCARRO
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   mensaje?: string,
 *   error?: string,
 *   data?: {
 *     registro: string,
 *     tipoDocumentoSolicitante, numeroDocumentoSolicitante, nombreSolicitante,
 *     placa, tramite, clasificacion,
 *     tarifa: { tipo, tarifa, descripcion } | null,
 *     tramitesTabla: Array,
 *     descarga: { fileName, filePath, tamanoBytes, liquidacionId, apiResponse }
 *   }
 * }>}
 */
async function scrapeLiquidacionTramite({
  registro,  // Se ignora — siempre RNA
  placa,
  tramite,
  clasificacion,
  ...rest   // Ignoramos tipoDocumento, numeroDocumento, tarifa
}) {
  let page = null;

  try {
    const session = await connectToChrome();
    page = session.page;

    // ── Navegación ──
    await prepararPagina(page);

    // ── 1) Solicitante ──
    const datosSolicitante = await diligenciarSolicitante(page);

    // ── 2) RNA ──
    await seleccionarRegistroRNA(page);

    // ── 3) Placa ──
    const datosPlaca = await procesarPlaca(page, placa);

    // ── 4) Trámite ──
    const tramiteSeleccionado = await seleccionarTramite(page, tramite);

    // ── 5) Clasificación ──
    const clasificacionSeleccionada = await seleccionarClasificacion(page, clasificacion);

    // ── 6) Tarifa automática (según combo trámite + clasificación) ──
    const tarifaResultado = await resolverTarifa(page, tramiteSeleccionado, clasificacionSeleccionada);

    // ── 7) Leer tabla de trámites ──
    await pausa(page, 2000, 3000);
    const tramitesTabla = await leerTablaTramites(page);
    validarTramitesLiquidables(tramitesTabla);

    // ── 8) Generar y capturar PDF por API ──
    const descarga = await generarYCapturarPDF(page);

    // ── 9) Aceptar SweetAlert de éxito ──
    await aceptarSweetAlertExito(page);

    return {
      ok: true,
      mensaje: 'Liquidación generada correctamente',
      data: {
        registro: 'RNA',
        ...datosSolicitante,
        ...datosPlaca,
        tramite: tramiteSeleccionado,
        clasificacion: clasificacionSeleccionada,
        tarifa: tarifaResultado,
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
    // No cerramos la sesión de Chrome
  }
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  scrapeLiquidacionTramite
};
