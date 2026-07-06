const express = require('express');
const multer = require('multer');
const router = express.Router();
const XLSX = require('xlsx');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

/**
 * POST /api/placas/cargar-archivo
 * Recibe archivo Excel/CSV con columna "placa",
 * normaliza, elimina duplicados y los inserta en consultas_placas.
 */
router.post('/cargar-archivo', upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se envió ningún archivo' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'El archivo está vacío' });
    }

    // Verificar columna placa
    const primeraFila = rows[0];
    if (!('placa' in primeraFila)) {
      return res.status(400).json({
        ok: false,
        error: 'El archivo debe contener la columna "placa"'
      });
    }

    const pool = require('../utils/db');
    const duplicadosSet = new Set();
    const duplicados = [];
    const errores = [];
    const placasValidas = [];

    rows.forEach((row, i) => {
      let placa = String(row.placa || '').trim().toUpperCase().replace(/\s+/g, '');

      if (!placa) return; // Ignorar vacías

      if (placa.length < 5 || placa.length > 7) {
        errores.push({ fila: i + 2, placa, mensaje: 'Formato de placa inválido' });
        return;
      }

      if (duplicadosSet.has(placa)) {
        duplicados.push({ fila: i + 2, placa });
        return;
      }

      duplicadosSet.add(placa);
      placasValidas.push(placa);
    });

    // Insertar en consultas_placas (ON CONFLICT DO NOTHING para duplicados de BD)
    let insertadas = 0;
    let yaExistian = 0;

    for (const placa of placasValidas) {
      const result = await pool.query(`
        INSERT INTO consultas_placas (placa, estado_consulta, fk_usuario)
        VALUES ($1, false, $2)
        ON CONFLICT (placa) DO NOTHING
        RETURNING id_consul_placa
      `, [placa, req.user?.id_usuario || null]);

      if (result.rowCount > 0) {
        insertadas++;
      } else {
        yaExistian++;
      }
    }

    res.json({
      ok: true,
      data: {
        total_filas: rows.length,
        placas_validas: placasValidas.length,
        placas: placasValidas.map(placa => ({ placa })),
        placas_duplicadas_en_archivo: duplicados.length,
        placas_error: errores.length,
        placas_insertadas: insertadas,
        placas_ya_existian: yaExistian,
        duplicados: duplicados.slice(0, 20),
        errores: errores.slice(0, 20)
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
