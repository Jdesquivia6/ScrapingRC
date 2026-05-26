/**
 * Scraper de liquidaciones RUNT — SOLO RNA
 *
 * Flujo real paso a paso replicando RUNT "Liquidar Trámite":
 *   1) Diligenciar solicitante (NIT + 901769233 → nombre automático)
 *   2) Seleccionar registro RNA
 *   3) Doble digitación de placa
 *   4) Para cada trámite en el array:
 *      a) Seleccionar trámite (MATRICULA INICIAL | INSCRIPCIÓN ALERTA)
 *      b) Si es el primero: seleccionar clasificación (AUTOMOVIL | MEDIDAS CAUTELARES | MOTO | MOTOCARRO)
 *         Si es subsiguiente: la clasificación ya está seleccionada
 *      c) Tarifa automática según combo trámite + clasificación
 *         - Con SweetAlert para MEDIDAS CAUTELARES
 *   5) Click Generar → interceptar API /liquidacion/generar → capturar PDF (base64)
 *   6) Aceptar SweetAlert de éxito
 *
 * Todos los trámites comparten la misma clasificación (flujo RUNT real).
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

async function pausa(page, min = 300, max = 800) {
  await page.waitForTimeout(random(min, max));
}

// ─────────────────────────────────────────────
// HELPERS DE ESPERA ANGULAR/MATERIAL
// ─────────────────────────────────────────────

/**
 * Espera que un elemento sea visible y no esté deshabilitado.
 * NO verifica ng-invalid porque Angular lo pone en campos requeridos vacíos (normal).
 */
async function esperarElementoHabilitado(page, selector, timeout = 25000) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout });
  // Solo verificar disabled real, no ng-invalid (Angular pone ng-invalid en campos vacíos)
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      if (el.disabled) return false;
      if (el.getAttribute('aria-disabled') === 'true') return false;
      return true;
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
  await pausa(page, 150, 300);
}

// ─────────────────────────────────────────────
// INTERACCIÓN CON FORMULARIOS
// ─────────────────────────────────────────────

async function seleccionarOpcionMatSelect(page, selector, textoOpcion) {
  const valor = normalizarTexto(textoOpcion);
  if (!valor) return;

  await esperarElementoHabilitado(page, selector);
  await pausa(page, 300, 600);

  // Click para abrir el panel
  const select = page.locator(selector).first();
  await select.click();
  await pausa(page, 400, 900);

  // Esperar que aparezca al menos un mat-option (el panel se abrió)
  const opciones = page.locator('mat-option, .mat-option-text');
  try {
    await opciones.first().waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    // Si no aparecen opciones, el select puede estar vacío o bloqueado
    // Intentar cerrar el panel haciendo click fuera
    await page.mouse.click(10, 10);
    throw new Error(`No aparecieron opciones en ${selector} al seleccionar "${valor}"`);
  }

  await pausa(page, 200, 400);

  // Buscar opción por texto exacto o parcial
  let opcion = page.locator('mat-option').filter({ hasText: valor }).first();
  if (await opcion.count() && await opcion.isVisible().catch(() => false)) {
    await pausa(page, 150, 300);
    await opcion.click();
    await esperarCierreOverlaysMatSelect(page);
    return;
  }

  // Fallback: buscar por .mat-option-text
  const opcionTexto = page.locator('.mat-option-text').filter({ hasText: valor }).first();
  if (await opcionTexto.count() && await opcionTexto.isVisible().catch(() => false)) {
    await pausa(page, 150, 300);
    await opcionTexto.click();
    await esperarCierreOverlaysMatSelect(page);
    return;
  }

  throw new Error(`Opción "${valor}" no encontrada en ${selector}`);
}

async function escribirLento(locator, valor) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.fill('');
  for (const ch of String(valor)) {
    await locator.type(ch, { delay: random(50, 110) });
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
async function manejarSweetAlert(page, textoBoton = 'Continuar', timeout = 20000) {
  try {
    // Intentar con .swal2-popup.swal2-show
    let swal = page.locator('.swal2-popup.swal2-show');
    let visible = false;
    try {
      await swal.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });
      visible = true;
    } catch {
      // Fallback: .swal2-popup sin .swal2-show
      swal = page.locator('.swal2-popup');
      try {
        await swal.waitFor({ state: 'visible', timeout: Math.min(timeout, 10000) });
        visible = true;
      } catch {
        // No apareció SweetAlert con ningún selector
        return false;
      }
    }

    if (!visible) return false;

    await pausa(page, 400, 800);

    // Buscar botón por texto
    const btn = swal.locator('button').filter({ hasText: textoBoton }).first();
    if (await btn.count()) {
      await pausa(page, 300, 600);
      await btn.click();
      await pausa(page, 900, 1600);
      return true;
    }

    // Fallback: cualquier button.confirm o button:first-of-type
    const btnFallback = swal.locator('button.swal2-confirm, button:first-of-type').first();
    if (await btnFallback.count()) {
      await pausa(page, 300, 600);
      await btnFallback.click();
      await pausa(page, 900, 1600);
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
  await pausa(page, 300, 600);

  // Estrategia 1: Tab
  await inputDocumento.press('Tab');
  await pausa(page, 700, 1400);
  let nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) return nombre;

  // Estrategia 2: click fuera
  await page.mouse.click(80, 80);
  await pausa(page, 800, 1500);
  nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) return nombre;

  // Estrategia 3: Tab otra vez
  await inputDocumento.click();
  await pausa(page, 300, 500);
  await inputDocumento.press('Tab');
  await pausa(page, 1000, 1800);
  nombre = await nombreInput.inputValue().catch(() => '');
  return nombre;
}

