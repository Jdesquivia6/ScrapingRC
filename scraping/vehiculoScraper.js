const axios = require('axios');
const { connectToChrome } = require('./connectToChrome');
const pool = require('../utils/db');
const { API_HIKVISION } = require('../config');

// Host del servicio externo de fotodetecciones
const EXTERNAL_API_URL = `http://${API_HIKVISION}:5051/v1/rest/api/vehiculo-scrapping/guardar`;

const URL = 'https://runtpro.runt.gov.co/#/rnfgestionsolicitud/consultar-vehiculo';

function random(min = 700, max = 1700) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function delay(page, min = 700, max = 1700) {
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

function normalizarPlaca(placa) {
  return String(placa || '').trim().toUpperCase();
}

function limpiarTexto(valor) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto.length ? texto : null;
}

function separarNombreCompleto(nombreCompleto) {
  const texto = String(nombreCompleto || '').trim().replace(/\s+/g, ' ');

  if (!texto) return { nombres: null, apellidos: null };

  const partes = texto.split(' ');

  if (partes.length === 1) {
    return { nombres: partes[0], apellidos: null };
  }

  if (partes.length === 2) {
    return { nombres: partes[0], apellidos: partes[1] };
  }

  if (partes.length === 3) {
    return {
      nombres: `${partes[0]} ${partes[1]}`,
      apellidos: partes[2]
    };
  }

  return {
    nombres: `${partes[0]} ${partes[1]}`,
    apellidos: partes.slice(2).join(' ')
  };
}

function extraerPropietario(data) {
  return (
    data?.listaPropietarios?.[0] ||
    data?.listaComparendos?.[0] ||
    data?.propietario ||
    null
  );
}

function extraerTipoDocumento(propietario) {
  return limpiarTexto(
    propietario?.tipoIdentidadPropietario ||
    propietario?.tipoDocumento ||
    propietario?.tipoIdentificacion ||
    propietario?.siglaTipoDocumento
  );
}

function extraerNumeroDocumento(propietario) {
  return limpiarTexto(
    propietario?.numeroIdentidadPropietario ||
    propietario?.numeroDocumento ||
    propietario?.identificacion ||
    propietario?.documento
  );
}

function extraerNombrePropietario(propietario) {
  return limpiarTexto(
    propietario?.nombrePropietario ||
    propietario?.nombreCompleto ||
    propietario?.nombre ||
    propietario?.razonSocial
  );
}

async function clearAndTypeSlow(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.press('Control+A');
  await locator.press('Backspace');

  for (const ch of String(value)) {
    await locator.type(ch, { delay: random(40, 70) });
  }
}

async function tabular(page) {
  await delay(page, 150, 350);
  await page.keyboard.press('Tab');
  await delay(page, 400, 700);
}

async function cancelarBusquedaSiExiste(page) {
  try {
    const botonCancelar = page.locator('button', { hasText: 'Cancelar' }).first();

    if (await botonCancelar.isVisible({ timeout: 4000 })) {
      await delay(page, 300, 600);
      await botonCancelar.click();
      await delay(page, 600, 1000);
      console.log('↩️ Se presionó Cancelar para limpiar la búsqueda');
    }
  } catch (error) {
    console.log('ℹ️ No se encontró botón Cancelar visible');
  }
}

async function escribirPlacaConFlujoCorrecto(page, placa) {
  const placaNormalizada = normalizarPlaca(placa);

  const input = page.locator('input[formcontrolname="campo"]').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });

  // Primer ingreso de placa
  console.log('⌨️ Escribiendo placa primer intento:', placaNormalizada);
  await clearAndTypeSlow(input, placaNormalizada);

  // Primer tab
  await tabular(page);

  // Volver a enfocar el input y confirmar placa
  await delay(page, 350, 600);

  const inputConfirmacion = page.locator('input[formcontrolname="campo"]').first();
  await inputConfirmacion.waitFor({ state: 'visible', timeout: 15000 });

  console.log('⌨️ Confirmando placa segundo intento:', placaNormalizada);
  await clearAndTypeSlow(inputConfirmacion, placaNormalizada);

  // Segundo tab
  await tabular(page);

  await delay(page, 500, 900);

  const valorFinal = normalizarPlaca(
    await inputConfirmacion.inputValue().catch(() => '')
  );

  if (valorFinal !== placaNormalizada) {
    throw new Error(
      `La placa no quedó correctamente registrada. Esperada: ${placaNormalizada}, encontrada: ${valorFinal}`
    );
  }

  return true;
}

