const { connectToChrome } = require('./connectToChrome');
const pool = require('../utils/db');

const URL = 'https://runtpro.runt.gov.co/#/rna-vehiculos-por-ident/consulta-vehiculo-por-ident/consulta';

function random(min = 700, max = 1700) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function delay(page, min = 700, max = 1700) {
  await page.waitForTimeout(random(min, max));
}

function normalizarPlaca(placa) {
  return String(placa || '').trim().toUpperCase();
}

function limpiarTexto(valor) {
  if (valor === undefined || valor === null) return null;

  const texto = String(valor).trim();

  return texto.length ? texto : null;
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

    return indicadores.some((item) => texto.includes(item));

  } catch (error) {
    return false;
  }
}

function respuestaSesionVencida(placaNormalizada) {
  return {
    ok: false,
    placa: placaNormalizada,
    sessionExpired: true,
    error: 'Sesión RUNT vencida. Deteniendo proceso para evitar datos corruptos.'
  };
}

async function cerrarOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await delay(page, 300, 700);

  await page.evaluate(() => {
    document.querySelectorAll('.cdk-overlay-container, mat-tooltip-component')
      .forEach(el => {
        el.style.pointerEvents = 'none';
      });
  }).catch(() => {});
}

async function clearAndTypeSlow(locator, value, page) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });

  await cerrarOverlays(page);

  await locator.scrollIntoViewIfNeeded();

  await delay(page, 300, 700);

  try {
    await locator.click({ force: true, timeout: 5000 });

    await locator.press('Control+A');
    await locator.press('Backspace');

    for (const ch of String(value)) {
      await locator.type(ch, {
        delay: random(90, 160)
      });
    }

  } catch (error) {
    console.log('⚠️ No se pudo escribir con teclado, usando JS directo');

    await locator.evaluate((input, val) => {
      input.focus();

      input.value = val;

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));

    }, String(value));
  }

  await delay(page, 500, 900);
}

async function scrollFuerteHastaAbajo(page) {
  await delay(page, 500, 900);

  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);

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
  });

  await page.mouse.wheel(0, 5000);

  await delay(page, 800, 1400);

  await page.mouse.wheel(0, 5000);

  await delay(page, 800, 1400);
}

async function cancelarBusquedaSiExiste(page) {
  try {
    await scrollFuerteHastaAbajo(page);

    const botonesCancelar = page.locator('button', {
      hasText: 'Cancelar'
    });

    const total = await botonesCancelar.count();

    if (total === 0) {
      console.log('ℹ️ No hay botones Cancelar en pantalla');
      return false;
    }

    const botonCancelar = botonesCancelar.nth(total - 1);

    await botonCancelar.scrollIntoViewIfNeeded();

    await delay(page, 700, 1300);

    await botonCancelar.click({ force: true });

    await delay(page, 1800, 2800);

    console.log('↩️ Se presionó Cancelar para nueva consulta');

    return true;

  } catch (error) {
    console.log('ℹ️ No se pudo presionar Cancelar:', error.message);

    return false;
  }
}

async function escribirPlaca(page, placa) {
  const placaNormalizada = normalizarPlaca(placa);

  const inputPlaca = page
    .locator('input[formcontrolname="placa"]')
    .first();

  await inputPlaca.waitFor({
    state: 'visible',
    timeout: 15000
  });

  console.log('⌨️ Escribiendo placa:', placaNormalizada);

  await clearAndTypeSlow(inputPlaca, placaNormalizada, page);

  await delay(page, 500, 900);

  await inputPlaca.press('Tab').catch(async () => {
    await page.keyboard.press('Tab');
  });

  await delay(page, 800, 1300);

  const valorFinal = normalizarPlaca(
    await inputPlaca.inputValue().catch(() => '')
  );

  console.log('📌 Valor final en input:', valorFinal);

  if (valorFinal !== placaNormalizada) {
    throw new Error(
      `La placa no quedó correctamente escrita. Esperada: ${placaNormalizada}, encontrada: ${valorFinal}`
    );
  }

  return true;
}

async function clickBuscar(page) {
  const botonBuscar = page
    .locator('button', { hasText: 'Buscar' })
    .first();

  await botonBuscar.waitFor({
    state: 'visible',
    timeout: 15000
  });

  const disabled = await botonBuscar
    .isDisabled()
    .catch(() => false);

  if (disabled) {
    throw new Error('El botón Buscar está deshabilitado');
  }

  await delay(page, 700, 1400);

  await botonBuscar.click({ force: true });

  console.log('🔎 Se hizo clic en Buscar');
}

