const pool = require('../utils/db');
const ExcelJS = require('exceljs');

exports.obtenerDashboard = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;
    const tieneFiltro = fechaInicio && fechaFin;

    let params = [];
    let filtroFecha = "";
    if (tieneFiltro) {
      filtroFecha = "WHERE cp.fecha_consulta::date BETWEEN $1 AND $2";
      params = [fechaInicio, fechaFin];
    }

    let filtroFechaVehiculos = "";
    let paramsVehiculos = [];
    if (tieneFiltro) {
      filtroFechaVehiculos = "WHERE rdv.fecha_consulta::date BETWEEN $1 AND $2";
      paramsVehiculos = [fechaInicio, fechaFin];
    }

    let filtroFechaUbica = "";
    let paramsUbica = [];
    if (tieneFiltro) {
      filtroFechaUbica = "WHERE pnp.fecha_consulta_direccion::date BETWEEN $1 AND $2";
      paramsUbica = [fechaInicio, fechaFin];
    }

    // ── 1. RESUMEN PLACAS ─────────────────────────────────────────────────
    const resumenPlacas = await pool.query(`
      SELECT
        COUNT(*)::int AS total_placas,
        COUNT(*) FILTER (WHERE cp.estado_consulta = true)::int AS consultas_exitosas,
        COUNT(*) FILTER (WHERE cp.estado_consulta IS NULL OR cp.estado_consulta = false)::int AS pendientes
      FROM consultas_placas cp
      ${filtroFecha}
    `, params);

    // ── 2. RESUMEN VEHÍCULOS ───────────────────────────────────────────────
    const resumenVehiculos = await pool.query(`
      SELECT
        COUNT(*)::int AS datos_vehiculo_total,
        COUNT(*) FILTER (WHERE rdv.estado_consulta = true)::int AS datos_vehiculo_exitosos,
        COUNT(*) FILTER (WHERE rdv.estado_consulta = false)::int AS datos_vehiculo_fallidos
      FROM runt_datos_vehiculos rdv
      ${filtroFechaVehiculos}
    `, paramsVehiculos);

    // ── 3. RESUMEN UBICABILIDAD PERSONAS ──────────────────────────────────
    const resumenUbica = await pool.query(`
      SELECT
        COUNT(*)::int AS total_ubicabilidad,
        COUNT(*) FILTER (WHERE pnp.direccion_encontrada = true)::int AS ubica_encontradas,
        COUNT(*) FILTER (WHERE pnp.direccion_consultada = true AND pnp.direccion_encontrada = false)::int AS ubica_no_encontradas,
        COUNT(*) FILTER (WHERE pnp.direccion_consultada = false OR pnp.direccion_consultada IS NULL)::int AS ubica_pendientes
      FROM persona_natural_propietario pnp
      WHERE pnp.origen_registro = 'CARGADO_POR_EXCEL'
      ${filtroFechaUbica}
    `, paramsUbica);

    // ── 4. ÚLTIMAS CONSULTAS PLACA ────────────────────────────────────────
    let ultimasParams = [];
    let ultimasWhere = "";
    if (tieneFiltro) {
      ultimasWhere = "WHERE cp.fecha_consulta::date BETWEEN $1 AND $2";
      ultimasParams = [fechaInicio, fechaFin];
    }

    const ultimasPlacas = await pool.query(`
      SELECT
        cp.placa,
        cp.estado_consulta,
        cp.fecha_consulta,
        rdv.estado_consulta AS estado_datos_vehiculo,
        rdv.error_consulta,
        rdv.fecha_consulta AS fecha_consulta_datos_vehiculo
      FROM consultas_placas cp
      LEFT JOIN runt_datos_vehiculos rdv ON rdv.fk_consul_placa = cp.id_consul_placa
      ${ultimasWhere}
      ORDER BY COALESCE(rdv.fecha_consulta, cp.fecha_consulta) DESC
      LIMIT 20
    `, ultimasParams);

    // ── 5. ÚLTIMOS ERRORES ────────────────────────────────────────────────
    let erroresParams = [];
    let erroresWhere = "rdv.estado_consulta = false AND rdv.error_consulta IS NOT NULL";
    if (tieneFiltro) {
      erroresWhere += " AND rdv.fecha_consulta::date BETWEEN $1 AND $2";
      erroresParams = [fechaInicio, fechaFin];
    }

    const errores = await pool.query(`
      SELECT
        cp.placa,
        rdv.error_consulta,
        rdv.fecha_consulta
      FROM runt_datos_vehiculos rdv
      INNER JOIN consultas_placas cp ON cp.id_consul_placa = rdv.fk_consul_placa
      WHERE ${erroresWhere}
      ORDER BY rdv.fecha_consulta DESC
      LIMIT 20
    `, erroresParams);

    // Combinar
    const rPlacas = resumenPlacas.rows[0] || {};
    const rVehiculos = resumenVehiculos.rows[0] || {};
    const rUbica = resumenUbica.rows[0] || {};

    return res.json({
      ok: true,
      filtros: {
        fechaInicio: fechaInicio || null,
        fechaFin: fechaFin || null,
        modo: tieneFiltro ? 'rango' : 'todo'
      },
      resumen: {
        total_placas: rPlacas.total_placas || 0,
        consultas_exitosas: rPlacas.consultas_exitosas || 0,
        pendientes_placas: rPlacas.pendientes || 0,
        datos_vehiculo_total: rVehiculos.datos_vehiculo_total || 0,
        datos_vehiculo_exitosos: rVehiculos.datos_vehiculo_exitosos || 0,
        datos_vehiculo_fallidos: rVehiculos.datos_vehiculo_fallidos || 0,
        total_ubicabilidad: rUbica.total_ubicabilidad || 0,
        ubica_encontradas: rUbica.ubica_encontradas || 0,
        ubica_no_encontradas: rUbica.ubica_no_encontradas || 0,
        ubica_pendientes: rUbica.ubica_pendientes || 0
      },
      ultimasPlacas: ultimasPlacas.rows,
      errores: errores.rows
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

exports.exportarDashboardExcel = async (req, res) => {
  try {
    const { fechaInicio, fechaFin } = req.query;

    let params = [];
    let whereClause = "";
    if (fechaInicio && fechaFin) {
      whereClause = "WHERE cp.fecha_consulta::date BETWEEN $1 AND $2";
      params = [fechaInicio, fechaFin];
    }

    const result = await pool.query(`
      SELECT
        cp.placa,
        cp.estado_consulta AS consulta_placa_exitosa,
        cp.fecha_consulta AS fecha_consulta_placa,
        rstp.tipo_identificacion_propietario,
        rstp.numero_identificacion_propietario,
        rstp.nombre_razon_social_propietario,
        rdv.clase, rdv.marca, rdv.linea, rdv.servicio, rdv.color, rdv.modelo,
        rdv.estado_consulta AS datos_vehiculo_exitoso,
        rdv.error_consulta,
        rdv.fecha_consulta AS fecha_consulta_datos_vehiculo
      FROM consultas_placas cp
      LEFT JOIN runt_soat_tecno_propietario rstp ON rstp.fk_consul_placa = cp.id_consul_placa
      LEFT JOIN runt_datos_vehiculos rdv ON rdv.fk_consul_placa = cp.id_consul_placa
      ${whereClause}
      ORDER BY COALESCE(rdv.fecha_consulta, rstp.fecha_consulta, cp.fecha_consulta) DESC
    `, params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dashboard');

    sheet.columns = [
      { header: 'Placa', key: 'placa', width: 15 },
      { header: 'Consulta placa exitosa', key: 'consulta_placa_exitosa', width: 25 },
      { header: 'Fecha consulta placa', key: 'fecha_consulta_placa', width: 25 },
      { header: 'Tipo ID propietario', key: 'tipo_identificacion_propietario', width: 25 },
      { header: 'Número ID propietario', key: 'numero_identificacion_propietario', width: 25 },
      { header: 'Nombre propietario', key: 'nombre_razon_social_propietario', width: 35 },
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

    result.rows.forEach(row => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.autoFilter = { from: 'A1', to: 'O1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=dashboard-consultas.xlsx');
    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
