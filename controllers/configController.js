const pool = require('../utils/db');

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

exports.obtenerConfigImpresora = obtenerConfigImpresora;
exports.guardarConfigImpresora = guardarConfigImpresora;
