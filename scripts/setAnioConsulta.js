// ============================================================
// Asignar el año de consulta a las solicitudes API existentes
// ------------------------------------------------------------
// Para cuando los datos ya están en la BD con anio_consulta NULL
// (se insertaron antes de existir la columna) y no conviene
// reenviar todo el lote desde el servicio externo.
//
// SOLO lectura por defecto: muestra cuántas filas se tocarían.
// Escribe únicamente con --aplicar.
//
// Uso:
//   node scripts/setAnioConsulta.js 2025
//   node scripts/setAnioConsulta.js 2025 --aplicar
//   node scripts/setAnioConsulta.js 2025 --aplicar --reactivar
//   node scripts/setAnioConsulta.js 2025 --aplicar --origen API_CONTRAVENCIONES
//
// Flags:
//   (sin flags)   dry run: solo cuenta, no escribe
//   --aplicar     escribe los cambios
//   --solo-nulos  solo filas con anio_consulta NULL  (por defecto activado)
//   --todos       también sobreescribe filas que ya tienen año
//   --reactivar   además limpia las marcas de consulta para que vuelvan a la
//                 cola de scraping (consumirá jobs de RUNT)
//   --origen X    restringe a un origen concreto (ej. API_CONTRAVENCIONES)
// ============================================================

const pool = require('../utils/db');

const ANIO_MIN = 2000;
const ANIO_MAX = new Date().getFullYear() + 1;

async function main() {
  const args = process.argv.slice(2);
  const bandera = (nombre) => args.includes(nombre);
  const valorDe = (nombre) => {
    const i = args.indexOf(nombre);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };

  const anio = Number(args.find((a) => /^-?\d+$/.test(a)));
  if (!Number.isInteger(anio) || anio < ANIO_MIN || anio > ANIO_MAX) {
    console.error('Uso: node scripts/setAnioConsulta.js <anio> [--aplicar] [--reactivar] [--todos] [--origen X]');
    console.error(`El año debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}.`);
    process.exit(1);
  }

  const aplicar = bandera('--aplicar');
  const reactivar = bandera('--reactivar');
  // Por defecto solo se tocan filas sin año. --solo-nulos lo deja explícito
  // y tiene prioridad sobre --todos.
  const soloNulos = bandera('--solo-nulos') || !bandera('--todos');
  const origen = valorDe('--origen');

  // --- 1) Dry run: solo contar ---
  const filaConteo = (
    await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT p.numero_documento)::int AS documentos,
              COUNT(*) FILTER (WHERE p.direccion_consultada = FALSE)::int AS pendientes
       FROM persona_natural_propietario p
       WHERE p.origen_registro LIKE 'API_%'
         AND p.numero_documento IS NOT NULL
         ${origen ? `AND p.origen_registro = $1` : ''}
         ${soloNulos ? 'AND p.anio_consulta IS NULL' : ''}`,
      origen ? [origen] : []
    )
  ).rows[0];

  const { total, documentos, pendientes } = filaConteo;

  console.log(`\nAño a asignar:            ${anio}`);
  console.log(`Alcance:                  ${origen || 'origen LIKE API_%'}`);
  console.log(`Solo filas sin año:       ${soloNulos ? 'sí' : 'no (sobreescribe)'}`);
  console.log(`Filas que se tocarían:    ${total}`);
  console.log(`Documentos distintos:     ${documentos}`);
  console.log(`De ellos sin consultar:   ${pendientes}`);
  console.log(`De ellos ya consultados:  ${total - pendientes}`);

  if (!aplicar) {
    console.log(`\nDRY RUN — no se escribió nada.`);
    console.log(`Para aplicar: node scripts/setAnioConsulta.js ${anio} --aplicar`);
    await pool.end();
    return;
  }

  if (total === 0) {
    console.log('\nNada que hacer.');
    await pool.end();
    return;
  }

  // --- 2) Aplicar ---
  const params = [anio];
  if (origen) params.push(origen);

  const sets = ['anio_consulta = $1', 'fecha_actualizacion = NOW()'];
  if (reactivar) {
    sets.push('direccion_consultada = FALSE');
    sets.push('direccion_encontrada = FALSE');
    sets.push('error_consulta_direccion = NULL');
    sets.push('fecha_consulta_direccion = NULL');
  }

  const upd = await pool.query(
    `UPDATE persona_natural_propietario AS p
     SET ${sets.join(',\n         ')}
     WHERE p.origen_registro LIKE 'API_%'
       AND p.numero_documento IS NOT NULL
       ${origen ? 'AND p.origen_registro = $2' : ''}
       ${soloNulos ? 'AND p.anio_consulta IS NULL' : ''}
     RETURNING p.numero_documento`,
    params
  );

  console.log(`\nFilas actualizadas: ${upd.rowCount}`);
  console.log(
    reactivar
      ? 'Con --reactivar: vuelven a la cola de scraping (consumirán jobs de RUNT).'
      : 'No se tocaron las marcas de consulta: si ya tenían dirección, se conserva.'
  );
  console.log('\nRecarga el panel de Ubicabilidad Personas para ver las tarjetas de año.');

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
