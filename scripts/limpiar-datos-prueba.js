'use strict';
/**
 * Limpieza de datos de prueba del módulo ubicabilidad-personas
 * para dejar la base lista con datos reales.
 *
 * USO (siempre empieza en modo simulación):
 *   node scripts/limpiar-datos-prueba.js
 *   node scripts/limpiar-datos-prueba.js --confirmar
 *
 * QUÉ BORRA (esta ronda de pruebas):
 *   1. worker_jobs            -> 61 (20/10 - 22/10) + sus worker_job_items (413, en cascada)
 *   2. persona_natural_propietario con origen
 *                              API_CONTRAVENCIONES (52)
 *                              API_TEST            (2)
 *                              CARGADO_POR_EXCEL   (40)
 *   3. direcciones que queden sin ninguna persona referenciándolas
 *
 * QUÉ NO TOCA NUNCA:
 *   - personas de origen SCRAPING (1268, base desde mayo/2026)
 *   - consultas_placas, runt_datos_vehiculos, runt_soat_tecno_propietario
 *   - historial_liquidaciones, runt_sesion
 *   - usuarios, modulos, usuario_modulos, api_client,
 *     impresoras, config_impresora, password_resets
 *
 * Todo se ejecuta dentro de UNA transacción: si algo falla, rollback total.
 */
require('dotenv').config();

const pool = require('../utils/db');

const ORIGENES_DE_PRUEBA = ['API_CONTRAVENCIONES', 'API_TEST', 'CARGADO_POR_EXCEL'];

const CONFIRMAR = process.argv.includes('--confirmar');
const FORZAR = process.argv.includes('--forzar');

function linea(titulo) {
  console.log(`\n${'-'.repeat(74)}\n${titulo}\n${'-'.repeat(74)}`);
}

async function contar(sql, params) {
  const r = await pool.query(sql, params || []);
  return Number(r.rows[0].n);
}