async function diligenciarSolicitante(page) {
  await seleccionarOpcionMatSelect(
    page,
    '[formcontrolname="formTipoDocumento"]',
    SOLICITANTE_TIPO_DOCUMENTO
  );
  await pausa(page, 400, 800);

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
    await pausa(page, 700, 1400);
  } catch {
    // Si falla, probablemente ya está en RNA
    await pausa(page, 300, 600);
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
  await pausa(page, 300, 600);
  await inputPlaca.press('Tab');
  await pausa(page, 700, 1400);

  // ── Digitación 2 (confirmación RUNT) ──
  await inputPlaca.click();
  await pausa(page, 200, 500);
  await inputPlaca.fill('');
  await pausa(page, 200, 500);
  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 300, 600);
  await inputPlaca.press('Tab');
  await pausa(page, 900, 1600);

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
  await pausa(page, 700, 1400);
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
  await pausa(page, 700, 1400);
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
  const clasifNormalizada = normalizarMayus(clasificacion);

  // ── Caso MEDIDAS CAUTELARES: SweetAlert ──
  if (clasifNormalizada === 'MEDIDAS CAUTELARES') {
    // Esperar primero que Angular procese el cambio de clasificación
    await pausa(page, 2000, 3500);

    // Primer intento de SweetAlert
    let manejado = await manejarSweetAlert(page, 'Continuar', 12000);

    // Segundo intento si falló (puede que SweetAlert tarde en aparecer)
    if (!manejado) {
      console.log('[scraper] Reintentando SweetAlert (MEDIDAS CAUTELARES)...');
      await pausa(page, 1500, 3000);
      manejado = await manejarSweetAlert(page, 'Continuar', 12000);
    }

    if (manejado) {
      console.log('[scraper] SweetAlert MEDIDAS CAUTELARES manejado');
      return { tipo: 'sweetalert', tarifa: null, descripcion: 'Sin tarifa (continuar SweetAlert)' };
    }

    // Si SweetAlert no apareció, la tarifa puede no ser necesaria
    console.log('[scraper] No se detectó SweetAlert, continuando sin tarifa');
    return { tipo: 'ninguna', tarifa: null, descripcion: 'Sin tarifa (SweetAlert no detectado)' };
  }

  // ── Para otras clasificaciones: esperar a que Angular procese ──
  await pausa(page, 1200, 2000);

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
  await pausa(page, 900, 1600);

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

  // Esperar botón Generar visible y habilitado
  const boton = page.locator('button:has-text("Generar")').first();
  await boton.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () => {
      const botones = Array.from(document.querySelectorAll('button'));
      const generar = botones.find(b => b.textContent.trim().toLowerCase().startsWith('generar'));
      if (!generar) return false;
      return !generar.disabled && generar.getAttribute('aria-disabled') !== 'true';
    },
    { timeout: 20000 }
  );

  const disabled = await boton.isDisabled().catch(() => true);
  if (disabled) {
    throw new Error('El botón Generar está deshabilitado. Verifique los campos obligatorios.');
  }

  await pausa(page, 600, 1200);

  // Interceptar la respuesta de la API REST (el PDF viene como base64 en el JSON)
  const responsePromise = page.waitForResponse(
    resp => resp.url().includes('/liquidacion/generar') && resp.status() === 200,
    { timeout: 60000 }
  );

  await boton.click();
  await pausa(page, 800, 1500);

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
    archivoLiquidacion: base64Data,
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
  await pausa(page, 1500, 2500);
}

// ─────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────

/**
 * Ejecuta el flujo completo de liquidación RUNT para RNA.
 * Soporta múltiples trámites en una sola liquidación.
 *
 * @param {Object} options
 * @param {string} options.placa         - Placa del vehículo
 * @param {Array<{tramite: string, clasificacion: string}>} options.tramites
 *   - Array de trámites a liquidar (1 o 2 elementos)
 *   - Ej: [{ tramite: "TRÁMITE MATRÍCULA INICIAL", clasificacion: "AUTOMOVIL" },
 *           { tramite: "TRÁMITE INSCRIPCIÓN ALERTA", clasificacion: "AUTOMOVIL" }]
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   mensaje?: string,
 *   error?: string,
 *   data?: {
 *     registro: string,
 *     tipoDocumentoSolicitante, numeroDocumentoSolicitante, nombreSolicitante,
 *     placa,
 *     tramites: Array<{tramite, clasificacion, tarifa}>,
 *     tramitesTabla: Array,
 *     descarga: { fileName, filePath, tamanoBytes, liquidacionId, apiResponse }
 *   }
 * }>}
 */
