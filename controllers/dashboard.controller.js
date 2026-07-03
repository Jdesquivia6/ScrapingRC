const pool = require('../utils/db');
const ExcelJS = require('exceljs');

function construirFiltroFechas({ fechaInicio, fechaFin, alias = 'cp', campo = 'fecha_consulta' }) {
  const params = [];
  let where = '';

  if (fechaInicio && fechaFin) {
    where = `WHERE ${alias}.${campo}::date BETWEEN $1 AND $2`;
    params.push(fechaInicio, fechaFin);
  } else {
    // Por defecto: últimos 30 días
    where = `WHERE ${alias}.${campo} >= NOW() - INTERVAL '30 days'`;
  }

  return { where, params };
}

exports.obtenerDashboard = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    const filtro = construirFiltroFechas({
      fechaInicio,
      fechaFin,
      alias: 'cp',
      campo: 'fecha_consulta'
    });

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
      ${filtro.where}
    `, filtro.params);

    const porDia = await pool.query(`
      SELECT
        cp.fecha_consulta::date AS fecha,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cp.estado_consulta = true)::int AS exitosas,
        COUNT(*) FILTER (WHERE cp.estado_consulta IS NULL OR cp.estado_consulta = false)::int AS pendientes,
        COUNT(rdv.*) FILTER (WHERE rdv.estado_consulta = true)::int AS datos_vehiculo_exitosos,
        COUNT(rdv.*) FILTER (WHERE rdv.estado_consulta = false)::int AS datos_vehiculo_fallidos
      FROM consultas_placas cp
      LEFT JOIN runt_datos_vehiculos rdv
        ON rdv.fk_consul_placa = cp.id_consul_placa
      ${filtro.where}
      GROUP BY cp.fecha_consulta::date
      ORDER BY fecha ASC
    `, filtro.params);

    const ultimas = await pool.query(`
      SELECT
        cp.placa,
        cp.estado_consulta,
        cp.fecha_consulta,
        rdv.estado_consulta AS estado_datos_vehiculo,
        rdv.error_consulta,
        rdv.fecha_consulta AS fecha_consulta_datos_vehiculo
      FROM consultas_placas cp
      LEFT JOIN runt_datos_vehiculos rdv
        ON rdv.fk_consul_placa = cp.id_consul_placa
      ${filtro.where}
      ORDER BY COALESCE(rdv.fecha_consulta, cp.fecha_consulta) DESC
      LIMIT 20
    `, filtro.params);

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
      LIMIT 20
    `);

    return res.json({
      ok: true,
      filtros: {
        fechaInicio: fechaInicio || null,
        fechaFin: fechaFin || null,
        modo: fechaInicio && fechaFin ? 'rango' : 'ultimos_30_dias'
      },
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

exports.exportarDashboardExcel = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    const filtro = construirFiltroFechas({
      fechaInicio,
      fechaFin,
      alias: 'cp',
      campo: 'fecha_consulta'
    });

    const result = await pool.query(`
      SELECT
        cp.placa,
        cp.estado_consulta AS consulta_placa_exitosa,
        cp.fecha_consulta AS fecha_consulta_placa,

        rstp.tipo_identificacion_propietario,
        rstp.numero_identificacion_propietario,
        rstp.nombre_razon_social_propietario,
        rstp.fecha_expedicion_tecno,
        rstp.fecha_vigencia_tecno,
        rstp.fecha_inicio_vigencia_soat,
        rstp.fecha_vencimiento_vigencia_soat,

        rdv.clase,
        rdv.marca,
        rdv.linea,
        rdv.servicio,
        rdv.color,
        rdv.modelo,
        rdv.estado_consulta AS datos_vehiculo_exitoso,
        rdv.error_consulta,
        rdv.fecha_consulta AS fecha_consulta_datos_vehiculo
      FROM consultas_placas cp
      LEFT JOIN runt_soat_tecno_propietario rstp
        ON rstp.fk_consul_placa = cp.id_consul_placa
      LEFT JOIN runt_datos_vehiculos rdv
        ON rdv.fk_consul_placa = cp.id_consul_placa
      ${filtro.where}
      ORDER BY COALESCE(rdv.fecha_consulta, rstp.fecha_consulta, cp.fecha_consulta) DESC
    `, filtro.params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dashboard');

    sheet.columns = [
      { header: 'Placa', key: 'placa', width: 15 },
      { header: 'Consulta placa exitosa', key: 'consulta_placa_exitosa', width: 25 },
      { header: 'Fecha consulta placa', key: 'fecha_consulta_placa', width: 25 },
      { header: 'Tipo ID propietario', key: 'tipo_identificacion_propietario', width: 25 },
      { header: 'Número ID propietario', key: 'numero_identificacion_propietario', width: 25 },
      { header: 'Nombre propietario', key: 'nombre_razon_social_propietario', width: 35 },
      { header: 'Fecha expedición tecno', key: 'fecha_expedicion_tecno', width: 25 },
      { header: 'Fecha vigencia tecno', key: 'fecha_vigencia_tecno', width: 25 },
      { header: 'Inicio SOAT', key: 'fecha_inicio_vigencia_soat', width: 25 },
      { header: 'Vencimiento SOAT', key: 'fecha_vencimiento_vigencia_soat', width: 25 },
      { header: 'Clase', key: 'clase', width: 20 },
      { header: 'Marca', key: 'marca', width: 20 },
      { header: 'Línea', key: 'linea', width: 20 },
      { header: 'Servicio', key: 'servicio', width: 20 },
      { header: 'Color', key: 'color', width: 20 },
      { header: 'Modelo', key: 'modelo', width: 15 },
      { header: 'Datos vehículo exitoso', key: 'datos_vehiculo_exitoso', width: 25 },
      { header: 'Error consulta', key: 'error_consulta', width: 45 },
      { header: 'Fecha consulta datos vehículo', key: 'fecha_consulta_datos_vehiculo', width: 30 }
    ];

    result.rows.forEach(row => {
      sheet.addRow(row);
    });

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    sheet.autoFilter = {
      from: 'A1',
      to: 'T1'
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      'attachment; filename=dashboard-consultas.xlsx'
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};