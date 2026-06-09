const pool = require('../utils/db');

let _tablaHistorialLiquidacionesCreada = false;

async function asegurarTablaHistorialLiquidaciones() {
  if (_tablaHistorialLiquidacionesCreada) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS historial_liquidaciones (
        id SERIAL PRIMARY KEY,
        placa VARCHAR(20) NOT NULL,
        tramites TEXT,
        total_tramites INTEGER DEFAULT 0,
        exitosa BOOLEAN DEFAULT true,
        error TEXT,
        fecha_consulta TIMESTAMP DEFAULT NOW()
      )
    `);
    _tablaHistorialLiquidacionesCreada = true;
  } catch (err) {
    console.error('Error creando historial_liquidaciones:', err.message);
  }
}

/**
 * Endpoint unificado de historial.
 * GET /api/historial
 *
 * Query params:
 *   - modulo: 'todos' | 'consulta-placa' | 'datos-vehiculo' | 'personas-direcciones' | 'liquidacion'
 *   - fechaInicio: YYYY-MM-DD (opcional)
 *   - fechaFin: YYYY-MM-DD (opcional)
 *   - pagina: número de página (default: 1)
 *   - limite: registros por página (default: 50, max: 500)
 */
exports.listarHistorialUnificado = async (req, res) => {
  try {
    const {
      modulo = 'todos',
      fechaInicio,
      fechaFin,
      pagina = 1,
      limite = 50
    } = req.query;

    const limiteSeguro = Math.min(Number(limite) || 50, 100000);
    const paginaSegura = Math.max(1, Number(pagina) || 1);
    const offset = (paginaSegura - 1) * limiteSeguro;

    // Construir filtro de fechas común
    let filtroFecha = '';
    const params = [];
    let idx = 1;

    if (fechaInicio && fechaFin) {
      filtroFecha = ` AND fecha >= $${idx} AND fecha <= ($${idx + 1}::date + interval '1 day')`;
      params.push(fechaInicio, fechaFin);
      idx += 2;
    } else if (fechaInicio) {
      filtroFecha = ` AND fecha >= $${idx}`;
      params.push(fechaInicio);
      idx += 1;
    } else if (fechaFin) {
      filtroFecha = ` AND fecha <= ($${idx}::date + interval '1 day')`;
      params.push(fechaFin);
      idx += 1;
    }

    // Asegurar tabla de historial de liquidaciones
    await asegurarTablaHistorialLiquidaciones();

    // Verificar si la tabla historial_liquidaciones existe (por si CREATE TABLE falló)
    const tablaLiquidacionesResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'historial_liquidaciones'
      ) as existe
    `);
    const existeTablaLiquidaciones = tablaLiquidacionesResult.rows[0]?.existe === true;

    // Construir subqueries según módulo
    const subqueries = [];

    const incluirConsultaPlaca = modulo === 'todos' || modulo === 'consulta-placa';
    const incluirDatosVehiculo = modulo === 'todos' || modulo === 'datos-vehiculo';
    const incluirPersonasDirecciones = modulo === 'todos' || modulo === 'personas-direcciones';
    const incluirLiquidacion = (modulo === 'todos' || modulo === 'liquidacion') && existeTablaLiquidaciones;

    if (incluirConsultaPlaca) {
      subqueries.push(`
        SELECT
          cp.fecha_consulta AS fecha,
          cp.placa AS placa_documento,
          'consulta-placa'::TEXT AS modulo,
          cp.estado_consulta AS estado,
          NULL::TEXT AS detalle,
          rstp.nombre_razon_social_propietario::TEXT AS propietario,
          rstp.tipo_identificacion_propietario::TEXT AS tipo_documento_propietario,
          rstp.numero_identificacion_propietario::TEXT AS numero_documento_propietario,
          NULL::TEXT AS clase,
          NULL::TEXT AS marca,
          NULL::TEXT AS linea,
          NULL::TEXT AS modelo,
          NULL::TEXT AS color,
          NULL::TEXT AS servicio,
          NULL::TEXT AS nombres,
          NULL::TEXT AS apellidos,
          NULL::TEXT AS celular,
          NULL::TEXT AS correo,
          NULL::TEXT AS tramites
        FROM consultas_placas cp
        LEFT JOIN runt_soat_tecno_propietario rstp ON rstp.fk_consul_placa = cp.id_consul_placa
        WHERE cp.estado_consulta IS NOT NULL
      `);
    }

    if (incluirDatosVehiculo) {
      subqueries.push(`
        SELECT
          rdv.fecha_consulta AS fecha,
          cp.placa AS placa_documento,
          'datos-vehiculo'::TEXT AS modulo,
          rdv.estado_consulta AS estado,
          rdv.error_consulta::TEXT AS detalle,
          NULL::TEXT AS propietario,
          NULL::TEXT AS tipo_documento_propietario,
          NULL::TEXT AS numero_documento_propietario,
          rdv.clase::TEXT AS clase,
          rdv.marca::TEXT AS marca,
          rdv.linea::TEXT AS linea,
          rdv.modelo::TEXT AS modelo,
          rdv.color::TEXT AS color,
          rdv.servicio::TEXT AS servicio,
          NULL::TEXT AS nombres,
          NULL::TEXT AS apellidos,
          NULL::TEXT AS celular,
          NULL::TEXT AS correo,
          NULL::TEXT AS tramites
        FROM runt_datos_vehiculos rdv
        INNER JOIN consultas_placas cp ON cp.id_consul_placa = rdv.fk_consul_placa
        WHERE rdv.estado_consulta IS NOT NULL
      `);
    }

    if (incluirPersonasDirecciones) {
      subqueries.push(`
        SELECT
          COALESCE(p.fecha_consulta_direccion, p.fecha_actualizacion) AS fecha,
          COALESCE(cp.placa, 'N/A') AS placa_documento,
          'personas-direcciones'::TEXT AS modulo,
          CASE WHEN p.direccion_encontrada = TRUE THEN TRUE ELSE FALSE END AS estado,
          p.error_consulta_direccion::TEXT AS detalle,
          NULL::TEXT AS propietario,
          NULL::TEXT AS tipo_documento_propietario,
          p.numero_documento::TEXT AS numero_documento_propietario,
          NULL::TEXT AS clase,
          NULL::TEXT AS marca,
          NULL::TEXT AS linea,
          NULL::TEXT AS modelo,
          NULL::TEXT AS color,
          NULL::TEXT AS servicio,
          p.nombres::TEXT AS nombres,
          p.apellidos::TEXT AS apellidos,
          p.celular::TEXT AS celular,
          p.correo::TEXT AS correo,
          NULL::TEXT AS tramites
        FROM persona_natural_propietario p
        LEFT JOIN consultas_placas cp ON cp.id_consul_placa = p.fk_consul_placa
        WHERE p.direccion_consultada = TRUE
      `);
    }

    if (incluirLiquidacion) {
      subqueries.push(`
        SELECT
          hl.fecha_consulta AS fecha,
          hl.placa AS placa_documento,
          'liquidacion'::TEXT AS modulo,
          hl.exitosa AS estado,
          hl.error::TEXT AS detalle,
          NULL::TEXT AS propietario,
          NULL::TEXT AS tipo_documento_propietario,
          NULL::TEXT AS numero_documento_propietario,
          NULL::TEXT AS clase,
          NULL::TEXT AS marca,
          NULL::TEXT AS linea,
          NULL::TEXT AS modelo,
          NULL::TEXT AS color,
          NULL::TEXT AS servicio,
          NULL::TEXT AS nombres,
          NULL::TEXT AS apellidos,
          NULL::TEXT AS celular,
          NULL::TEXT AS correo,
          hl.tramites::TEXT AS tramites
        FROM historial_liquidaciones hl
      `);
    }

    if (subqueries.length === 0) {
      return res.json({
        ok: true,
        total: 0,
        pagina: paginaSegura,
        totalPaginas: 0,
        results: []
      });
    }

    const unionQuery = subqueries.join('\n        UNION ALL\n');

    // Query con filtro de fecha y paginación
    const baseQuery = `
      SELECT * FROM (
        ${unionQuery}
      ) AS unified
      WHERE 1=1${filtroFecha}
    `;

    // Total de registros (sin paginación)
    const countResult = await pool.query(`
      SELECT COUNT(*) AS total FROM (
        ${baseQuery}
      ) AS counted
    `, params);

    const total = parseInt(countResult.rows[0]?.total || '0', 10);
    const totalPaginas = Math.max(1, Math.ceil(total / limiteSeguro));

    // Registros paginados
    params.push(limiteSeguro, offset);
    const dataResult = await pool.query(`
      ${baseQuery}
      ORDER BY fecha DESC NULLS LAST
      LIMIT $${idx} OFFSET $${idx + 1}
    `, params);

    return res.json({
      ok: true,
      total,
      pagina: paginaSegura,
      totalPaginas,
      limite: limiteSeguro,
      results: dataResult.rows
    });

  } catch (error) {
    console.error('Error en listarHistorialUnificado:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
