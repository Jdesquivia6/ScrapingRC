const pool = require('../utils/db');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { exportarJobExcel } = require('../controllers/workerJobs.controller');

async function inspect() {
  const t1 = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'worker_jobs' ORDER BY ordinal_position`);
  const t2 = await pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'worker_job_items' ORDER BY ordinal_position`);
  console.log('== worker_jobs ==');
  t1.rows.forEach(r => console.log(' ', r.column_name, r.data_type, r.is_nullable));
  console.log('== worker_job_items ==');
  t2.rows.forEach(r => console.log(' ', r.column_name, r.data_type, r.is_nullable));

  const u = await pool.query(`SELECT id_usuario, email, rol FROM usuarios LIMIT 5`);
  console.log('== usuarios ==');
  u.rows.forEach(r => console.log(' ', r.id_usuario, r.email, r.rol));

  const p = await pool.query(`SELECT tipo_documento, numero_documento, nombres, apellidos FROM persona_natural_propietario WHERE direccion_consultada = TRUE AND numero_documento IS NOT NULL LIMIT 5`);
  console.log('== personas con direccion ==');
  p.rows.forEach(r => console.log(' ', r.tipo_documento, r.numero_documento, r.nombres, r.apellidos));
}

async function crearJobPrueba(modulo, userId, personas) {
  const job = await pool.query(
    `INSERT INTO worker_jobs (modulo, estado, fk_usuario, total, procesadas, exitosas, fallidas)
     VALUES ($1, 'finalizado', $2, $3, $3, $3, 0)
     RETURNING id_job`,
    [modulo, userId, personas.length]
  );
  const idJob = job.rows[0].id_job;

  for (const p of personas) {
    await pool.query(
      `INSERT INTO worker_job_items (fk_job, payload, documento, estado)
       VALUES ($1, $2::jsonb, $3, 'exitoso')`,
      [idJob, JSON.stringify({ tipoDocumento: p.tipo_documento, numeroDocumento: p.numero_documento }), p.numero_documento]
    );
  }
  return idJob;
}

async function descargarExcel(idJob, outFile) {
  const headers = {};
  const res = new PassThrough();
  res.setHeader = (name, value) => { headers[name] = value; };
  res.status = (code) => { res._status = code; return res; };
  res.json = (obj) => { throw new Error(`RESPONSE ${res._status}: ${JSON.stringify(obj)}`); };

  const chunks = [];
  res.on('data', c => chunks.push(c));

  const req = {
    params: { id: idJob },
    user: { rol: 'administrador', id_usuario: 'test' }
  };

  await exportarJobExcel(req, res);

  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(outFile, buffer);
  return { headers, size: buffer.length, magic: buffer.subarray(0, 2).toString('latin1') };
}

async function limpiar(idJob) {
  await pool.query(`DELETE FROM worker_job_items WHERE fk_job = $1`, [idJob]);
  await pool.query(`DELETE FROM worker_jobs WHERE id_job = $1`, [idJob]);
}

(async () => {
  const args = process.argv.slice(2);
  const modoLimpiar = args[0] === '--limpiar' ? args[1] : null;
  const modoListar = args[0] === '--listar';

  if (modoListar) {
    const r = await pool.query(`
      SELECT id_job, modulo, estado, created_at
      FROM worker_jobs
      WHERE modulo IN ('personas-direcciones', 'ubicabilidad-personas')
        AND worker_name IS NULL
      ORDER BY created_at DESC
      LIMIT 20
    `);
    console.log('Jobs sin worker_name (candidatos de prueba):');
    r.rows.forEach(j => console.log(' ', j.id_job, j.modulo, j.estado, j.created_at));
    pool.end();
    process.exit(0);
  }

  if (modoLimpiar) {
    const idJob = modoLimpiar.trim();
    await limpiar(idJob);
    console.log(`Limpieza completa para job ${idJob} (items + job eliminados)`);
    pool.end();
    process.exit(0);
  }

  await inspect();

  const admin = await pool.query(`SELECT id_usuario FROM usuarios WHERE rol = 'administrador' LIMIT 1`);
  if (admin.rows.length === 0) throw new Error('No hay usuario administrador');
  const userId = admin.rows[0].id_usuario;

  const personas = await pool.query(
    `SELECT tipo_documento, numero_documento, nombres, apellidos
     FROM persona_natural_propietario
     WHERE direccion_consultada = TRUE AND numero_documento IS NOT NULL
     LIMIT 5`
  );
  if (personas.rows.length === 0) throw new Error('No hay personas con direccion para probar');

  const outDir = 'downloads';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const resultados = [];
  for (const modulo of ['personas-direcciones', 'ubicabilidad-personas']) {
    const idJob = await crearJobPrueba(modulo, userId, personas.rows);
    const outFile = path.join(outDir, `test_${modulo}.xlsx`);
    try {
      const info = await descargarExcel(idJob, outFile);
      resultados.push({ modulo, idJob, ...info, ok: info.magic === 'PK' && info.size > 100 });
    } finally {
      await limpiar(idJob);
    }
  }

  console.log('== RESULTADOS ==');
  resultados.forEach(r => {
    console.log(` ${r.modulo} | job=${r.idJob} | size=${r.size} | magic=${r.magic} | ok=${r.ok}`);
    console.log(`   content-type=${r.headers['Content-Type']} | disposition=${r.headers['Content-Disposition']}`);
  });

  pool.end();
  process.exit(0);
})().catch(e => {
  console.error('ERR', e.message);
  pool.end();
  process.exit(1);
});
