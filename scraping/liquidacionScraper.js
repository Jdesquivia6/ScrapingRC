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
// TIMER PARA MEDICIÓN DE RENDIMIENTO
// ─────────────────────────────────────────────

async function medirTiempo(label, fn) {
  const inicio = Date.now();
  console.log(`[scraper] [START] ${label}`);
  try {
    const resultado = await fn();
    const duracion = Date.now() - inicio;
    console.log(`[scraper] [END] ${label} | ${duracion}ms (${(duracion / 1000).toFixed(1)}s)`);
    return resultado;
  } catch (error) {
    const duracion = Date.now() - inicio;
    console.log(`[scraper] [FAIL] ${label} | ${duracion}ms (${(duracion / 1000).toFixed(1)}s) | ${error.message}`);
    throw error;
  }
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
  // Si no hay overlay activo, no esperar
  const hayOverlay = await page.evaluate(() => {
    return document.querySelectorAll('.cdk-overlay-pane, .cdk-overlay-backdrop').length > 0;
  });
  if (!hayOverlay) {
    await pausa(page, 50, 100);
    return;
  }

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
    { timeout: 3000 }
  );
  await pausa(page, 50, 100);
}

// ─────────────────────────────────────────────
// INTERACCIÓN CON FORMULARIOS
// ─────────────────────────────────────────────

/**
 * Oculta tooltips persistentes de Angular Material que pueden interceptar clicks.
 */
async function ocultarTooltipsPersistentes(page) {
  try {
    const hayTooltip = await page.evaluate(() => {
      return document.querySelectorAll('.mat-tooltip-show, .mat-tooltip-handled').length > 0;
    });
    if (!hayTooltip) return;

    await page.mouse.move(10, 10);
    await page.evaluate(() => {
      document.querySelectorAll('.mat-tooltip-show, .mat-tooltip-handled').forEach(t => {
        t.classList.remove('mat-tooltip-show', 'mat-tooltip-handled');
        t.style.opacity = '0';
        t.style.pointerEvents = 'none';
      });
    });
    await pausa(page, 80, 150);
  } catch (_) {
    // Si falla, continuar de todos modos
  }
}

async function seleccionarOpcionMatSelect(page, selector, textoOpcion) {
  const valor = normalizarTexto(textoOpcion);
  if (!valor) return;
  const inicioTotal = Date.now();
  const marcas = [];
  const marcar = (paso) => {
    marcas.push({ paso, t: Date.now() - inicioTotal });
  };

  try {
    await cerrarSweetAlertsInesperados(page);
    marcar('cerrarSweetAlerts');

    await ocultarTooltipsPersistentes(page);
    marcar('ocultarTooltips');

    await esperarElementoHabilitado(page, selector, 12000);
    marcar('esperarHabilitado');
    await pausa(page, 100, 200);

    // Click para abrir el panel (JS click evita espera de estabilidad de Playwright)
    const select = page.locator(selector).first();
    await select.evaluate(el => el.click());
    marcar('clickSelect');
    await pausa(page, 100, 200);

    // Esperar que aparezca al menos un mat-option (el panel se abrió)
    const opciones = page.locator('.cdk-overlay-pane mat-option, .cdk-overlay-pane .mat-option-text');
    try {
      await opciones.first().waitFor({ state: 'visible', timeout: 5000 });
      marcar('waitForOpciones');
    } catch {
      await page.mouse.click(10, 10);
      throw new Error(`No aparecieron opciones en ${selector} al seleccionar "${valor}"`);
    }

    await pausa(page, 80, 150);

    // Buscar opción por texto exacto o parcial
    const optionSelector = `.cdk-overlay-pane mat-option`;
    let opcion = page.locator(optionSelector).filter({ hasText: valor }).first();
    if (await opcion.count() && await opcion.isVisible().catch(() => false)) {
      await opcion.evaluate(el => el.click());
      marcar('clickOpcion');
      await esperarCierreOverlaysMatSelect(page);
      marcar('cerrarOverlay');
      const duracion = Date.now() - inicioTotal;
      console.log(`[scraper] [TIME] seleccionarOpcionMatSelect("${valor}") | ${duracion}ms | ${JSON.stringify(marcas)}`);
      return;
    }

    // Fallback: buscar por .mat-option-text
    const opcionTexto = page.locator('.cdk-overlay-pane .mat-option-text').filter({ hasText: valor }).first();
    if (await opcionTexto.count() && await opcionTexto.isVisible().catch(() => false)) {
      await opcionTexto.evaluate(el => el.click());
      marcar('clickOpcionTexto');
      await esperarCierreOverlaysMatSelect(page);
      marcar('cerrarOverlay');
      const duracion = Date.now() - inicioTotal;
      console.log(`[scraper] [TIME] seleccionarOpcionMatSelect("${valor}") | ${duracion}ms | ${JSON.stringify(marcas)}`);
      return;
    }

    throw new Error(`Opción "${valor}" no encontrada en ${selector}`);
  } catch (error) {
    const duracion = Date.now() - inicioTotal;
    console.error(`[scraper] [TIME] seleccionarOpcionMatSelect("${valor}") FAIL | ${duracion}ms | ${JSON.stringify(marcas)} | ${error.message}`);
    throw error;
  }
}

