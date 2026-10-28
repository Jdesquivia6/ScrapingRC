
const pool = require("../utils/db");

let tablaLiquidacionesCreada = false;

// ======================================================
// TABLA DE LIQUIDACIONES
// ======================================================

async function asegurarTablaHistorialLiquidaciones() {
  if (tablaLiquidacionesCreada) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial_liquidaciones (
      id SERIAL PRIMARY KEY,
      placa VARCHAR(20) NOT NULL,
      tramites TEXT,
      total_tramites INTEGER DEFAULT 0,
      exitosa BOOLEAN DEFAULT TRUE,
      error TEXT,
      fecha_consulta TIMESTAMP DEFAULT NOW()
    )
  `);

  tablaLiquidacionesCreada = true;
}

// ======================================================
// HISTORIAL UNIFICADO
// GET /api/historial
// ======================================================

exports.listarHistorialUnificado = async (req, res) => {
  try {
    const {
      modulo = "todos",
      fechaInicio,
      fechaFin,
      pagina = 1,
      limite = 50
    } = req.query;

    const permitidos = [
      "todos",
      "consulta-placa",
      "datos-vehiculo",
      "personas-direcciones",
      "liquidacion"
    ];

    if (!permitidos.includes(modulo)) {
      return res.status(400).json({
        ok: false,
        error: "Módulo no válido"
      });
    }

    const validarFecha = valor => {
      if (!valor) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
      const fecha = new Date(`${valor}T00:00:00Z`);
      return !Number.isNaN(fecha.getTime()) &&
        fecha.toISOString().slice(0, 10) === valor;
    };

    if (!validarFecha(fechaInicio) || !validarFecha(fechaFin)) {
      return res.status(400).json({
        ok: false,
        error: "Fecha inválida. Usa YYYY-MM-DD"
      });
    }

    if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
      return res.status(400).json({
        ok: false,
        error: "La fecha inicial supera la fecha final"
      });
    }

    const paginaSegura = Math.max(
      1,
      Math.floor(Number(pagina) || 1)
    );

    const limiteSeguro = Math.max(
      1,
      Math.min(Math.floor(Number(limite) || 50), 5000)
    );

    const offset = (paginaSegura - 1) * limiteSeguro;

    await asegurarTablaHistorialLiquidaciones();

    const subqueries = [];

    // ==================================================
    // CONSULTA DE PLACAS
    // Agrupa propietarios por consulta sin duplicar filas.
    // ==================================================

    if (modulo === "todos" || modulo === "consulta-placa") {
      subqueries.push(`
        SELECT
          cp.fecha_consulta AS fecha,
          cp.placa::TEXT AS placa_documento,
          'consulta-placa'::TEXT AS modulo,
          cp.estado_consulta AS estado,
          NULL::TEXT AS detalle,

          propietarios.propietario,
          propietarios.tipo_documento_propietario,
          propietarios.numero_documento_propietario,

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

          NULL::TEXT AS direccion,
          NULL::TEXT AS municipio_departamento,
          NULL::TEXT AS telefono_direccion,
          NULL::TEXT AS tipo_direccion,

          NULL::TEXT AS tramites

        FROM consultas_placas cp

        LEFT JOIN LATERAL (
          SELECT
            STRING_AGG(
              DISTINCT NULLIF(
                BTRIM(rstp.nombre_razon_social_propietario::TEXT),
                ''
              ),
              ' / '
            ) AS propietario,

            STRING_AGG(
              DISTINCT NULLIF(
                BTRIM(rstp.tipo_identificacion_propietario::TEXT),
                ''
              ),
              ' / '
            ) AS tipo_documento_propietario,

            STRING_AGG(
              DISTINCT NULLIF(
                BTRIM(rstp.numero_identificacion_propietario::TEXT),
                ''
              ),
              ' / '
            ) AS numero_documento_propietario

          FROM runt_soat_tecno_propietario rstp
          WHERE rstp.fk_consul_placa = cp.id_consul_placa
        ) propietarios ON TRUE

        WHERE cp.estado_consulta IS NOT NULL
      `);
    }

    // ==================================================
    // DATOS DEL VEHÍCULO
    // ==================================================

    if (modulo === "todos" || modulo === "datos-vehiculo") {
      subqueries.push(`
        SELECT
          rdv.fecha_consulta AS fecha,
          cp.placa::TEXT AS placa_documento,
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

          NULL::TEXT AS direccion,
          NULL::TEXT AS municipio_departamento,
          NULL::TEXT AS telefono_direccion,
          NULL::TEXT AS tipo_direccion,

          NULL::TEXT AS tramites

        FROM runt_datos_vehiculos rdv
        INNER JOIN consultas_placas cp
          ON cp.id_consul_placa = rdv.fk_consul_placa

        WHERE rdv.estado_consulta IS NOT NULL
      `);
    }

    // ==================================================
    // PERSONAS Y DIRECCIONES RUNT
    // Relaciones confirmadas en PostgreSQL:
    // p.fk_direcciones = d.id_direcciones
    // ==================================================

    if (modulo === "todos" || modulo === "personas-direcciones") {
      subqueries.push(`
        SELECT
          COALESCE(
            p.fecha_consulta_direccion,
            p.fecha_actualizacion
          ) AS fecha,

          COALESCE(
            cp.placa,
            p.numero_documento,
            'N/A'
          )::TEXT AS placa_documento,

          'personas-direcciones'::TEXT AS modulo,

          CASE
            WHEN p.direccion_encontrada = TRUE THEN TRUE
            ELSE FALSE
          END AS estado,

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

          d.direccion::TEXT AS direccion,
          d.municio_departamento::TEXT AS municipio_departamento,
          d.telefono::TEXT AS telefono_direccion,
          d.tipo_direccion::TEXT AS tipo_direccion,

          NULL::TEXT AS tramites

        FROM persona_natural_propietario p

        LEFT JOIN consultas_placas cp
          ON cp.id_consul_placa = p.fk_consul_placa

        LEFT JOIN direcciones d
          ON d.id_direcciones = p.fk_direcciones

        WHERE p.direccion_consultada = TRUE
      `);
    }

    // ==================================================
    // LIQUIDACIONES
    // ==================================================

    if (modulo === "todos" || modulo === "liquidacion") {
      subqueries.push(`
        SELECT
          hl.fecha_consulta AS fecha,
          hl.placa::TEXT AS placa_documento,
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

          NULL::TEXT AS direccion,
          NULL::TEXT AS municipio_departamento,
          NULL::TEXT AS telefono_direccion,
          NULL::TEXT AS tipo_direccion,

          hl.tramites::TEXT AS tramites

        FROM historial_liquidaciones hl
      `);
    }

    // ==================================================
    // FILTROS
    // ==================================================

    const params = [];
    const condiciones = [];

    if (fechaInicio) {
      params.push(fechaInicio);
      condiciones.push(
        `fecha >= $${params.length}::date`
      );
    }

    if (fechaFin) {
      params.push(fechaFin);
      condiciones.push(
        `fecha < ($${params.length}::date + INTERVAL '1 day')`
      );
    }

    const where = condiciones.length
      ? `WHERE ${condiciones.join(" AND ")}`
      : "";

    const baseQuery = `
      SELECT *
      FROM (
        ${subqueries.join("\n UNION ALL \n")}
      ) historial
      ${where}
    `;

    // ==================================================
    // CONTEO GLOBAL
    // ==================================================

    const resumen = await pool.query(`
      SELECT
        COUNT(*)::BIGINT AS total,
        COUNT(*) FILTER (
          WHERE estado IS TRUE
        )::BIGINT AS exitosas,
        COUNT(*) FILTER (
          WHERE estado IS NOT TRUE
        )::BIGINT AS fallidas
      FROM (${baseQuery}) resumen
    `, params);

    const total = Number(resumen.rows[0]?.total || 0);
    const totalExitosas = Number(resumen.rows[0]?.exitosas || 0);
    const totalFallidas = Number(resumen.rows[0]?.fallidas || 0);
    const totalPaginas = Math.max(
      1,
      Math.ceil(total / limiteSeguro)
    );

    // ==================================================
    // REGISTROS PAGINADOS
    // ==================================================

    const idxLimite = params.length + 1;
    const idxOffset = params.length + 2;

    const valores = [
      ...params,
      limiteSeguro,
      offset
    ];

    const datos = await pool.query(`
      ${baseQuery}
      ORDER BY
        fecha DESC NULLS LAST,
        modulo,
        placa_documento
      LIMIT $${idxLimite}
      OFFSET $${idxOffset}
    `, valores);

    return res.json({
      ok: true,
      total,
      totalExitosas,
      totalFallidas,
      pagina: paginaSegura,
      totalPaginas,
      limite: limiteSeguro,
      results: datos.rows
    });

  } catch (error) {
    console.error(
      "Error en listarHistorialUnificado:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
