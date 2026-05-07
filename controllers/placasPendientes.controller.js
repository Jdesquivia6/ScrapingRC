const pool = require('../utils/db');

exports.listarPlacasPendientes = async (req, res) => {
  try {
    const {
      fechaInicio,
      fechaFin,
      estado = 'pendientes',
      modulo = 'consulta-placa',
      limit = 100
    } = req.query;

    if (!fechaInicio || !fechaFin) {
      return res.status(400).json({
        ok: false,
        error: 'Debe enviar fechaInicio y fechaFin'
      });
    }

    const limiteSeguro = Math.min(Number(limit) || 100, 100);

    let query = '';
    const params = [fechaInicio, fechaFin, limiteSeguro];

    if (modulo === 'datos-vehiculo') {
      query = `
        SELECT DISTINCT
          cp.id_consul_placa,
          cp.placa,
          cp.estado_consulta,
          cp.fecha_registro,
          cp.fecha_consulta,
          rstp.fecha_consulta AS fecha_consulta_propietario
        FROM runt_soat_tecno_propietario rstp
        INNER JOIN consultas_placas cp
          ON cp.id_consul_placa = rstp.fk_consul_placa
        LEFT JOIN runt_datos_vehiculos rdv
          ON rdv.fk_consul_placa = cp.id_consul_placa
        WHERE rstp.fecha_consulta::date BETWEEN $1 AND $2
          AND rdv.fk_consul_placa IS NULL
        ORDER BY rstp.fecha_consulta ASC
        LIMIT $3
      `;
    } else {
      let filtroEstado = '';

      if (estado === 'pendientes') {
        filtroEstado = `
          AND (
            cp.estado_consulta IS NULL 
            OR cp.estado_consulta = false
          )
        `;
      }

      if (estado === 'consultadas') {
        filtroEstado = `
          AND cp.estado_consulta = true
        `;
      }

      query = `
        SELECT
          cp.id_consul_placa,
          cp.placa,
          cp.estado_consulta,
          cp.fecha_registro,
          cp.fecha_consulta
        FROM consultas_placas cp
        WHERE cp.fecha_registro::date BETWEEN $1 AND $2
        ${filtroEstado}
        ORDER BY cp.fecha_registro ASC
        LIMIT $3
      `;
    }

    const result = await pool.query(query, params);

    return res.json({
      ok: true,
      modulo,
      total: result.rows.length,
      limit: limiteSeguro,
      results: result.rows
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};