async function clickBuscar(page) {
  const botonBuscar = page.locator('button', { hasText: 'Buscar' }).first();

  await botonBuscar.waitFor({ state: 'visible', timeout: 15000 });

  const disabled = await botonBuscar.isDisabled().catch(() => false);

  if (disabled) {
    throw new Error('El botón Buscar está deshabilitado');
  }

  await delay(page, 500, 900);
  await botonBuscar.click();

  console.log('🔎 Se hizo clic en Buscar');
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

    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

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

// ─────────────────────────────────────────────
// ENVÍO A SERVICIO EXTERNO (fotodetecciones)
// ─────────────────────────────────────────────

async function enviarAExterno(resultado) {
  if (!resultado || !resultado.ok) return;

  try {
    const body = {
      ok: true,
      total: 1,
      results: [
        {
          ok: true,
          placa: resultado.placa,
          tipoIdentificacionPropietario: resultado.tipo_identificacion_propietario || null,
          numeroIdentificacionPropietario: resultado.numero_identificacion_propietario || null,
          nombreRazonSocialPropietario: resultado.nombre_razon_social_propietario || null,
          fechaExpedicionTecno: resultado.fecha_expedicion_tecno || null,
          fechaVigenciaTecno: resultado.fecha_vigencia_tecno || null,
          fechaInicioVigenciaSoat: resultado.fecha_inicio_vigencia_soat || null,
          fechaVencimientoVigenciaSoat: resultado.fecha_vencimiento_vigencia_soat || null,
          message: resultado.message || 'Scraping y guardado exitoso'
        }
      ]
    };

    const resp = await axios.post(EXTERNAL_API_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log(`[enviarAExterno] ✅ Placa ${resultado.placa} enviada -> status ${resp.status}`);
  } catch (error) {
    // No crítico — no detiene el flujo principal
    console.error(`[enviarAExterno] ⚠️ Error enviando placa ${resultado.placa}: ${error.message}`);
  }
}

exports.scrapeVehiculo = async ({ placa, id_consul_placa }) => {
  const { page } = await connectToChrome();
  const client = await pool.connect();

  const placaNormalizada = normalizarPlaca(placa);

  try {
    console.log('======================================');
    console.log('Consultando placa:', placaNormalizada);

    const inicioDoc = Date.now();

    await medirTiempo('Navegar a RUNT + espera inicial', async () => {
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(page, 1200, 2000);
    });

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    // Limpiar búsqueda anterior si la pantalla quedó pegada
    await medirTiempo('Limpiar búsqueda anterior', () => cancelarBusquedaSiExiste(page));

    const responsePromise = page.waitForResponse(
      resp =>
        resp.url().includes('/RNFGestionSolicitudMS/consulta/vehiculo') &&
        resp.status() === 200,
      { timeout: 30000 }
    );

    // Flujo correcto:
    // placa -> tab -> placa -> tab -> buscar
    await medirTiempo('Escribir placa (doble intento)', () => escribirPlacaConFlujoCorrecto(page, placaNormalizada));

    await medirTiempo('Clic en Buscar', () => clickBuscar(page));

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    const { data } = await medirTiempo('Esperar respuesta RUNT', async () => {
      const response = await responsePromise;
      return { data: await response.json() };
    });

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    console.log('✅ Data capturada');

    const parsed = await medirTiempo('Parsear datos', () => {
      const propietario = extraerPropietario(data);

      const tipoDoc = extraerTipoDocumento(propietario);
      const numeroDoc = extraerNumeroDocumento(propietario);
      const nombreCompleto = extraerNombrePropietario(propietario);

      const { nombres, apellidos } = separarNombreCompleto(nombreCompleto);

      const celular = limpiarTexto(
        propietario?.celular ||
        propietario?.numeroCelular ||
        propietario?.telefonoCelular
      );

      const correo = limpiarTexto(
        propietario?.correo ||
        propietario?.correoElectronico ||
        propietario?.email
      );

      const tecno = data?.listaRtm?.[0] || null;
      const soat = data?.listaPolizas?.[0] || null;

      return { tipoDoc, numeroDoc, nombreCompleto, nombres, apellidos, celular, correo, tecno, soat };
    });

    const { tipoDoc, numeroDoc, nombreCompleto, nombres, apellidos, celular, correo, tecno, soat } = parsed;

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    // COMMENTED: El worker ahora maneja el guardado en DB
    // await client.query('BEGIN');
    // await client.query(`
    //   INSERT INTO runt_soat_tecno_propietario (
    //     tipo_identificacion_propietario,
    //     numero_identificacion_propietario,
    //     nombre_razon_social_propietario,
    //     fecha_expedicion_tecno,
    //     fecha_vigencia_tecno,
    //     fecha_inicio_vigencia_soat,
    //     fecha_vencimiento_vigencia_soat,
    //     fk_consul_placa,
    //     data
    //   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    // `, [
    //   tipoDoc,
    //   numeroDoc,
    //   nombreCompleto,
    //   tecno?.fechaExpedicion || null,
    //   tecno?.fechaVigencia || null,
    //   soat?.fechaInicio || null,
    //   soat?.fechaVencimiento || null,
    //   id_consul_placa,
    //   data
    // ]);

    // // await client.query(`
    // //   INSERT INTO persona_natural_propietario (
    //     tipo_documento,
    //     numero_documento,
    //     nombres,
    //     apellidos,
    //     estado_runt_persona,
    //     celular,
    //     correo,
    //     fk_consul_placa,
    //     direccion_consultada,
    //     direccion_encontrada,
    //     error_consulta_direccion,
    //     fecha_consulta_direccion
    //   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    // `, [
    //   tipoDoc,
    //   numeroDoc,
    //   nombres,
    //   apellidos,
    //   true,
    //   celular,
    //   correo,
    //   id_consul_placa,
    //   false,
    //   null,
    //   null,
    //   null
    // ]);

    // COMMENTED: El worker ahora maneja el guardado
    // await client.query(`
    //   UPDATE consultas_placas
    //   SET estado_consulta = true,
    //       fecha_consulta = NOW()
    //   WHERE id_consul_placa = $1
    // `, [id_consul_placa]);

    // await client.query('COMMIT');

    // Después de guardar correctamente, cancelar para limpiar la pantalla
    await medirTiempo('Limpiar pantalla (Cancelar)', () => cancelarBusquedaSiExiste(page));

    // Armar respuesta con toda la info
    const resultado = {
      ok: true,
      placa: placaNormalizada,

      // Datos parseados
      tipo_identificacion_propietario: tipoDoc,
      numero_identificacion_propietario: numeroDoc,
      nombre_razon_social_propietario: nombreCompleto,

      fecha_expedicion_tecno: tecno?.fechaExpedicion || null,
      fecha_vigencia_tecno: tecno?.fechaVigencia || null,

      fecha_inicio_vigencia_soat: soat?.fechaInicio || null,
      fecha_vencimiento_vigencia_soat: soat?.fechaVencimiento || null,

      // DATA COMPLETA del RUNT (para guardar en DB)
      data: data,

      message: 'Scraping y guardado exitoso'
    };

    // Enviar a servicio externo (fotodetecciones) — no bloqueante
    enviarAExterno(resultado);

    const totalMs = Date.now() - inicioDoc;
    console.log(`[scraper] [TOTAL] Placa ${placaNormalizada} | ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`);

    return resultado;

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    const totalMs = Date.now() - inicioDoc;
    console.error(`❌ Error scraping: ${error.message} | ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s)`);

    // Aunque falle, intentamos cancelar para que no quede pegado
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

// ─────────────────────────────────────────────
// BATCH: reuso de pestaña para múltiples placas
// ─────────────────────────────────────────────
// Conecta una sola vez a Chrome, navega una vez, y reutiliza la pestaña.
// Placa 1 incluye navegación completa; placas 2+ saltan goto + cancelar inicial.

exports.scrapeVehiculoBatch = async ({ placaItems }) => {
  const { page } = await connectToChrome();
  const resultados = [];

  try {
    console.log('======================================');
    console.log(`[BATCH] Consultando ${placaItems.length} placas...`);

    await medirTiempo('Navegar a RUNT (único)', async () => {
      await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(page, 1200, 2000);
    });

    if (await detectarSesionVencida(page)) {
      return placaItems.map(item => ({
        ok: false,
        placa: normalizarPlaca(item.placa),
        sessionExpired: true,
        error: 'Sesión RUNT vencida'
      }));
    }

    await cancelarBusquedaSiExiste(page);

    for (let i = 0; i < placaItems.length; i++) {
      const { placa } = placaItems[i];
      const placaNormalizada = normalizarPlaca(placa);
      const inicioDoc = Date.now();

      try {
        console.log('======================================');
        console.log(`[BATCH ${i + 1}/${placaItems.length}] Placa: ${placaNormalizada}`);

        if (await detectarSesionVencida(page)) {
          resultados.push(respuestaSesionVencida(placaNormalizada));
          break;
        }

        const responsePromise = page.waitForResponse(
          resp =>
            resp.url().includes('/RNFGestionSolicitudMS/consulta/vehiculo') &&
            resp.status() === 200,
          { timeout: 30000 }
        );

        await medirTiempo('Escribir placa (doble intento)', () =>
          escribirPlacaConFlujoCorrecto(page, placaNormalizada)
        );

        await medirTiempo('Clic en Buscar', () => clickBuscar(page));

        if (await detectarSesionVencida(page)) {
          resultados.push(respuestaSesionVencida(placaNormalizada));
          break;
        }

        const { data } = await medirTiempo('Esperar respuesta RUNT', async () => {
          const response = await responsePromise;
          return { data: await response.json() };
        });

        if (await detectarSesionVencida(page)) {
          resultados.push(respuestaSesionVencida(placaNormalizada));
          break;
        }

        console.log('✅ Data capturada');

        const parsed = await medirTiempo('Parsear datos', () => {
          const propietario = extraerPropietario(data);

          const tipoDoc = extraerTipoDocumento(propietario);
          const numeroDoc = extraerNumeroDocumento(propietario);
          const nombreCompleto = extraerNombrePropietario(propietario);

          const { nombres, apellidos } = separarNombreCompleto(nombreCompleto);

          const celular = limpiarTexto(
            propietario?.celular ||
            propietario?.numeroCelular ||
            propietario?.telefonoCelular
          );

          const correo = limpiarTexto(
            propietario?.correo ||
            propietario?.correoElectronico ||
            propietario?.email
          );

          const tecno = data?.listaRtm?.[0] || null;
          const soat = data?.listaPolizas?.[0] || null;

          return { tipoDoc, numeroDoc, nombreCompleto, nombres, apellidos, celular, correo, tecno, soat };
        });

        const { tipoDoc, numeroDoc, nombreCompleto, celular, correo, tecno, soat } = parsed;

        await cancelarBusquedaSiExiste(page);

        const resultado = {
          ok: true,
          placa: placaNormalizada,
          tipo_identificacion_propietario: tipoDoc,
          numero_identificacion_propietario: numeroDoc,
          nombre_razon_social_propietario: nombreCompleto,
          fecha_expedicion_tecno: tecno?.fechaExpedicion || null,
          fecha_vigencia_tecno: tecno?.fechaVigencia || null,
          fecha_inicio_vigencia_soat: soat?.fechaInicio || null,
          fecha_vencimiento_vigencia_soat: soat?.fechaVencimiento || null,
          data,
          message: 'Scraping y guardado exitoso'
        };

        enviarAExterno(resultado);
        resultados.push(resultado);

        const totalMs = Date.now() - inicioDoc;
        console.log(`[scraper] [TOTAL] Placa ${placaNormalizada} | ${totalMs}ms (${(totalMs / 1000).toFixed(1)}s) [BATCH]`);

      } catch (error) {
        console.error(`❌ Error scraping ${placaNormalizada}: ${error.message}`);
        await cancelarBusquedaSiExiste(page);
        resultados.push({
          ok: false,
          placa: placaNormalizada,
          error: error.message
        });
      }
    }

    return resultados;

  } finally {
    // No pool client needed — worker handles DB
  }
};