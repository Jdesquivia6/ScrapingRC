const pool = require('../utils/db');

exports.obtenerDashboard = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    const params = [];
    let filtroFecha = '';

    if (fechaInicio && fechaFin) {
      filtroFecha = `WHERE cp.fecha_registro::date BETWEEN $1 AND $2`;
      params.push(fechaInicio, fechaFin);
    }

    const resumen = await pool.query(`
      SELECT
        COUNT(*)::int AS total_placas,
        COUNT(*) FILTER (WHERE cp.estado_consulta = true)::int AS consultas_exitosas,
        COUNT(*) FILTER (WHERE cp.estado_consulta IS NULL OR cp.estado_consulta = false)::int AS pendientes,
        COUNT(rdv.*)::int AS datos_vehiculo_total,
        COUNT(rdv.*) FILTER (WHERE rdv.estado_consulta = true)::int AS datos_vehiculo_exitosos,
        COUNT(rdv.*) FILTER (WHERE rdv.estado_consulta = false)::int AS datos_vehiculo_fallidos
      FROM consultas_placas cp
      LEFT JOIN runt_datos_vehiculos rdv
        ON rdv.fk_consul_placa = cp.id_consul_placa
      ${filtroFecha}
    `, params);

    const porDia = await pool.query(`
      SELECT
        cp.fecha_registro::date AS fecha,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cp.estado_consulta = true)::int AS exitosas,
        COUNT(*) FILTER (WHERE cp.estado_consulta IS NULL OR cp.estado_consulta = false)::int AS pendientes
      FROM consultas_placas cp
      ${filtroFecha}
      GROUP BY cp.fecha_registro::date
      ORDER BY fecha ASC
    `, params);

    const ultimas = await pool.query(`
      SELECT
        cp.placa,
        cp.estado_consulta,
        cp.fecha_registro,
        cp.fecha_consulta,
        rdv.estado_consulta AS estado_datos_vehiculo,
        rdv.error_consulta
      FROM consultas_placas cp
      LEFT JOIN runt_datos_vehiculos rdv
        ON rdv.fk_consul_placa = cp.id_consul_placa
      ${filtroFecha}
      ORDER BY COALESCE(rdv.fecha_consulta, cp.fecha_consulta, cp.fecha_registro) DESC
      LIMIT 10
    `, params);

    const errores = await pool.query(`
      SELECT
        cp.placa,
        rdv.error_consulta,
        rdv.fecha_consulta
      FROM runt_datos_vehiculos rdv
      INNER JOIN consultas_placas cp
        ON cp.id_consul_placa = rdv.fk_consul_placa
      WHERE rdv.estado_consulta = false
        AND rdv.error_consulta IS NOT NULL
      ORDER BY rdv.fecha_consulta DESC
      LIMIT 10
    `);

    return res.json({
      ok: true,
      resumen: resumen.rows[0],
      porDia: porDia.rows,
      ultimas: ultimas.rows,
      errores: errores.rows
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};