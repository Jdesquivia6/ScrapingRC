
const pool = require('../utils/db');
const ExcelJS = require('exceljs');

// ============================================================
// UTILIDADES - FILTROS DE FECHA
// ============================================================

const obtenerFiltros = (query) => {
  const { fechaInicio, fechaFin } = query;

  // Modo global: sin filtros
  if (!fechaInicio && !fechaFin) {
    return {
      tieneFiltro: false,
      fechaInicio: null,
      fechaFin: null,
      params: []
    };
  }

  // No permitir rangos incompletos
  if (!fechaInicio || !fechaFin) {
    const error = new Error(
      'Debe proporcionar fechaInicio y fechaFin.'
    );
    error.status = 400;
    throw error;
  }

  // Validar formato YYYY-MM-DD
  const formatoFecha = /^\d{4}-\d{2}-\d{2}$/;

  if (
    !formatoFecha.test(fechaInicio) ||
    !formatoFecha.test(fechaFin)
  ) {
    const error = new Error(
      'Formato de fecha inválido. Use YYYY-MM-DD.'
    );
    error.status = 400;
    throw error;
  }

  // Validar que sean fechas reales
  const fechaValida = (valor) => {
    const fecha = new Date(`${valor}T00:00:00Z`);

    return (
      !Number.isNaN(fecha.getTime()) &&
      fecha.toISOString().slice(0, 10) === valor
    );
  };

  if (
    !fechaValida(fechaInicio) ||
    !fechaValida(fechaFin)
  ) {
    const error = new Error(
      'Las fechas proporcionadas no son válidas.'
    );
    error.status = 400;
    throw error;
  }

  if (fechaInicio > fechaFin) {
    const error = new Error(
      'La fecha de inicio no puede ser mayor que la fecha final.'
    );
    error.status = 400;
    throw error;
  }

  return {
    tieneFiltro: true,
    fechaInicio,
    fechaFin,
    params: [fechaInicio, fechaFin]
  };
};

// ============================================================
// OBTENER DASHBOARD
// GET /
// GET /?fechaInicio=2026-10-01&fechaFin=2026-10-23
// ============================================================

