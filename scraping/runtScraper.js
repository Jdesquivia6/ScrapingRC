const { connectToChrome } = require('./connectToChrome');
const pool = require('../utils/db');
const fs = require('fs');
const path = require('path');

const URL = 'https://runtpro.runt.gov.co/#/consultar-direcciones-pn';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function random(min = 800, max = 2500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function delay(page, min = 800, max = 2500) {
  await page.waitForTimeout(random(min, max));
}

function limpiarTexto(valor) {
  if (valor === undefined || valor === null) return null;

  const texto = String(valor).trim();

  return texto.length ? texto : null;
}

function normalizarDocumento(documento) {
  return String(documento || '').trim();
}

function textoABooleanEstado(valor) {
  const texto = String(valor || '').trim().toLowerCase();

  if (['activo', 'activa', 'si', 'sí', 'true', '1'].includes(texto)) {
    return true;
  }

  if (['inactivo', 'inactiva', 'no', 'false', '0'].includes(texto)) {
    return false;
  }

  return null;
}

function armarNombres(item) {
  return limpiarTexto(
    [
      item.primerNombre,
      item.segundoNombre
    ].filter(Boolean).join(' ')
  );
}

function armarApellidos(item) {
  return limpiarTexto(
    [
      item.primerApellido,
      item.segundoApellido
    ].filter(Boolean).join(' ')
  );
}

function normalizarRespuestaDirecciones(data) {
  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.datos)) return data.datos;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.direcciones)) return data.direcciones;
  if (Array.isArray(data?.resultado)) return data.resultado;

  return [];
}

function elegirDireccionPrincipal(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const principal = items.find(item =>
    String(item.principal || '').trim().toUpperCase() === 'SI'
  );

  if (principal) return principal;

  const activa = items.find(item =>
    String(item.estadoDireccion || '').trim().toUpperCase() === 'ACTIVO'
  );

  if (activa) return activa;

  return items[0];
}

async function limpiarViewportEmulado(page) {
  try {
    const session = await page.context().newCDPSession(page);

    await session
      .send('Emulation.clearDeviceMetricsOverride')
      .catch(() => {});

    await session.detach().catch(() => {});

    console.log('🧹 Viewport/emulación limpiado');

  } catch (error) {
    console.log('ℹ️ No se pudo limpiar viewport emulado:', error.message);
  }
}

async function scrollArriba(page) {
  await page.evaluate(() => {
    const contenedores = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.querySelector('.mat-drawer-content'),
      document.querySelector('.mat-sidenav-content'),
      document.querySelector('.cdk-virtual-scroll-viewport'),
      document.querySelector('main'),
      document.querySelector('.content'),
      document.querySelector('.container')
    ].filter(Boolean);

    contenedores.forEach(el => {
      el.scrollTop = 0;
    });

    window.scrollTo(0, 0);
  }).catch(() => {});

  await delay(page, 400, 900);
}

async function scrollFuerteHastaAbajo(page) {
  await delay(page, 500, 900);

  await page.evaluate(() => {
    const posiblesContenedores = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      document.querySelector('.mat-drawer-content'),
      document.querySelector('.mat-sidenav-content'),
      document.querySelector('.cdk-virtual-scroll-viewport'),
      document.querySelector('main'),
      document.querySelector('.content'),
      document.querySelector('.container')
    ].filter(Boolean);

    posiblesContenedores.forEach(el => {
      el.scrollTop = el.scrollHeight;
    });

    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});

  await page.mouse.wheel(0, 5000).catch(() => {});
  await delay(page, 800, 1400);

  await page.mouse.wheel(0, 5000).catch(() => {});
  await delay(page, 800, 1400);
}

async function prepararCapturaSinRomperPantalla(page) {
  await limpiarViewportEmulado(page);

  await scrollArriba(page);

  // Baja para obligar a Angular/RUNT a renderizar la tabla inferior.
  await scrollFuerteHastaAbajo(page);

  await delay(page, 800, 1400);

  // Regresa arriba antes del fullPage.
  await scrollArriba(page);
}

