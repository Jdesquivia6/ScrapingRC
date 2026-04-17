const pool = require('../utils/db');

exports.cargarPlacas = async (req, res) => {
  try {
    const { placas } = req.body;

    if (!placas || !Array.isArray(placas)) {
      return res.status(400).json({
        ok: false,
        error: 'Debe enviar un arreglo de placas'
      });
    }

    for (const placa of placas) {
      await pool.query(`
        INSERT INTO consultas_placas (placa, estado_consulta)
        VALUES ($1, false)
        ON CONFLICT (placa) DO NOTHING
      `, [placa]);
    }

    res.json({
      ok: true,
      message: 'Placas cargadas correctamente'
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};