exports.obtenerDashboard = async (req, res) => {
  try {
    const {
      tieneFiltro,
      fechaInicio,
      fechaFin,
      params
    } = obtenerFiltros(req.query);

    // --------------------------------------------------------
    // 1. FILTROS SQL
    // --------------------------------------------------------

    const filtroFechaPlacas = tieneFiltro
      ? 'WHERE cp.fecha_consulta::date BETWEEN $1::date AND $2::date'
      : '';

    const filtroFechaVehiculos = tieneFiltro
      ? 'WHERE rdv.fecha_consulta::date BETWEEN $1::date AND $2::date'
      : '';

    // IMPORTANTE:
    // Ubicabilidad ya tiene un WHERE de origen_registro.
    // Por eso se utiliza AND en el filtro de fechas.
    const filtroFechaUbica = tieneFiltro
      ? 'AND pnp.fecha_consulta_direccion::date BETWEEN $1::date AND $2::date'
      : '';

    const filtroErrores = tieneFiltro
      ? 'AND rdv.fecha_consulta::date BETWEEN $1::date AND $2::date'
      : '';

    // --------------------------------------------------------
    // 2. CONSULTAS SQL
    // --------------------------------------------------------

    const consultaPlacas = `
      SELECT
        COUNT(*)::int AS total_placas,

        COUNT(*) FILTER (
          WHERE cp.estado_consulta = true
        )::int AS consultas_exitosas,

        COUNT(*) FILTER (
          WHERE cp.estado_consulta IS NULL
             OR cp.estado_consulta = false
        )::int AS pendientes

      FROM consultas_placas cp

      ${filtroFechaPlacas}
    `;

    const consultaVehiculos = `
      SELECT
        COUNT(*)::int AS datos_vehiculo_total,

        COUNT(*) FILTER (
          WHERE rdv.estado_consulta = true
        )::int AS datos_vehiculo_exitosos,

        COUNT(*) FILTER (
          WHERE rdv.estado_consulta = false
        )::int AS datos_vehiculo_fallidos

      FROM runt_datos_vehiculos rdv

      ${filtroFechaVehiculos}
    `;

    const consultaUbicabilidad = `
      SELECT
        COUNT(*)::int AS total_ubicabilidad,

        COUNT(*) FILTER (
          WHERE pnp.direccion_encontrada = true
        )::int AS ubica_encontradas,

        COUNT(*) FILTER (
          WHERE pnp.direccion_consultada = true
            AND pnp.direccion_encontrada = false
        )::int AS ubica_no_encontradas,

        COUNT(*) FILTER (
          WHERE pnp.direccion_consultada = false
             OR pnp.direccion_consultada IS NULL
        )::int AS ubica_pendientes

      FROM persona_natural_propietario pnp

      WHERE pnp.origen_registro = 'CARGADO_POR_EXCEL'

      ${filtroFechaUbica}
    `;

    // --------------------------------------------------------
    // 3. ÚLTIMAS CONSULTAS DE PLACA
    // --------------------------------------------------------

    const consultaUltimasPlacas = `
      SELECT
        cp.placa,
        cp.estado_consulta,
        cp.fecha_consulta,

        rdv.estado_consulta AS estado_datos_vehiculo,
        rdv.error_consulta,
        rdv.fecha_consulta AS fecha_consulta_datos_vehiculo

      FROM consultas_placas cp

      LEFT JOIN LATERAL (
        SELECT
          v.estado_consulta,
          v.error_consulta,
          v.fecha_consulta
        FROM runt_datos_vehiculos v
        WHERE v.fk_consul_placa = cp.id_consul_placa
        ORDER BY v.fecha_consulta DESC NULLS LAST
        LIMIT 1
      ) rdv ON true

      ${filtroFechaPlacas}

      ORDER BY
        COALESCE(
          rdv.fecha_consulta,
          cp.fecha_consulta
        ) DESC NULLS LAST

      LIMIT 20
    `;

    // --------------------------------------------------------
    // 4. ÚLTIMOS ERRORES DE DATOS DEL VEHÍCULO
    // --------------------------------------------------------

    const consultaErrores = `
      SELECT
        cp.placa,
        rdv.error_consulta,
        rdv.fecha_consulta

      FROM runt_datos_vehiculos rdv

      INNER JOIN consultas_placas cp
        ON cp.id_consul_placa = rdv.fk_consul_placa

      WHERE rdv.estado_consulta = false

        AND rdv.error_consulta IS NOT NULL

      ${filtroErrores}

      ORDER BY
        rdv.fecha_consulta DESC NULLS LAST

      LIMIT 20
    `;

    // --------------------------------------------------------
    // 5. EJECUTAR CONSULTAS
    // --------------------------------------------------------

    const [
      resumenPlacas,
      resumenVehiculos,
      resumenUbica,
      ultimasPlacas,
      errores
    ] = await Promise.all([
      pool.query(consultaPlacas, params),
      pool.query(consultaVehiculos, params),
      pool.query(consultaUbicabilidad, params),
      pool.query(consultaUltimasPlacas, params),
      pool.query(consultaErrores, params)
    ]);

    // --------------------------------------------------------
    // 6. CONSOLIDAR RESULTADOS
    // --------------------------------------------------------

    const rPlacas = resumenPlacas.rows[0] || {};
    const rVehiculos = resumenVehiculos.rows[0] || {};
    const rUbica = resumenUbica.rows[0] || {};

    const totalPlacas = Number(rPlacas.total_placas || 0);
    const exitosasPlacas = Number(rPlacas.consultas_exitosas || 0);
    const pendientesPlacas = Number(rPlacas.pendientes || 0);

    const totalVehiculos = Number(
      rVehiculos.datos_vehiculo_total || 0
    );

    const exitososVehiculos = Number(
      rVehiculos.datos_vehiculo_exitosos || 0
    );

    const fallidosVehiculos = Number(
      rVehiculos.datos_vehiculo_fallidos || 0
    );

    const pendientesVehiculos = Math.max(
      totalVehiculos - exitososVehiculos - fallidosVehiculos,
      0
    );

    const totalUbica = Number(
      rUbica.total_ubicabilidad || 0
    );

    const encontradasUbica = Number(
      rUbica.ubica_encontradas || 0
    );

    const noEncontradasUbica = Number(
      rUbica.ubica_no_encontradas || 0
    );

    const pendientesUbica = Number(
      rUbica.ubica_pendientes || 0
    );

    // --------------------------------------------------------
    // 7. INDICADORES GENERALES
    // --------------------------------------------------------

    // Se cuentan operaciones de los tres módulos.
    // Una misma placa puede tener una operación de consulta
    // de placa y otra de consulta de datos del vehículo.

    const totalGeneral =
      totalPlacas +
      totalVehiculos +
      totalUbica;

    const totalExitosas =
      exitosasPlacas +
      exitososVehiculos +
      encontradasUbica;

    const totalPendientes =
      pendientesPlacas +
      pendientesVehiculos +
      pendientesUbica;

    // En ubicabilidad, "no encontrada" no implica
    // necesariamente un error técnico. Se agrupa
    // aquí como operación sin resultado satisfactorio.
    const totalSinResultadoErrores =
      fallidosVehiculos +
      noEncontradasUbica;

    const tasaExito = totalGeneral > 0
      ? Number(
          (
            (totalExitosas / totalGeneral) *
            100
          ).toFixed(2)
        )
      : 0;

    // --------------------------------------------------------
    // 8. RESPUESTA API
    // --------------------------------------------------------

    return res.json({
      ok: true,

      filtros: {
        fechaInicio,
        fechaFin,
        modo: tieneFiltro ? 'rango' : 'todo'
      },

      resumen: {
        // PLACAS
        total_placas: totalPlacas,
        consultas_exitosas: exitosasPlacas,
        pendientes_placas: pendientesPlacas,

        // VEHÍCULOS
        datos_vehiculo_total: totalVehiculos,
        datos_vehiculo_exitosos: exitososVehiculos,
        datos_vehiculo_fallidos: fallidosVehiculos,
        datos_vehiculo_pendientes: pendientesVehiculos,

        // UBICABILIDAD
        total_ubicabilidad: totalUbica,
        ubica_encontradas: encontradasUbica,
        ubica_no_encontradas: noEncontradasUbica,
        ubica_pendientes: pendientesUbica
      },

      // Campos adicionales para indicadores generales.
      // Se conservan los campos originales de "resumen".
      indicadoresGenerales: {
        total: totalGeneral,
        exitosas: totalExitosas,
        pendientes: totalPendientes,
        sinResultadoErrores: totalSinResultadoErrores,
        tasaExito
      },

      ultimasPlacas: ultimasPlacas.rows,
      errores: errores.rows
    });

  } catch (error) {
    console.error(
      '[DASHBOARD] Error al consultar:',
      error
    );

    return res.status(error.status || 500).json({
      ok: false,
      error:
        error.status === 400
          ? error.message
          : 'Error interno al consultar el dashboard'
    });
  }
};