async function detectarSesionVencida(page) {
  try {
    const url = page.url().toLowerCase();

    if (
      url.includes('login') ||
      url.includes('autenticacion') ||
      url.includes('authentication')
    ) {
      return true;
    }

    const bodyText = await page
      .locator('body')
      .innerText({ timeout: 5000 })
      .catch(() => '');

    const texto = bodyText.toLowerCase();

    const indicadores = [
      'sesión ha expirado',
      'sesion ha expirado',
      'sesión expirada',
      'sesion expirada',
      'su sesión ha finalizado',
      'su sesion ha finalizado',
      'tiempo de sesión',
      'tiempo de sesion',
      'iniciar sesión',
      'iniciar sesion',
      'usuario',
      'contraseña',
      'password'
    ];

    return indicadores.some(item => texto.includes(item));

  } catch {
    return false;
  }
}

function respuestaSesionVencida(documento) {
  return {
    ok: false,
    documento,
    sessionExpired: true,
    error: 'Sesión RUNT vencida. Deteniendo proceso para evitar datos corruptos.'
  };
}

async function cerrarOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await delay(page, 300, 700);

  await page.evaluate(() => {
    document
      .querySelectorAll('.cdk-overlay-container, mat-tooltip-component')
      .forEach(el => {
        el.style.pointerEvents = 'none';
      });
  }).catch(() => {});
}

async function humanClearAndType(page, selector, value) {
  const input = page.locator(selector).first();

  await input.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await cerrarOverlays(page);

  await input.scrollIntoViewIfNeeded();
  await delay(page, 300, 700);

  try {
    await input.click({ force: true, timeout: 5000 });

    await input.press('Control+A');
    await input.press('Backspace');

    for (const ch of String(value)) {
      await input.type(ch, {
        delay: random(80, 150)
      });
    }

  } catch {
    console.log('⚠️ No se pudo escribir con teclado, usando JS directo');

    await input.evaluate((el, val) => {
      el.focus();
      el.value = val;

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, String(value));
  }

  await delay(page, 500, 1200);
}

async function openTipoDocumentoSelect(page) {
  const campo = page.locator('mat-form-field', {
    hasText: 'Tipo de Documento'
  }).first();

  await campo.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await campo.click({ force: true });

  await page
    .locator('.cdk-overlay-pane mat-option')
    .first()
    .waitFor({ timeout: 10000 });
}

async function selectTipoDocumento(page, tipoDocumento) {
  await openTipoDocumentoSelect(page);

  await delay(page, 400, 1200);

  const opcion = page.locator('mat-option .mat-option-text', {
    hasText: tipoDocumento
  }).first();

  await opcion.waitFor({
    state: 'visible',
    timeout: 10000
  });

  await opcion.click({ force: true });

  await delay(page, 800, 1800);
}

async function clickBuscar(page) {
  const boton = page.locator('button[type="submit"]', {
    hasText: 'Buscar'
  }).first();

  await boton.waitFor({
    state: 'visible',
    timeout: 15000
  });

  await boton.scrollIntoViewIfNeeded();

  const disabled = await boton.isDisabled().catch(() => false);

  if (disabled) {
    throw new Error('El botón Buscar está deshabilitado');
  }

  await delay(page, 500, 1200);

  await boton.click({ force: true });

  console.log('🔎 Se hizo clic en Buscar');
}

async function obtenerTextoAlerta(page) {
  const alerta = page.locator('.swal2-popup.swal2-show').first();

  if (!(await alerta.isVisible({ timeout: 3000 }).catch(() => false))) {
    return null;
  }

  const texto = await page
    .locator('#swal2-html-container')
    .first()
    .innerText()
    .catch(() => 'Alerta sin texto');

  return limpiarTexto(texto);
}

async function aceptarAlertaSiExiste(page) {
  try {
    const alerta = page.locator('.swal2-popup.swal2-show').first();

    if (!(await alerta.isVisible({ timeout: 4000 }).catch(() => false))) {
      return null;
    }

    const texto = await obtenerTextoAlerta(page);

    const btnAceptar = page.locator('button.swal2-confirm', {
      hasText: 'Aceptar'
    }).first();

    await btnAceptar.waitFor({
      state: 'visible',
      timeout: 5000
    });

    await delay(page, 500, 900);

    await btnAceptar.click({ force: true });

    await delay(page, 1200, 2000);

    console.log('⚠️ Alerta aceptada:', texto);

    return texto;

  } catch (error) {
    console.log('ℹ️ No se pudo aceptar alerta:', error.message);
    return null;
  }
}

async function esperarRespuestaDireccionesPN(page, numeroDocumento) {
  const documento = normalizarDocumento(numeroDocumento);

  const response = await page.waitForResponse(async resp => {
    try {
      if (resp.status() !== 200) return false;

      const contentType = resp.headers()['content-type'] || '';

      if (!contentType.includes('application/json')) return false;

      const url = resp.url().toLowerCase();

      const posibleUrl =
        url.includes('direccion') ||
        url.includes('direcciones') ||
        url.includes('persona') ||
        url.includes('natural') ||
        url.includes('consultar') ||
        url.includes('runt');

      if (!posibleUrl) return false;

      const json = await resp.json().catch(() => null);

      const items = normalizarRespuestaDirecciones(json);

      if (!items.length) return false;

      return items.some(item =>
        String(item.numeroDocumento || '').trim() === documento
      );

    } catch {
      return false;
    }
  }, {
    timeout: 45000
  });

  return response;
}

async function takeScreenshot(page, screenshotsDir, filename) {
  ensureDir(screenshotsDir);

  const screenshotPath = path.join(screenshotsDir, filename);

  await prepararCapturaSinRomperPantalla(page);

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    animations: 'disabled'
  });

  await limpiarViewportEmulado(page);
  await scrollArriba(page);

  console.log('📸 Captura guardada:', screenshotPath);

  return screenshotPath;
}