async function escribirLento(locator, valor) {
  await locator.waitFor({ state: 'visible', timeout: 8000 });
  await locator.click();
  await locator.fill('');
  for (const ch of String(valor)) {
    await locator.type(ch, { delay: random(15, 30) });
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
      await swal.waitFor({ state: 'visible', timeout: Math.min(timeout, 6000) });
      visible = true;
    } catch {
      // Fallback: .swal2-popup sin .swal2-show
      swal = page.locator('.swal2-popup');
      try {
        await swal.waitFor({ state: 'visible', timeout: Math.min(timeout, 6000) });
        visible = true;
      } catch {
        // No apareció SweetAlert con ningún selector
        return false;
      }
    }

    if (!visible) return false;

    await pausa(page, 100, 200);

    // Buscar botón por texto
    const btn = swal.locator('button').filter({ hasText: textoBoton }).first();
    if (await btn.count()) {
      await pausa(page, 80, 150);
      await btn.click();
      await pausa(page, 250, 450);
      return true;
    }

    // Fallback: cualquier button.confirm o button:first-of-type
    const btnFallback = swal.locator('button.swal2-confirm, button:first-of-type').first();
    if (await btnFallback.count()) {
      await pausa(page, 80, 150);
      await btnFallback.click();
      await pausa(page, 250, 450);
      return true;
    }

    return false;
  } catch {
    return false; // No apareció SweetAlert
  }
}

/**
 * Cierra SweetAlerts inesperados que bloquean la interfaz.
 * Verifica rápidamente si existe uno visible antes de intentar cerrarlo.
 */
