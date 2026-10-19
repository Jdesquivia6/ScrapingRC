// ============================================================
// Diagnóstico del campo "anio" en la API de integraciones
// ------------------------------------------------------------
// Comprueba de un solo tiro si el backend recibe, persiste y
// devuelve el año de los comparendos. Sirve para separar
// "el backend no guarda el año" de "el servicio no lo envía".
//
// Uso:
//   node scripts/diagAnio.js <API_KEY>
//   node scripts/diagAnio.js <API_KEY> --limpiar
//   node scripts/diagAnio.js <API_KEY> http://84.247.165.214:3000
//
// Qué envía:
//   - persona A: anio en la RAÍZ del body (anio: 2026)
//   - persona B: anio POR PERSONA (anio: 2025), que debe pisar la raíz
//   - persona C: anio dentro de METADATA (metadata.anio_consulta: 2024)
//     — esta es la forma real que usa CONTRAVENCIONES
//   - persona D: anio_consulta por persona (2023), alias del campo
//
// Luego consulta la BD directamente para ver qué quedó guardado.
// ============================================================

const pool = require('../utils/db');

const DOC_A = '9999999901';
const DOC_B = '9999999902';
const DOC_C = '9999999903';
const DOC_D = '9999999904';
const TODOS = [DOC_A, DOC_B, DOC_C, DOC_D];

async function main() {
  const args = process.argv.slice(2);
  const limpiar = args.includes('--limpiar');
  const apiKey = args.find((a) => !a.startsWith('--') && a !== args[args.length - 1]) || args[0];
  const baseUrl = (args.find((a) => a.startsWith('http')) || 'http://localhost:3000').replace(/\/$/, '');

  if (!apiKey || apiKey.startsWith('--')) {
    console.error('Uso: node scripts/diagAnio.js <API_KEY> [--limpiar] [baseUrl]');
    process.exit(1);
  }

  if (limpiar) {
    const r = await pool.query(
      'DELETE FROM persona_natural_propietario WHERE numero_documento = ANY($1::text[]) RETURNING numero_documento',
      [[DOC_A, DOC_B, DOC_C, DOC_D]]
    );
    console.log(`\nEliminados ${r.rowCount} documento(s) de prueba.`);
    await pool.end();
    return;
  }

  const url = `${baseUrl}/api/v1/integraciones/ubicabilidad/personas`;
  console.log(`POST ${url}`);
  console.log('Enviado:');
  console.log(`  A=${DOC_A}  anio en la RAÍZ (2026)`);
  console.log(`  B=${DOC_B}  anio POR PERSONA (2025)`);
  console.log(`  C=${DOC_C}  anio en METADATA.metadata.anio_consulta (2024)  <- forma de CONTRAVENCIONES`);
  console.log(`  D=${DOC_D}  anio_consulta por persona (2023)  <- alias\n`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({
      anio: 2026, // año por defecto del lote
      personas: [
        { tipo_documento: 'CC', numero_documento: DOC_A },
        { tipo_documento: 'CC', numero_documento: DOC_B, anio: 2025 },
        {
          tipo_documento: 'CC',
          numero_documento: DOC_C,
          metadata: { origen: 'CONTRAVENCIONES', anio_consulta: 2024 }
        },
        { tipo_documento: 'CC', numero_documento: DOC_D, anio_consulta: 2023 }
      ]
    })
  });

  const json = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}\n`);

  if (!res.ok || !json.ok) {
    console.error('La API rechazó la petición:', json.error || JSON.stringify(json));
    console.error('\nSi da 401, la API key no es válida. Si da 500, falta la migración addAnioConsulta.sql.');
    await pool.end();
    process.exit(1);
  }

  console.log('Lo que la API respondió (eco):');
  for (const item of json.personas || json.respuesta || json || []) {
    if (!item || typeof item !== 'object' || !item.numero_documento) continue;
    console.log(
      `  ${item.numero_documento}  estado=${item.estado_recepcion}  anio_echado=${JSON.stringify(item.anio)}`
    );
  }

  const bd = await pool.query(
    `SELECT numero_documento, anio_consulta, origen_registro, direccion_consultada
     FROM persona_natural_propietario
     WHERE numero_documento = ANY($1::text[])
     ORDER BY numero_documento`,
    [TODOS]
  );

  console.log('\nLo que quedó guardado en la BD:');
  if (bd.rows.length === 0) {
    console.log('  (ninguna fila — el INSERT no llegó a persistir)');
  }
  for (const row of bd.rows) {
    console.log(
      `  ${row.numero_documento}  anio_consulta=${JSON.stringify(row.anio_consulta)}  origen=${row.origen_registro}`
    );
  }

  const esperado = { [DOC_A]: 2026, [DOC_B]: 2025, [DOC_C]: 2024, [DOC_D]: 2023 };
  const fila = (doc) => bd.rows.find((r) => r.numero_documento === doc);
  const ok = Object.entries(esperado).every(([doc, anio]) => {
    const r = fila(doc);
    return r && r.anio_consulta === anio;
  });

  console.log('\nLectura:');
  if (ok) {
    console.log('  OK — las cuatro formas se leen y persisten (raíz, por persona, metadata y alias).');
    console.log('  => El backend está bien.');
    console.log('     Si el panel sigue en "Sin año" es porque esas filas se insertaron antes');
    console.log('     de este fix. Tienes dos caminos:');
    console.log('       · reenviarlas desde contravenciones con su año, o');
    console.log('       · node scripts/setAnioConsulta.js <anio> --aplicar');
  } else {
    for (const [doc, anio] of Object.entries(esperado)) {
      const r = fila(doc);
      const got = r ? JSON.stringify(r.anio_consulta) : '(sin fila)';
      if (String(r && r.anio_consulta) !== String(anio)) {
        console.log(`  FALTA  ${doc}: esperaba ${anio}, quedó ${got}`);
      }
    }
    console.log('  => El proceso que atiende el puerto 3000 no está corriendo este código.');
    console.log('     Reinicia el servicio y vuelve a correr este diagnóstico.');
  }

  console.log('\nPara limpiar: node scripts/diagAnio.js <API_KEY> --limpiar');
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