async function prepararFormulario(page, tipoDocumento) {
  await limpiarViewportEmulado(page);
  await scrollArriba(page);

  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  if (await detectarSesionVencida(page)) {
    throw new Error('Sesión RUNT vencida');
  }

  await delay(page, 1800, 3200);

  await selectTipoDocumento(page, tipoDocumento);
}

async function obtenerOInsertarDireccion(client, item) {
  const direccion = limpiarTexto(item.direccion);
  const municipioDepartamento = limpiarTexto(item.municipio);
  const telefono = limpiarTexto(item.telefono || item.celular);
  const tipoDireccion = limpiarTexto(item.tipoDireccion);
  const estadoDireccion = textoABooleanEstado(item.estadoDireccion);
  const datoMigrado = limpiarTexto(item.direccionMigrada);

  const existente = await client.query(`
    SELECT id_direcciones
    FROM direcciones
    WHERE direccion IS NOT DISTINCT FROM $1
      AND municio_departamento IS NOT DISTINCT FROM $2
      AND telefono IS NOT DISTINCT FROM $3
      AND tipo_direccion IS NOT DISTINCT FROM $4
    LIMIT 1
  `, [
    direccion,
    municipioDepartamento,
    telefono,
    tipoDireccion
  ]);

  if (existente.rows.length > 0) {
    return existente.rows[0].id_direcciones;
  }

  // COMMENTED: El worker ahora maneja el guardado en DB
  // const insert = await client.query(`
  //   INSERT INTO direcciones (
  //     direccion,
  //     municio_departamento,
  //     telefono,
  //     tipo_direccion,
  //     estado_direccion,
  //     dato_migrado
  //   ) VALUES ($1,$2,$3,$4,$5,$6)
  //   RETURNING id_direcciones
  // `, [
  //   direccion,
  //   municipioDepartamento,
  //   telefono,
  //   tipoDireccion,
  //   estadoDireccion,
  //   datoMigrado
  // ]);

  // return insert.rows[0].id_direcciones;
  return null;
}

