const pool = require('../utils/db');
const { getPrinters } = require('pdf-to-printer');

async function obtenerConfigImpresora() {
  const result = await pool.query(
    'SELECT id, printer_name, auto_print, updated_at FROM config_impresora WHERE id = 1'
  );
  return result.rows[0] || { printer_name: '', auto_print: false };
}

async function guardarConfigImpresora({ printer_name, auto_print }) {
  await pool.query(
    `UPDATE config_impresora
     SET printer_name = $1, auto_print = $2, updated_at = NOW()
     WHERE id = 1`,
    [printer_name || '', auto_print || false]
  );
}

async function listarImpresoras() {
  const result = await pool.query(
    'SELECT id, nombre, created_at FROM impresoras ORDER BY id'
  );
  return result.rows;
}

async function listarImpresorasDisponibles() {
  const printers = await getPrinters();
  return printers.map(p => p.name).filter(Boolean);
}

async function agregarImpresora(nombre) {
  const name = (nombre || '').trim();
  if (!name) throw new Error('El nombre de la impresora es obligatorio');

  try {
    const result = await pool.query(
      'INSERT INTO impresoras (nombre) VALUES ($1) RETURNING id, nombre',
      [name]
    );
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw new Error(`La impresora "${name}" ya está registrada`);
    }
    throw error;
  }
}

async function eliminarImpresora(id) {
  const result = await pool.query(
    'DELETE FROM impresoras WHERE id = $1 RETURNING id, nombre',
    [id]
  );
  if (result.rowCount === 0) throw new Error('Impresora no encontrada');
  return result.rows[0];
}

async function activarImpresora(id) {
  const result = await pool.query(
    'SELECT nombre FROM impresoras WHERE id = $1',
    [id]
  );
  if (result.rowCount === 0) throw new Error('Impresora no encontrada');

  const { nombre } = result.rows[0];
  await pool.query(
    `UPDATE config_impresora
     SET printer_name = $1, updated_at = NOW()
     WHERE id = 1`,
    [nombre]
  );
  return nombre;
}

exports.obtenerConfigImpresora = obtenerConfigImpresora;
exports.guardarConfigImpresora = guardarConfigImpresora;
exports.listarImpresoras = listarImpresoras;
exports.listarImpresorasDisponibles = listarImpresorasDisponibles;
exports.agregarImpresora = agregarImpresora;
exports.eliminarImpresora = eliminarImpresora;
exports.activarImpresora = activarImpresora;