async function cerrarSweetAlertsInesperados(page) {
  try {
    const existe = await page.evaluate(() => {
      const popup = document.querySelector('.swal2-popup');
      if (!popup) return false;
      const style = window.getComputedStyle(popup);
      return style.display !== 'none' && parseFloat(style.opacity) > 0;
    });
    if (existe) {
      await manejarSweetAlert(page, 'Aceptar', 2000);
    }
  } catch (_) {
    // Ignorar si no hay SweetAlert
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
  await pausa(page, 200, 400);

  // Estrategia 1: Tab
  await inputDocumento.press('Tab');
  await pausa(page, 500, 900);
  let nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) return nombre;

  // Estrategia 2: click fuera
  await page.mouse.click(80, 80);
  await pausa(page, 600, 1000);
  nombre = await nombreInput.inputValue().catch(() => '');
  if (nombre && nombre.trim()) return nombre;

  // Estrategia 3: Tab otra vez
  await inputDocumento.click();
  await pausa(page, 200, 400);
  await inputDocumento.press('Tab');
  await pausa(page, 700, 1200);
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
// FECHA LIQUIDACIÓN
// ─────────────────────────────────────────────

async function diligenciarFecha(page, fecha) {
  if (!fecha) return;

  const selectores = [
    '[formcontrolname="formFechaLiquidacion"]',
    '[formcontrolname="fechaLiquidacion"]',
    '[formcontrolname="formFecha"]',
    'input[type="date"]'
  ];

  // Convertir YYYY-MM-DD a DD/MM/AAAA para el datepicker de Angular
  const partesFecha = fecha.split('-');
  const fechaFormateada = `${partesFecha[2]}/${partesFecha[1]}/${partesFecha[0]}`;

  for (const selector of selectores) {
    const input = page.locator(selector).first();
    const existe = await input.count();
    if (!existe) continue;

    await input.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    const visible = await input.isVisible().catch(() => false);
    if (!visible) continue;

    const valorActual = await input.inputValue().catch(() => '');
    if (valorActual && valorActual.includes(partesFecha[0])) {
      console.log(`[scraper] Fecha liquidación ya tiene valor, saltando`);
      return;
    }

    const isReadonly = await input.getAttribute('readonly').catch(() => null);

    if (isReadonly === 'true' || isReadonly === '') {
      // Campo readonly → abrir datepicker con click y escribir en el popup
      await input.click();
      await pausa(page, 100, 200);

      // Buscar el input del datepicker popup que suele aparecer
      const popupInput = page.locator('mat-datepicker-content input, .mat-datepicker-content input').first();
      try {
        await popupInput.waitFor({ state: 'visible', timeout: 1500 });
        await popupInput.fill('');
        await popupInput.type(fechaFormateada, { delay: 15 });
        await pausa(page, 80, 150);
        // Cerrar el popup con Tab o click fuera
        await input.press('Tab');
        await pausa(page, 80, 150);
        console.log(`[scraper] Fecha liquidación OK (readonly): ${fechaFormateada} (selector: ${selector})`);
        return;
      } catch {
        // Si no aparece el popup, intentar hacer click fuera para cerrar
        await page.mouse.click(10, 10);
        console.log(`[scraper] Fecha liquidación: popup no apareció, saltando (selector: ${selector})`);
        return;
      }
    } else {
      // Campo editable → usar fill directo
      await input.fill('');
      await input.fill(fechaFormateada);
      await pausa(page, 100, 200);
      console.log(`[scraper] Fecha liquidación OK: ${fechaFormateada} (selector: ${selector})`);
      return;
    }
  }
  console.log('[scraper] No se encontró campo de fecha en el formulario RUNT');
}

// ─────────────────────────────────────────────
// SECCIÓN 2: REGISTRO RNA
// ─────────────────────────────────────────────

async function seleccionarRegistroRNA(page) {
  // Puede que ya esté preseleccionado (readonly), lo intentamos por si acaso
  try {
    await seleccionarOpcionMatSelect(page, '[formcontrolname="formRegistro"]', 'RNA');
    await pausa(page, 400, 800);
  } catch {
    // Si falla, probablemente ya está en RNA
    await pausa(page, 200, 400);
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
  await inputPlaca.waitFor({ state: 'visible', timeout: 8000 });

  // ── Digitación 1 ──
  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 80, 150);
  await inputPlaca.press('Tab');
  await pausa(page, 200, 350);

  // ── Digitación 2 (confirmación RUNT) ──
  await escribirLento(inputPlaca, placaNormalizada);
  await pausa(page, 80, 150);
  await inputPlaca.press('Tab');
  await pausa(page, 250, 400);

  // Log de diagnóstico
  const valorFinal = await inputPlaca.inputValue().catch(() => '');
  console.log(`[scraper] Placa digitada: "${valorFinal}"`);

  // Validar ng-valid
  await esperarNgValid(page, '[formcontrolname="formNroPlaca"]', 8000);

  return { placa: placaNormalizada };
}

// ─────────────────────────────────────────────
// SECCIÓN 4: TRÁMITE
// ─────────────────────────────────────────────

async function seleccionarTramite(page, tramite) {
  const valor = normalizarTexto(tramite);
  if (!valor) throw new Error('El trámite es obligatorio');
  await seleccionarOpcionMatSelect(page, '[formcontrolname="formTramite"]', valor);
  await pausa(page, 400, 800);
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
  await pausa(page, 400, 800);
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

  // ── Caso MEDIDAS CAUTELARES: tarifa auto-seleccionada ──
  if (clasifNormalizada === 'MEDIDAS CAUTELARES') {
    // No hay SweetAlert — la tarifa se coloca automáticamente abajo al seleccionar la clasificación.
    // Solo esperamos que Angular procese y seguimos para que Generar funcione.
    console.log('[scraper] MEDIDAS CAUTELARES: tarifa automática, sin SweetAlert');
    await pausa(page, 1500, 2500);
    return { tipo: 'auto', tarifa: null, descripcion: 'Tarifa automática MEDIDAS CAUTELARES' };
  }

  // ── Para otras clasificaciones: esperar a que Angular procese ──
  await pausa(page, 700, 1200);

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
  await pausa(page, 400, 800);

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

  await pausa(page, 400, 700);

  // Interceptar la respuesta de la API REST (el PDF viene como base64 en el JSON)
  const responsePromise = page.waitForResponse(
    resp => resp.url().includes('/liquidacion/generar') && resp.status() === 200,
    { timeout: 60000 }
  );

  await boton.click();
  await pausa(page, 500, 900);

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
  const inicio = Date.now();
  try {
    // Versión rápida para el SweetAlert de éxito final
    const btn = page.locator('.swal2-popup.swal2-show button.swal2-confirm, .swal2-popup button.swal2-confirm').first();
    await btn.waitFor({ state: 'visible', timeout: 4000 });
    await btn.evaluate(el => el.click());
    await pausa(page, 100, 200);
    const duracion = Date.now() - inicio;
    console.log(`[scraper] [TIME] aceptarSweetAlertExito | ${duracion}ms`);
  } catch {
    // Fallback al manejador general si no aparece rápido
    await manejarSweetAlert(page, 'Aceptar', 8000);
  }
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
  await cerrarSweetAlertsInesperados(page);
  await pausa(page, 800, 1300);
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
  fechaLiquidacion,  // Fecha en formato YYYY-MM-DD (opcional)
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

    const inicioTotal = Date.now();

    // ── Navegación ──
    await medirTiempo('Preparar página', () => prepararPagina(page));
    console.log('[scraper] Página cargada');

    // ── 1) Solicitante ──
    const datosSolicitante = await medirTiempo('Diligenciar solicitante', () => diligenciarSolicitante(page));
    console.log('[scraper] Solicitante OK:', datosSolicitante.nombreSolicitante);

    // ── 1b) Fecha liquidación ──
    await medirTiempo('Diligenciar fecha', () => diligenciarFecha(page, fechaLiquidacion));

    // ── 2) RNA ──
    await medirTiempo('Seleccionar RNA', () => seleccionarRegistroRNA(page));

    // ── 3) Placa ──
    const datosPlaca = await medirTiempo('Procesar placa', () => procesarPlaca(page, placa));
    console.log('[scraper] Placa OK:', datosPlaca.placa);

    // ── 4) Iterar sobre cada trámite ──
    const tramitesProcesados = [];
    let primeraClasificacion = null;

    for (let i = 0; i < tramites.length; i++) {
      const { tramite, clasificacion } = tramites[i];
      console.log(`[scraper] === Trámite ${i + 1}/${tramites.length}: ${tramite} ===`);

      // Cerrar cualquier SweetAlert residual antes de continuar
      await cerrarSweetAlertsInesperados(page);

      // ── 4a) Seleccionar trámite ──
      const tramiteSeleccionado = await medirTiempo(`Seleccionar trámite ${i + 1}`, () => seleccionarTramite(page, tramite));
      console.log(`[scraper] Trámite OK: ${tramiteSeleccionado}`);

      // ── 4b) Seleccionar clasificación (solo la primera vez, luego RUNT la mantiene) ──
      let clasificacionSeleccionada = null;
      if (i === 0) {
        clasificacionSeleccionada = await medirTiempo('Seleccionar clasificación', () => seleccionarClasificacion(page, clasificacion));
        primeraClasificacion = clasificacionSeleccionada;
        console.log(`[scraper] Clasificación OK: ${clasificacionSeleccionada}`);
      } else {
        // La clasificación ya está seleccionada del trámite anterior
        clasificacionSeleccionada = primeraClasificacion;
        console.log(`[scraper] Clasificación ya seleccionada: ${clasificacionSeleccionada}`);
        await pausa(page, 300, 600);
      }

      // ── 4c) Tarifa automática (según combo trámite + clasificación) ──
      const tarifaResultado = await medirTiempo('Resolver tarifa', () => resolverTarifa(page, tramiteSeleccionado, clasificacionSeleccionada));
      console.log(`[scraper] Tarifa OK:`, JSON.stringify(tarifaResultado));

      tramitesProcesados.push({
        tramite: tramiteSeleccionado,
        clasificacion: clasificacionSeleccionada,
        tarifa: tarifaResultado
      });

      // Pausa entre trámites para que Angular procese la tabla
      await pausa(page, 500, 900);
      await cerrarSweetAlertsInesperados(page);
    }

    // ── 5) Leer tabla de trámites (con retry para MEDIDAS CAUTELARES) ──
    let tramitesTabla = await medirTiempo('Leer tabla de trámites', async () => {
      await pausa(page, 700, 1200);
      let tabla = await leerTablaTramites(page);
      console.log('[scraper] Tabla filas:', tabla.length);

      // Si la tabla está vacía y es MEDIDAS CAUTELARES, esperar más (Angular tarda en auto-colocar tarifa)
      if (tabla.length === 0 && primeraClasificacion && primeraClasificacion.includes('MEDIDAS CAUTELARES')) {
        console.log('[scraper] Tabla vacía con MEDIDAS CAUTELARES — esperando más tiempo para que Angular procese...');
        await pausa(page, 2500, 4000);
        tabla = await leerTablaTramites(page);
        console.log('[scraper] Tabla filas (retry):', tabla.length);
      }
      return tabla;
    });

    validarTramitesLiquidables(tramitesTabla);

    // ── 6) Generar y capturar PDF por API ──
    const descarga = await medirTiempo('Generar y capturar PDF', () => generarYCapturarPDF(page));
    console.log('[scraper] PDF OK:', descarga.fileName, descarga.tamanoBytes + ' bytes');

    // ── 7) Aceptar SweetAlert de éxito ──
    await medirTiempo('Aceptar SweetAlert éxito', () => aceptarSweetAlertExito(page));
    console.log('[scraper] SweetAlert éxito aceptado');

    const total = Date.now() - inicioTotal;
    console.log(`[scraper] [TOTAL] Liquidación completada en ${total}ms (${(total / 1000).toFixed(1)}s)`);

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