async function marcarDireccionConsultada({
  numeroDocumento,
  encontrada,
  errorMessage = null
}) {
  const documento = normalizarDocumento(numeroDocumento);

  const result = await pool.query(`
    UPDATE persona_natural_propietario
    SET
      direccion_consultada = TRUE,
      direccion_encontrada = $2,
      error_consulta_direccion = $3,
      fecha_consulta_direccion = CURRENT_TIMESTAMP,
      fecha_actualizacion = CURRENT_TIMESTAMP
    WHERE numero_documento = $1
    RETURNING id_per_natural_dir
  `, [
    documento,
    encontrada,
    errorMessage
  ]);

  return {
    updated: result.rows.length,
    documento,
    encontrada,
    errorMessage
  };
}

async function guardarDireccionPersona({
  numeroDocumento,
  rawData
}) {
  const client = await pool.connect();

  try {
    const documento = normalizarDocumento(numeroDocumento);
    const items = normalizarRespuestaDirecciones(rawData);
    const item = elegirDireccionPrincipal(items);

    if (!item) {
      return {
        saved: false,
        reason: 'La respuesta JSON no contiene direcciones'
      };
    }

    await client.query('BEGIN');

    const personas = await client.query(`
      SELECT id_per_natural_dir
      FROM persona_natural_propietario
      WHERE numero_documento = $1
      FOR UPDATE
    `, [documento]);

    if (personas.rows.length === 0) {
      await client.query('ROLLBACK');

      return {
        saved: false,
        reason: 'No existe persona_natural_propietario para ese número de documento'
      };
    }

    const idDireccion = await obtenerOInsertarDireccion(client, item);

    const nombres = armarNombres(item);
    const apellidos = armarApellidos(item);
    const tipoDocumento = limpiarTexto(item.tipoDocumento);
    const estadoPersona = textoABooleanEstado(item.estadoPersona);
    const celular = limpiarTexto(item.celular || item.telefono);
    const correo = limpiarTexto(item.correoElectronico);

    const update = await client.query(`
      UPDATE persona_natural_propietario
      SET
        tipo_documento = COALESCE(NULLIF(tipo_documento, ''), $2),
        nombres = COALESCE(NULLIF(nombres, ''), $3),
        apellidos = COALESCE(NULLIF(apellidos, ''), $4),
        estado_runt_persona = COALESCE(estado_runt_persona, $5),
        celular = COALESCE(NULLIF(celular, ''), $6),
        correo = COALESCE(NULLIF(correo, ''), $7),
        fk_direcciones = COALESCE(fk_direcciones, $8),
        direccion_consultada = TRUE,
        direccion_encontrada = TRUE,
        error_consulta_direccion = NULL,
        fecha_consulta_direccion = CURRENT_TIMESTAMP,
        fecha_actualizacion = CURRENT_TIMESTAMP
      WHERE numero_documento = $1
      RETURNING id_per_natural_dir, fk_consul_placa, fk_direcciones
    `, [
      documento,
      tipoDocumento,
      nombres,
      apellidos,
      estadoPersona,
      celular,
      correo,
      idDireccion
    ]);

    await client.query('COMMIT');

    return {
      saved: true,
      documento,
      idDireccion,
      personasActualizadas: update.rows.length,
      direccion: {
        direccion: limpiarTexto(item.direccion),
        municipio: limpiarTexto(item.municipio),
        telefono: limpiarTexto(item.telefono || item.celular),
        tipoDireccion: limpiarTexto(item.tipoDireccion),
        estadoDireccion: limpiarTexto(item.estadoDireccion),
        direccionMigrada: limpiarTexto(item.direccionMigrada)
      }
    };

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;

  } finally {
    client.release();
  }
}

