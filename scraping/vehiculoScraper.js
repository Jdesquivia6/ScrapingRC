const axios = require('axios');
const { connectToChrome } = require('./connectToChrome');
const pool = require('../utils/db');

// Host del servicio externo de fotodetecciones
const EXTERNAL_API_HOST = process.env.EXTERNAL_API_HOST || '84.247.165.214';
const LOCAL_API_HIKVISION = '10.10.20.106';
const EXTERNAL_API_URL = `http://${LOCAL_API_HIKVISION}:5051/v1/rest/api/vehiculo-scrapping/guardar`;

const URL = 'https://runtpro.runt.gov.co/#/rnfgestionsolicitud/consultar-vehiculo';

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
    await locator.type(ch, { delay: random(90, 160) });
  }
}

async function tabular(page) {
  await delay(page, 250, 600);
  await page.keyboard.press('Tab');
  await delay(page, 700, 1200);
}

async function cancelarBusquedaSiExiste(page) {
  try {
    const botonCancelar = page.locator('button', { hasText: 'Cancelar' }).first();

    if (await botonCancelar.isVisible({ timeout: 4000 })) {
      await delay(page, 500, 900);
      await botonCancelar.click();
      await delay(page, 1000, 1800);
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
  await delay(page, 600, 1000);

  const inputConfirmacion = page.locator('input[formcontrolname="campo"]').first();
  await inputConfirmacion.waitFor({ state: 'visible', timeout: 15000 });

  console.log('⌨️ Confirmando placa segundo intento:', placaNormalizada);
  await clearAndTypeSlow(inputConfirmacion, placaNormalizada);

  // Segundo tab
  await tabular(page);

  await delay(page, 900, 1600);

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

  await delay(page, 800, 1500);
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
          placa: resultado.placa,
          tipo_identificacion_propietario: resultado.tipo_identificacion_propietario || null,
          numero_identificacion_propietario: resultado.numero_identificacion_propietario || null,
          nombre_razon_social_propietario: resultado.nombre_razon_social_propietario || null,
          fecha_expedicion_tecno: resultado.fecha_expedicion_tecno || null,
          fecha_vigencia_tecno: resultado.fecha_vigencia_tecno || null,
          fecha_inicio_vigencia_soat: resultado.fecha_inicio_vigencia_soat || null,
          fecha_vencimiento_vigencia_soat: resultado.fecha_vencimiento_vigencia_soat || null,
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

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(page, 2000, 3500);

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    // Limpiar búsqueda anterior si la pantalla quedó pegada
    await cancelarBusquedaSiExiste(page);

    const responsePromise = page.waitForResponse(
      resp =>
        resp.url().includes('/RNFGestionSolicitudMS/consulta/vehiculo') &&
        resp.status() === 200,
      { timeout: 30000 }
    );

    // Flujo correcto:
    // placa -> tab -> placa -> tab -> buscar
    await escribirPlacaConFlujoCorrecto(page, placaNormalizada);

    await clickBuscar(page);

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    const response = await responsePromise;
    const data = await response.json();

    if (await detectarSesionVencida(page)) {
      return respuestaSesionVencida(placaNormalizada);
    }

    console.log('✅ Data capturada');

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
    await cancelarBusquedaSiExiste(page);

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

    return resultado;

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    console.error('❌ Error scraping:', error.message);

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