// ============================================================
// EXPORTAR DASHBOARD A EXCEL
// ============================================================

exports.exportarDashboardExcel = async (req, res) => {
  try {
    const {
      tieneFiltro,
      params
    } = obtenerFiltros(req.query);

    const whereClause = tieneFiltro
      ? 'WHERE cp.fecha_consulta::date BETWEEN $1::date AND $2::date'
      : '';

    // --------------------------------------------------------
    // 1. CONSULTAR INFORMACIÓN
    // --------------------------------------------------------

    const result = await pool.query(`
      SELECT
        cp.placa,

        cp.estado_consulta AS consulta_placa_exitosa,
        cp.fecha_consulta AS fecha_consulta_placa,

        rstp.tipo_identificacion_propietario,
        rstp.numero_identificacion_propietario,
        rstp.nombre_razon_social_propietario,

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

      ${whereClause}

      ORDER BY
        COALESCE(
          rdv.fecha_consulta,
          rstp.fecha_consulta,
          cp.fecha_consulta
        ) DESC NULLS LAST
    `, params);

    // --------------------------------------------------------
    // 2. CREAR ARCHIVO EXCEL
    // --------------------------------------------------------

    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'AutoCore';
    workbook.lastModifiedBy = 'AutoCore';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Dashboard');

    sheet.columns = [
      {
        header: 'Placa',
        key: 'placa',
        width: 15
      },
      {
        header: 'Consulta placa exitosa',
        key: 'consulta_placa_exitosa',
        width: 25
      },
      {
        header: 'Fecha consulta placa',
        key: 'fecha_consulta_placa',
        width: 25
      },
      {
        header: 'Tipo ID propietario',
        key: 'tipo_identificacion_propietario',
        width: 25
      },
      {
        header: 'Número ID propietario',
        key: 'numero_identificacion_propietario',
        width: 25
      },
      {
        header: 'Nombre propietario',
        key: 'nombre_razon_social_propietario',
        width: 35
      },
      {
        header: 'Clase',
        key: 'clase',
        width: 20
      },
      {
        header: 'Marca',
        key: 'marca',
        width: 20
      },
      {
        header: 'Línea',
        key: 'linea',
        width: 20
      },
      {
        header: 'Servicio',
        key: 'servicio',
        width: 20
      },
      {
        header: 'Color',
        key: 'color',
        width: 20
      },
      {
        header: 'Modelo',
        key: 'modelo',
        width: 15
      },
      {
        header: 'Datos vehículo exitoso',
        key: 'datos_vehiculo_exitoso',
        width: 25
      },
      {
        header: 'Error consulta',
        key: 'error_consulta',
        width: 45
      },
      {
        header: 'Fecha consulta datos vehículo',
        key: 'fecha_consulta_datos_vehiculo',
        width: 30
      }
    ];

    // --------------------------------------------------------
    // 3. INSERTAR REGISTROS
    // --------------------------------------------------------

    result.rows.forEach((row) => {
      sheet.addRow(row);
    });

    // --------------------------------------------------------
    // 4. FORMATO PROFESIONAL AUTOCORE
    // --------------------------------------------------------

    const encabezado = sheet.getRow(1);

    encabezado.height = 30;

    encabezado.font = {
      name: 'Arial',
      bold: true,
      size: 11,
      color: {
        argb: 'FFFFFFFF'
      }
    };

    encabezado.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: {
        argb: 'FF0095C5'
      }
    };

    encabezado.alignment = {
      vertical: 'middle',
      horizontal: 'center',
      wrapText: true
    };

    // Filtrar columnas del Excel
    sheet.autoFilter = {
      from: 'A1',
      to: 'O1'
    };

    // Congelar encabezado
    sheet.views = [
      {
        state: 'frozen',
        ySplit: 1
      }
    ];

    // Formato de fechas
    ['C', 'O'].forEach((columna) => {
      sheet.getColumn(columna).numFmt =
        'dd/mm/yyyy hh:mm';
    });

    // Estilo de las filas
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      row.alignment = {
        vertical: 'middle'
      };

      if (rowNumber % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: {
            argb: 'FFF0F7FC'
          }
        };
      }

      row.eachCell((cell) => {
        cell.border = {
          bottom: {
            style: 'hair',
            color: {
              argb: 'FFE2E8F0'
            }
          }
        };
      });
    });

    // --------------------------------------------------------
    // 5. ENVIAR EXCEL
    // --------------------------------------------------------

    const nombreArchivo =
      `dashboard-consultas-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${nombreArchivo}"`
    );

    await workbook.xlsx.write(res);

    return res.end();

  } catch (error) {
    console.error(
      '[DASHBOARD] Error exportando Excel:',
      error
    );

    if (res.headersSent) {
      return res.destroy(error);
    }

    return res.status(error.status || 500).json({
      ok: false,
      error:
        error.status === 400
          ? error.message
          : 'Error interno al exportar el dashboard'
    });
  }
};