exports.scrapeDireccionesPN = async ({
  tipoDocumento,
  numeroDocumento
}) => {
  const { page } = await connectToChrome();

  const documento = normalizarDocumento(numeroDocumento);

  try {
    console.log('======================================');
    console.log('Consultando direcciones PN:', documento);

    await prepararFormulario(page, tipoDocumento);

    await humanClearAndType(
      page,
      'input[formcontrolname="nroDocumento"]',
      documento
    );

    const responsePromise = esperarRespuestaDireccionesPN(page, documento)
      .then(async response => {
        const data = await response.json();

        return {
          tipo: 'data',
          data
        };
      })
      .catch(error => {
        return {
          tipo: 'timeout',
          error
        };
      });

    await clickBuscar(page);

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(documento);
    }

    await delay(page, 1800, 3000);

    const textoAlerta = await aceptarAlertaSiExiste(page);

    if (textoAlerta) {
      const alertaLower = textoAlerta.toLowerCase();

      const esSesion =
        alertaLower.includes('sesión') ||
        alertaLower.includes('sesion') ||
        alertaLower.includes('login') ||
        alertaLower.includes('autenticación') ||
        alertaLower.includes('autenticacion');

      if (esSesion) {
        return respuestaSesionVencida(documento);
      }

      const dbResult = await marcarDireccionConsultada({
        numeroDocumento: documento,
        encontrada: false,
        errorMessage: textoAlerta
      });

      return {
        ok: false,
        documento,
        noData: true,
        db: dbResult,
        error: textoAlerta,
        message: 'No se encontró información para el documento y se aceptó la alerta'
      };
    }

    const resultadoRespuesta = await responsePromise;
    // El .then() en esperarRespuestaDireccionesPN ya parseó el JSON
    const rawData = resultadoRespuesta.data;
    const items = normalizarRespuestaDirecciones(rawData);

    if (!items.length) {
      throw new Error('El JSON recibido no contiene datos de direcciones');
    }

    console.log('✅ JSON direcciones PN capturado');

    await delay(page, 1800, 3200);

    const screenshotsDir = path.join(__dirname, '../screenshots');

    const screenshotPath = await takeScreenshot(
      page,
      screenshotsDir,
      `runt-direcciones-${documento}.png`
    ).catch(error => {
      console.warn('⚠️ No se pudo guardar screenshot de éxito:', error.message);
      return null;
    });

    // NO guardar aquí - el worker centraliza el guardado en DB via guardar-resultado
    // El guardado en DB se hace en el worker via guardarResultadoScraping

    return {
      ok: true,
      tipoDocumento,
      numeroDocumento: documento,
      direcciones: items,
      totalDirecciones: items.length,
      data: items,
      screenshotPath,
      message: 'Consulta ejecutada correctamente'
    };

  } catch (error) {
    console.error('❌ Error direcciones PN:', error.message);

    const screenshotsDir = path.join(__dirname, '../screenshots');

    const screenshotPath = await takeScreenshot(
      page,
      screenshotsDir,
      `runt-direcciones-${documento}-error.png`
    ).catch(() => null);

    return {
      ok: false,
      tipoDocumento,
      numeroDocumento: documento,
      error: error.message,
      screenshotPath
    };
  }
};

exports.scrapeDireccionesPNBatch = async ({
  tipoDocumento,
  documentos
}) => {
  const results = [];

  for (const documentoOriginal of documentos) {
    const documento = normalizarDocumento(documentoOriginal);

    if (!documento) {
      results.push({
        documento: documentoOriginal,
        ok: false,
        error: 'Documento vacío'
      });
      continue;
    }

    const result = await exports.scrapeDireccionesPN({
      tipoDocumento,
      numeroDocumento: documento
    });

    results.push(result);

    if (result.sessionExpired) {
      break;
    }

    await new Promise(resolve =>
      setTimeout(resolve, random(2500, 6000))
    );
  }

  return results;
};