async function scrapeLiquidacionTramite({
  registro,  // Se ignora — siempre RNA
  placa,
  tramites,  // Array de {tramite, clasificacion}
  ...rest   // Ignoramos tipoDocumento, numeroDocumento, tarifa
}) {
  let page = null;

  try {
    const session = await connectToChrome();
    page = session.page;
    console.log('[scraper] Sesión Chrome obtenida');

    if (!tramites || !Array.isArray(tramites) || tramites.length === 0) {
      throw new Error('Debe enviar al menos un trámite en el array "tramites"');
    }

    console.log(`[scraper] Procesando ${tramites.length} trámite(s):`,
      tramites.map(t => `${t.tramite} (${t.clasificacion})`).join(', '));

    // ── Navegación ──
    await prepararPagina(page);
    console.log('[scraper] Página cargada');

    // ── 1) Solicitante ──
    console.log('[scraper] Diligenciando solicitante...');
    const datosSolicitante = await diligenciarSolicitante(page);
    console.log('[scraper] Solicitante OK:', datosSolicitante.nombreSolicitante);

    // ── 2) RNA ──
    console.log('[scraper] Seleccionando registro RNA...');
    await seleccionarRegistroRNA(page);

    // ── 3) Placa ──
    console.log('[scraper] Procesando placa...');
    const datosPlaca = await procesarPlaca(page, placa);
    console.log('[scraper] Placa OK:', datosPlaca.placa);

    // ── 4) Iterar sobre cada trámite ──
    const tramitesProcesados = [];
    let primeraClasificacion = null;

    for (let i = 0; i < tramites.length; i++) {
      const { tramite, clasificacion } = tramites[i];
      console.log(`[scraper] === Trámite ${i + 1}/${tramites.length}: ${tramite} ===`);

      // ── 4a) Seleccionar trámite ──
      console.log(`[scraper] Seleccionando trámite...`);
      const tramiteSeleccionado = await seleccionarTramite(page, tramite);
      console.log(`[scraper] Trámite OK: ${tramiteSeleccionado}`);

      // ── 4b) Seleccionar clasificación (solo la primera vez, luego RUNT la mantiene) ──
      let clasificacionSeleccionada = null;
      if (i === 0) {
        console.log(`[scraper] Seleccionando clasificación: ${clasificacion}...`);
        clasificacionSeleccionada = await seleccionarClasificacion(page, clasificacion);
        primeraClasificacion = clasificacionSeleccionada;
        console.log(`[scraper] Clasificación OK: ${clasificacionSeleccionada}`);
      } else {
        // La clasificación ya está seleccionada del trámite anterior
        clasificacionSeleccionada = primeraClasificacion;
        console.log(`[scraper] Clasificación ya seleccionada: ${clasificacionSeleccionada}`);
        await pausa(page, 600, 1200);
      }

      // ── 4c) Tarifa automática (según combo trámite + clasificación) ──
      console.log(`[scraper] Resolviendo tarifa...`);
      const tarifaResultado = await resolverTarifa(page, tramiteSeleccionado, clasificacionSeleccionada);
      console.log(`[scraper] Tarifa OK:`, JSON.stringify(tarifaResultado));

      tramitesProcesados.push({
        tramite: tramiteSeleccionado,
        clasificacion: clasificacionSeleccionada,
        tarifa: tarifaResultado
      });

      // Pausa entre trámites para que Angular procese la tabla
      await pausa(page, 900, 1800);
    }

    // ── 5) Leer tabla de trámites ──
    await pausa(page, 1200, 2000);
    const tramitesTabla = await leerTablaTramites(page);
    console.log('[scraper] Tabla filas:', tramitesTabla.length);
    validarTramitesLiquidables(tramitesTabla);

    // ── 6) Generar y capturar PDF por API ──
    console.log('[scraper] Generando PDF...');
    const descarga = await generarYCapturarPDF(page);
    console.log('[scraper] PDF OK:', descarga.fileName, descarga.tamanoBytes + ' bytes');

    // ── 7) Aceptar SweetAlert de éxito ──
    await aceptarSweetAlertExito(page);
    console.log('[scraper] SweetAlert éxito aceptado');

    return {
      ok: true,
      mensaje: 'Liquidación generada correctamente',
      data: {
        registro: 'RNA',
        ...datosSolicitante,
        ...datosPlaca,
        tramites: tramitesProcesados,
        tramitesTabla,
        descarga
      }
    };
  } catch (error) {
    // Capturar screenshot para debug
    try {
      if (page) {
        const screenshotPath = path.join(DOWNLOAD_DIR, `error_liquidacion_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log('[scraper] Screenshot guardado:', screenshotPath);
      }
    } catch (_) { /* ignore screenshot errors */ }

    console.log('[scraper] ERROR:', error.message);
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