async function esperarRespuestaDatosVehiculo(page) {
  const response = await page.waitForResponse(async resp => {
    try {
      if (resp.status() !== 200) return false;

      const url = resp.url();

      const posible =
        url.includes('vehiculo') ||
        url.includes('Vehiculo') ||
        url.includes('rna') ||
        url.includes('RNA') ||
        url.includes('consulta');

      if (!posible) return false;

      const contentType = resp.headers()['content-type'] || '';

      if (!contentType.includes('application/json')) return false;

      const json = await resp.json().catch(() => null);

      return Boolean(
        json &&
        json.datos &&
        json.datos.placaNumeroUnicoIdentificacion
      );

    } catch (error) {
      return false;
    }

  }, { timeout: 45000 });

  return response;
}

async function obtenerTextoAlerta(page) {
  const alerta = page
    .locator('.swal2-popup.swal2-show')
    .first();

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
    const alerta = page
      .locator('.swal2-popup.swal2-show')
      .first();

    if (!(await alerta.isVisible({ timeout: 3000 }).catch(() => false))) {
      return null;
    }

    const texto = await obtenerTextoAlerta(page);

    const btnAceptar = page
      .locator('button.swal2-confirm', {
        hasText: 'Aceptar'
      })
      .first();

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

async function guardarErrorDatosVehiculo({
  id_consul_placa,
  errorMessage
}) {
  try {
    await pool.query(`
      INSERT INTO runt_datos_vehiculos (
        fk_consul_placa,
        estado_consulta,
        error_consulta,
        data
      ) VALUES ($1,$2,$3,$4)
    `, [
      id_consul_placa,
      false,
      errorMessage,
      {}
    ]);
  } catch (dbError) {
    console.error('❌ Error guardando fallo datos vehículo:', dbError.message);
  }
}

exports.scrapeDatosVehiculo = async ({
  placa,
  id_consul_placa
}) => {

  const { page } = await connectToChrome();

  const client = await pool.connect();

  const placaNormalizada = normalizarPlaca(placa);

  try {
    console.log('======================================');
    console.log('Consultando datos vehículo:', placaNormalizada);

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    await delay(page, 2500, 4000);

    await cancelarBusquedaSiExiste(page);

    await escribirPlaca(page, placaNormalizada);

    const responsePromise = esperarRespuestaDatosVehiculo(page)
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
      return respuestaSesionVencida(placaNormalizada);
    }

    await delay(page, 2500, 4000);

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
        return respuestaSesionVencida(placaNormalizada);
      }

      await guardarErrorDatosVehiculo({
        id_consul_placa,
        errorMessage: textoAlerta
      });

      return {
        ok: false,
        placa: placaNormalizada,
        error: textoAlerta
      };
    }

    const resultadoRespuesta = await responsePromise;

    if (resultadoRespuesta.tipo !== 'data') {
      throw new Error(
        'No llegó respuesta JSON y tampoco apareció alerta visible'
      );
    }

    const data = resultadoRespuesta.data;

    console.log('✅ JSON datos vehículo capturado');

    const datos = data?.datos || null;

    if (!datos) {
      throw new Error(
        'La respuesta no contiene datos del vehículo'
      );
    }

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    await client.query('BEGIN');

    await client.query(`
      INSERT INTO runt_datos_vehiculos (
        clase,
        marca,
        linea,
        servicio,
        color,
        modelo,
        fk_consul_placa,
        data,
        estado_consulta,
        error_consulta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      limpiarTexto(datos.claseVehiculo),
      limpiarTexto(datos.marcaVehiculo),
      limpiarTexto(datos.lineaVehiculo),
      limpiarTexto(datos.servicio),
      limpiarTexto(datos.color),
      datos.modelo || null,
      id_consul_placa,
      data,
      true,
      null
    ]);

    await client.query('COMMIT');

    await page
      .waitForURL('**/resultados', { timeout: 10000 })
      .catch(() => {});

    await delay(page, 1500, 2500);

    await cancelarBusquedaSiExiste(page);

    return {
      ok: true,
      placa: placaNormalizada,

      datos_vehiculo: {
        clase: datos.claseVehiculo,
        marca: datos.marcaVehiculo,
        linea: datos.lineaVehiculo,
        servicio: datos.servicio,
        color: datos.color,
        modelo: datos.modelo
      },

      // DATA COMPLETA del RUNT (para guardar en DB)
      data: data,

      message: 'Datos del vehículo guardados correctamente'
    };

  } catch (error) {

    await client.query('ROLLBACK').catch(() => {});

    console.error('❌ Error datos vehículo:', error.message);

    await guardarErrorDatosVehiculo({
      id_consul_placa,
      errorMessage: error.message
    });

    await cancelarBusquedaSiExiste(page);

    return {
      ok: false,
      placa: placaNormalizada,
      error: error.message
    };

  } finally {
    client.release();
  }
};