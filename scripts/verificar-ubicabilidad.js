'use strict';
/**
 * Verificación de regresión del módulo ubicabilidad-personas.
 *
 * Uso:
 *   node scripts/verificar-ubicabilidad.js
 *
 * Es SOLO LECTURA: no inserta ni borra nada. Llama a los controllers reales
 * con un req/res simulado, así que prueba la SQL tal cual la construye el
 * endpoint (numerado de parámetros, JOIN, filtros), no una copia.
 *
 * Sale con código 1 si alguna prueba falla.
 */
require('dotenv').config();

const pool = require('../utils/db');
const ctrl = require('../controllers/ubicabilidadPersonas.controller');

// Debe coincidir con ORIGENES_MODULO del controller.
const ORIGENES_MODULO = ['CARGADO_POR_EXCEL', 'API_CONTRAVENCIONES', 'API_TEST'];

let pasadas = 0;
let fallidas = 0;

function ok(cond, nombre, detalle) {
  if (cond) {
    pasadas++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallidas++;
    console.log(`  ✗ ${nombre}`);
    if (detalle !== undefined) console.log(`      ${detalle}`);
  }
}

/** Llama a un handler Express con req/res simulados y devuelve la respuesta. */
function llamar(handler, query) {
  return new Promise((resolve, reject) => {
    const req = { query: query || {}, params: {}, body: {}, user: {} };
    const res = {
      json: (body) => resolve({ status: 200, body }),
      status(code) {
        return { json: (body) => resolve({ status: code, body }) };
      }
    };
    try {
      Promise.resolve(handler(req, res)).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function contar(sql, params) {
  const r = await pool.query(sql, params || []);
  return Number(r.rows[0].n);
}

async function main() {
  const cliente = await pool.connect();

  try {
    // ---------------------------------------------------------------
    console.log('\n[1] Integridad de direccion_encontrada');
    // ---------------------------------------------------------------
    const inconsistentes = await contar(`
      SELECT COUNT(*)::int AS n
      FROM persona_natural_propietario
      WHERE direccion_encontrada = TRUE AND fk_direcciones IS NULL
    `);
    ok(
      inconsistentes === 0,
      'ninguna persona marcada "encontrada" sin dirección asociada',
      `quedaron ${inconsistentes} fila(s) inconsistentes`
    );

    const vaciasEnviadas = await contar(`
      SELECT COUNT(*)::int AS n
      FROM persona_natural_propietario
      WHERE enviado_externo = TRUE AND fk_direcciones IS NULL
    `);
    ok(
      vaciasEnviadas === 0,
      'ninguna persona enviada al externo sin dirección',
      `${vaciasEnviadas} fila(s) enviadas con dirección vacía`
    );

    const moduleConDireccion = await contar(`
      SELECT COUNT(*)::int AS n
      FROM persona_natural_propietario
      WHERE direccion_consultada = TRUE AND direccion_encontrada = TRUE
        AND origen_registro = ANY($1::text[])
    `, [ORIGENES_MODULO]);
    const moduleReferenciadas = await contar(`
      SELECT COUNT(*)::int AS n
      FROM persona_natural_propietario
      WHERE direccion_consultada = TRUE AND direccion_encontrada = TRUE
        AND fk_direcciones IS NOT NULL
        AND origen_registro = ANY($1::text[])
    `, [ORIGENES_MODULO]);
    ok(
      moduleConDireccion === moduleReferenciadas,
      '"con dirección" del módulo == filas con fk_direcciones',
      `${moduleConDireccion} vs ${moduleReferenciadas}`
    );

    // ---------------------------------------------------------------
    console.log('\n[2] listarHistorial — filtro de origen');
    // ---------------------------------------------------------------
    const esperadoModulo = await contar(`
      SELECT COUNT(DISTINCT numero_documento)::int AS n
      FROM persona_natural_propietario
      WHERE direccion_consultada = TRUE
        AND origen_registro = ANY($1::text[])
    `, [ORIGENES_MODULO]);

    const defecto = await llamar(ctrl.listarHistorial, {});
    ok(defecto.status === 200 && defecto.body.ok, 'sin ?origen responde 200/ok',
      JSON.stringify(defecto.body).slice(0, 200));
    ok(
      defecto.body.total === esperadoModulo,
      `por defecto lista solo los orígenes del módulo (${esperadoModulo})`,
      `devolvió ${defecto.body.total}`
    );

    const scrapingEsperado = await contar(`
      SELECT COUNT(DISTINCT numero_documento)::int AS n
      FROM persona_natural_propietario
      WHERE direccion_consultada = TRUE AND origen_registro = 'SCRAPING'
    `);
    const scraping = await llamar(ctrl.listarHistorial, { origen: 'SCRAPING' });
    ok(scraping.status === 200 && scraping.body.ok, '?origen=SCRAPING responde 200/ok');
    ok(
      scraping.body.total === scrapingEsperado,
      `?origen=SCRAPING lista los ${scrapingEsperado}`,
      `devolvió ${scraping.body.total}`
    );
    ok(
      scrapingEsperado !== esperadoModulo || scrapingEsperado === 0,
      'el origen explícito cambia el resultado respecto al defecto'
    );

    // El LIMIT es la parte delicada: el placeholder se renumera.
    const conLimite = await llamar(ctrl.listarHistorial, { limit: '5' });
    ok(conLimite.status === 200 && conLimite.body.ok,
      'con ?limit=5 no revienta (renumeración de placeholders)',
      JSON.stringify(conLimite.body).slice(0, 200));
    ok(
      (conLimite.body.results || []).length <= 5,
      'con ?limit=5 devuelve máximo 5 filas',
      `devolvió ${(conLimite.body.results || []).length}`
    );

    const conAmbos = await llamar(ctrl.listarHistorial, { origen: 'API_CONTRAVENCIONES', limit: '3' });
    ok(conAmbos.status === 200 && conAmbos.body.ok,
      '?origen + ?limit juntos responden 200/ok',
      JSON.stringify(conAmbos.body).slice(0, 200));

    // ---------------------------------------------------------------
    console.log('\n[3] listarResultados — JOIN de dirección y estados');
    // ---------------------------------------------------------------
    const todo = await llamar(ctrl.listarResultados, {});
    ok(todo.status === 200 && todo.body.ok, 'sin filtros responde 200/ok',
      JSON.stringify(todo.body).slice(0, 200));

    const totalEsperado = await contar(`
      SELECT COUNT(*)::int AS n
      FROM persona_natural_propietario
      WHERE origen_registro = ANY($1::text[])
    `, [ORIGENES_MODULO]);
    ok(
      todo.body.data.pagination.total === totalEsperado,
      `total por defecto = filas de los orígenes del módulo (${totalEsperado})`,
      `devolvió ${todo.body.data.pagination.total}`
    );

    const conDireccionVisible = (todo.body.data.results || [])
      .filter((r) => r.direccion_encontrada && r.direccion);
    ok(
      (todo.body.data.results || []).every((r) => Object.prototype.hasOwnProperty.call(r, 'direccion')),
      'cada fila expone el campo direccion (LEFT JOIN aplicado)',
      'falta la propiedad "direccion" en al menos una fila'
    );
    ok(conDireccionVisible.length > 0 || totalEsperado === 0,
      'hay filas con dirección real visible en la primera página',
      `filas con dirección: ${conDireccionVisible.length}`);

    // Partición de estados: deben sumar el total sin solaparse.
    const estados = ['CONSULTADA', 'SIN_DIRECCION', 'ERROR', 'PENDIENTE'];
    const conteos = {};
    let suma = 0;
    for (const estado of estados) {
      const r = await llamar(ctrl.listarResultados, { estado });
      conteos[estado] = r.body.data.pagination.total;
      suma += conteos[estado];
    }
    console.log(`      ${JSON.stringify(conteos)}`);
    ok(
      suma === totalEsperado,
      'los 4 estados particionan el total sin solaparse',
      `${suma} != ${totalEsperado}`
    );
    ok(conteos.PENDIENTE === 0 || conteos.PENDIENTE === totalEsperado ||
       conteos.PENDIENTE < totalEsperado, 'PENDIENTE coherente');

    const origenParam = await llamar(ctrl.listarResultados, { origen: 'SCRAPING' });
    const scrapingTodo = await contar(
      `SELECT COUNT(*)::int AS n FROM persona_natural_propietario WHERE origen_registro = 'SCRAPING'`
    );
    ok(
      origenParam.body.data.pagination.total === scrapingTodo,
      `?origen=SCRAPING lista los ${scrapingTodo}`,
      `devolvió ${origenParam.body.data.pagination.total}`
    );

    // ---------------------------------------------------------------
    console.log('\n[4] Envío externo — nada de personas sin dirección');
    // ---------------------------------------------------------------
    const pendientesApi = await cliente.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE fk_direcciones IS NOT NULL)::int AS con_direccion
      FROM persona_natural_propietario
      WHERE direccion_consultada = TRUE
        AND direccion_encontrada = TRUE
        AND origen_registro LIKE 'API_%'
    `);
    const fila = pendientesApi.rows[0];
    ok(
      fila.total === fila.con_direccion,
      'todo lo elegible para envío tiene dirección real',
      `${fila.total} elegibles / ${fila.con_direccion} con fk_direcciones`
    );
    console.log(`      elegibles para enviar: ${fila.total}`);
  } finally {
    cliente.release();
    await pool.end();
  }

  console.log(`\nResultado: ${pasadas} pasaron, ${fallidas} fallaron.`);
  process.exit(fallidas > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nERROR FATAL:', err.message);
  process.exit(1);
});