async function main() {
  const cliente = await pool.connect();

  try {
    // ---------------------------------------------------------------
    // Plan
    // ---------------------------------------------------------------
    linea('PLAN DE LIMPIEZA' + (CONFIRMAR ? ' (EJECUCIÓN REAL)' : ' (SIMULACIÓN — no borra nada)'));

    const jobs = await cliente.query(`
      SELECT modulo, estado, COUNT(*)::int AS n,
             MIN(created_at)::timestamp(0) AS desde,
             MAX(created_at)::timestamp(0) AS hasta
      FROM worker_jobs
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    const totalJobs = jobs.rows.reduce((s, r) => s + r.n, 0);
    const items = await contar('SELECT COUNT(*)::int AS n FROM worker_job_items');
    const procesando = jobs.rows.filter((r) => r.estado === 'procesando')
      .reduce((s, r) => s + r.n, 0);

    console.log(`\n1) worker_jobs: ${totalJobs} trabajo(s)`);
    jobs.rows.forEach((r) => {
      console.log(`     ${r.modulo.padEnd(26)} ${r.estado.padEnd(12)} ${String(r.n).padStart(4)}` +
        `  ${r.desde} -> ${r.hasta}`);
    });
    console.log(`   worker_job_items: ${items} (se borran en cascada con su trabajo)`);

    if (procesando > 0 && !FORZAR) {
      console.error(`\nABORTADO: hay ${procesando} trabajo(s) en estado "procesando".`);
      console.error('Detén el worker primero, o vuelve a ejecutar con --forzar.');
      await pool.end();
      process.exit(1);
    }

    const personas = await cliente.query(`
      SELECT origen_registro, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE direccion_consultada)::int AS consultadas,
             COUNT(*) FILTER (WHERE direccion_encontrada)::int AS con_direccion,
             COUNT(*) FILTER (WHERE enviado_externo)::int AS enviadas
      FROM persona_natural_propietario
      WHERE origen_registro = ANY($1::text[])
      GROUP BY 1 ORDER BY 2 DESC
    `, [ORIGENES_DE_PRUEBA]);

    const totalPersonas = personas.rows.reduce((s, r) => s + r.n, 0);
    console.log(`\n2) persona_natural_propietario: ${totalPersonas} fila(s)`);
    personas.rows.forEach((r) => {
      console.log(`     ${r.origen_registro.padEnd(22)} ${String(r.n).padStart(4)}` +
        `  (consultadas ${r.consultadas}, con dirección ${r.con_direccion}, enviadas ${r.enviadas})`);
    });
    if (totalPersonas === 0) console.log('     (nada que borrar)');

    const muestra = await cliente.query(`
      SELECT numero_documento, origen_registro, direccion_consultada
      FROM persona_natural_propietario
      WHERE origen_registro = ANY($1::text[])
      ORDER BY fecha_actualizacion DESC NULLS LAST
      LIMIT 8
    `, [ORIGENES_DE_PRUEBA]);
    if (muestra.rows.length) {
      console.log('     Últimas afectadas:');
      muestra.rows.forEach((r) => {
        console.log(`       ${String(r.numero_documento).padEnd(14)} ${r.origen_registro}` +
          `${r.direccion_consultada ? '' : '  (pendiente)'}`);
      });
    }

    // Direcciones huérfanas: las que hoy solo referencian personas que se van a borrar.
    const huerfanas = await contar(`
      SELECT COUNT(*)::int AS n
      FROM direcciones d
      WHERE NOT EXISTS (
        SELECT 1
        FROM persona_natural_propietario p
        WHERE p.fk_direcciones = d.id_direcciones
          AND NOT (p.origen_registro = ANY($1::text[]))
      )
      AND EXISTS (
        SELECT 1
        FROM persona_natural_propietario p2
        WHERE p2.fk_direcciones = d.id_direcciones
          AND (p2.origen_registro = ANY($1::text[]))
      )
    `, [ORIGENES_DE_PRUEBA]);

    const totalDirecciones = await contar('SELECT COUNT(*)::int AS n FROM direcciones');
    console.log(`\n3) direcciones: ${totalDirecciones} en total; ${huerfanas} quedarían huérfanas`);
    console.log('   (solo se borran las que dejen de tener ninguna persona referenciándolas)');

    linea('QUÉ NO SE TOCA');
    const conservar = [
      `personas origen SCRAPING: ${await contar(
        `SELECT COUNT(*)::int AS n FROM persona_natural_propietario WHERE origen_registro = 'SCRAPING'`
      )} (base real desde mayo/2026)`,
      `consultas_placas: ${await contar('SELECT COUNT(*)::int AS n FROM consultas_placas')}`,
      `historial_liquidaciones: ${await contar('SELECT COUNT(*)::int AS n FROM historial_liquidaciones')}`,
      `runt_datos_vehiculos: ${await contar('SELECT COUNT(*)::int AS n FROM runt_datos_vehiculos')}`,
      `runt_soat_tecno_propietario: ${await contar('SELECT COUNT(*)::int AS n FROM runt_soat_tecno_propietario')}`,
      `runt_sesion: ${await contar('SELECT COUNT(*)::int AS n FROM runt_sesion')}`,
      `usuarios: ${await contar('SELECT COUNT(*)::int AS n FROM usuarios')} + modulos, api_client, impresoras, config`
    ];
    conservar.forEach((c) => console.log(`   · ${c}`));

    // ---------------------------------------------------------------
    // Ejecución
    // ---------------------------------------------------------------
    if (!CONFIRMAR) {
      linea('MODO SIMULACIÓN');
      console.log('No se borró nada. Para ejecutar de verdad:');
      console.log('\n   node scripts/limpiar-datos-prueba.js --confirmar\n');
      await pool.end();
      process.exit(0);
    }

    await cliente.query('BEGIN');

    const borradosJobs = (await cliente.query('DELETE FROM worker_jobs')).rowCount;
    const borradosItems = items;
    const borradasPersonas = (await cliente.query(
      'DELETE FROM persona_natural_propietario WHERE origen_registro = ANY($1::text[])',
      [ORIGENES_DE_PRUEBA]
    )).rowCount;
    const borradasDirecciones = (await cliente.query(`
      DELETE FROM direcciones d
      WHERE NOT EXISTS (
        SELECT 1 FROM persona_natural_propietario p WHERE p.fk_direcciones = d.id_direcciones
      )
    `)).rowCount;

    // Revisión final: no debe quedar ninguna inconsistencia.
    const malas = await contar(`
      SELECT COUNT(*)::int AS n
      FROM persona_natural_propietario
      WHERE direccion_encontrada = TRUE AND fk_direcciones IS NULL
    `);
    const pruebaRestante = await contar(
      'SELECT COUNT(*)::int AS n FROM persona_natural_propietario WHERE origen_registro = ANY($1::text[])',
      [ORIGENES_DE_PRUEBA]
    );
    const jobsRestantes = await contar('SELECT COUNT(*)::int AS n FROM worker_jobs');

    if (malas > 0 || pruebaRestante > 0 || jobsRestantes > 0) {
      throw new Error(
        `verificación post-borrado falló: inconsistentes=${malas}, ` +
        `prueba_restante=${pruebaRestante}, jobs_restantes=${jobsRestantes}`
      );
    }

    await cliente.query('COMMIT');

    linea('LIMPIEZA APLICADA');
    console.log(`   worker_jobs eliminados:        ${borradosJobs}`);
    console.log(`   worker_job_items eliminados:   ${borradosItems}`);
    console.log(`   personas eliminadas:           ${borradasPersonas}`);
    console.log(`   direcciones huérfanas borradas:${String(borradasDirecciones).padStart(5)}`);
    console.log(`   personas de prueba restantes:  ${pruebaRestante}`);
    console.log(`   inconsistencias restantes:     ${malas}`);
    console.log('\nListo. La base queda solo con datos reales.\n');
    await pool.end();
    process.exit(0);
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    console.error('\nERROR — se hizo ROLLBACK, no se borró nada:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
