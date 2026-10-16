const pool = require('../utils/db');
const {
  scrapeDireccionesPN,
  scrapeDireccionesPNBatch
} = require('../scraping/runtScraper');

exports.consultarDireccionesPN = async (req, res) => {
  try {
    const { tipoDocumento, numeroDocumento } = req.body;

    if (!tipoDocumento || !numeroDocumento) {
      return res.status(400).json({
        ok: false,
        error: 'tipoDocumento y numeroDocumento son obligatorios'
      });
    }

    const data = await scrapeDireccionesPN({
      tipoDocumento,
      numeroDocumento
    });

    return res.json({
      ok: data.ok,
      data
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.consultarDireccionesPNBatch = async (req, res) => {
  try {
    const { tipoDocumento, documentos } = req.body;

    if (!tipoDocumento || !Array.isArray(documentos) || documentos.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'tipoDocumento y documentos[] son obligatorios'
      });
    }

    const docsSanitized = documentos
      .map(d => String(d).trim())
      .filter(Boolean);

    if (docsSanitized.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'documentos[] está vacío luego de limpiar datos'
      });
    }

    const docsLimited = docsSanitized.slice(0, 1000);

    const results = await scrapeDireccionesPNBatch({
      tipoDocumento,
      documentos: docsLimited
    });

    return res.json({
      ok: true,
      tipoDocumento,
      requested: documentos.length,
      processed: results.length,
      exitosas: results.filter(r => r.ok).length,
      fallidas: results.filter(r => !r.ok).length,
      guardadas: results.filter(r => r?.db?.saved).length,
      sinDatos: results.filter(r => r.noData).length,
      detenidoPorSesion: results.some(r => r.sessionExpired),
      results
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

function quitarTildes(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function mapTipoDocumentoParaRunt(tipoDocumento) {
  const texto = quitarTildes(tipoDocumento)
    .trim()
    .toUpperCase();

  if (
    texto.includes('CEDULA CIUDADANIA') ||
    texto.includes('C.C') ||
    texto === 'CC'
  ) {
    return 'C.C. Cédula Ciudadanía';
  }

  if (
    texto.includes('CEDULA EXTRANJERIA') ||
    texto.includes('C.E') ||
    texto === 'CE'
  ) {
    return 'C.E. Cédula Extranjería';
  }

  if (texto.includes('NIT')) {
    return 'NIT';
  }

  if (texto.includes('PASAPORTE')) {
    return 'Pasaporte';
  }

  return tipoDocumento;
}

exports.listarPersonasPendientesDirecciones = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);

    // Filtro opcional por origen. Sin ?origen el comportamiento es EXACTAMENTE
    // el mismo que antes (trae todos los pendientes sin discriminar origen).
    const params = [limit];
    let filtroOrigen = '';
    if (req.query.origen) {
      const origen = String(req.query.origen).trim();
      if (!/^[A-Za-z0-9_]+$/.test(origen)) {
        return res.status(400).json({ ok: false, error: 'Origen inválido' });
      }
      params.push(origen);
      filtroOrigen = `AND p.origen_registro = $${params.length}`;
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (p.numero_documento)
        p.id_per_natural_dir,
        p.tipo_documento,
        p.numero_documento,
        p.nombres,
        p.apellidos,
        p.estado_runt_persona,
        p.celular,
        p.correo,
        p.fk_consul_placa,
        p.origen_registro,
        cp.placa,
        p.direccion_consultada,
        p.direccion_encontrada,
        p.error_consulta_direccion,
        p.fecha_consulta_direccion,
        p.fecha_actualizacion
      FROM persona_natural_propietario p
      LEFT JOIN consultas_placas cp
        ON cp.id_consul_placa = p.fk_consul_placa
      WHERE p.direccion_consultada = FALSE
        AND p.numero_documento IS NOT NULL
        AND TRIM(p.numero_documento) <> ''
        ${filtroOrigen}
      ORDER BY p.numero_documento, p.fecha_actualizacion DESC
      LIMIT $1
    `, params);

    const personas = result.rows.map(row => ({
      ...row,
      tipoDocumentoConsulta: mapTipoDocumentoParaRunt(row.tipo_documento)
    }));

    const gruposMap = {};

    for (const persona of personas) {
      const tipo = persona.tipoDocumentoConsulta || persona.tipo_documento || 'SIN_TIPO';

      if (!gruposMap[tipo]) {
        gruposMap[tipo] = {
          tipoDocumento: tipo,
          documentos: [],
          personas: []
        };
      }

      gruposMap[tipo].documentos.push(persona.numero_documento);
      gruposMap[tipo].personas.push(persona);
    }

    return res.json({
      ok: true,
      total: personas.length,
      documentos: personas.map(p => p.numero_documento),
      personas,
      grupos: Object.values(gruposMap)
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.listarHistorialDirecciones = async (req, res) => {
  try {
    // Sin ?limit → sin límite. Con ?limit → respeta hasta 100000
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100000) : null;

    const result = await pool.query(`
      SELECT DISTINCT ON (p.numero_documento)
        p.tipo_documento,
        p.numero_documento,
        p.nombres,
        p.apellidos,
        p.celular,
        p.correo,
        p.direccion_consultada,
        p.direccion_encontrada,
        p.error_consulta_direccion,
        p.fecha_consulta_direccion,
        p.fecha_actualizacion,
        cp.placa,
        d.direccion,
        d.municio_departamento,
        d.telefono,
        d.tipo_direccion
      FROM persona_natural_propietario p
      LEFT JOIN direcciones d
        ON d.id_direcciones = p.fk_direcciones
      LEFT JOIN consultas_placas cp
        ON cp.id_consul_placa = p.fk_consul_placa
      WHERE p.direccion_consultada = TRUE
      ORDER BY p.numero_documento, COALESCE(p.fecha_consulta_direccion, p.fecha_actualizacion) DESC
      ${limit !== null ? 'LIMIT $1' : ''}
    `, limit !== null ? [limit] : []);

    return res.json({
      ok: true,
      total: result.rows.length,
      results: result.rows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

/**
 * Vista consolidada general de personas.
 * ORIGEN ya no depende del Excel: soporta SCRAPING (fotodeteccion),
 * CARGADO_POR_EXCEL y cualquier API_<CLIENTE>.
 *
 * GET /personas/direcciones/consolidado
 *   ?page=1&limit=20&origen=&estado=&documento=&fecha_inicio=&fecha_fin=
 */
exports.listarConsolidado = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = (page - 1) * limit;

    // Documentos con un trabajo activo en este momento (una sola consulta)
    const enProcesoRows = await pool.query(`
      SELECT DISTINCT wji.documento
      FROM worker_job_items wji
      JOIN worker_jobs wj ON wj.id_job = wji.fk_job
      WHERE wj.estado = 'procesando'
        AND wji.estado = 'procesando'
        AND wji.documento IS NOT NULL
    `);
    const enProceso = enProcesoRows.rows.map(r => r.documento);

    const filtros = [];
    const params = [enProceso]; // $1

    if (req.query.origen) {
      const origen = String(req.query.origen).trim();
      if (!/^[A-Za-z0-9_]+$/.test(origen)) {
        return res.status(400).json({ ok: false, error: 'Origen inválido' });
      }
      params.push(origen);
      filtros.push(`t.origen_registro = $${params.length}`);
    }

    if (req.query.documento) {
      params.push(String(req.query.documento).trim());
      filtros.push(`t.numero_documento = $${params.length}`);
    }

    if (req.query.estado) {
      const estado = String(req.query.estado).trim().toUpperCase();
      const permitidos = ['PENDIENTE', 'EN_PROCESO', 'ENCONTRADA', 'SIN_INFORMACION', 'ERROR'];
      if (!permitidos.includes(estado)) {
        return res.status(400).json({ ok: false, error: 'Estado inválido' });
      }
      params.push(estado);
      filtros.push(`t.estado_publico = $${params.length}`);
    }

    if (req.query.fecha_inicio) {
      params.push(req.query.fecha_inicio);
      filtros.push(`DATE(t.fecha_consulta_direccion) >= $${params.length}`);
    }
    if (req.query.fecha_fin) {
      params.push(req.query.fecha_fin);
      filtros.push(`DATE(t.fecha_consulta_direccion) <= $${params.length}`);
    }

    const whereClause = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

    const conteo = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT
          p.numero_documento,
          p.direccion_consultada,
          p.direccion_encontrada,
          p.error_consulta_direccion,
          CASE
            WHEN p.direccion_consultada = FALSE OR p.direccion_consultada IS NULL THEN
              CASE WHEN p.numero_documento = ANY($1::text[]) THEN 'EN_PROCESO' ELSE 'PENDIENTE' END
            WHEN p.direccion_encontrada = TRUE THEN 'ENCONTRADA'
            WHEN p.error_consulta_direccion IS NOT NULL
              AND p.error_consulta_direccion !~* '(no se (encontr|encuentr)|sin (informaci|dat|resultados)|no existe|no registra|no aplica)'
              THEN 'ERROR'
            ELSE 'SIN_INFORMACION'
          END AS estado_publico,
          p.origen_registro,
          p.fecha_consulta_direccion
        FROM persona_natural_propietario p
      ) t
      ${whereClause}
    `, params);

    params.push(limit, offset);
    const resultado = await pool.query(`
      SELECT * FROM (
        SELECT
          p.id_per_natural_dir,
          p.tipo_documento,
          p.numero_documento,
          p.nombres,
          p.apellidos,
          p.celular,
          p.correo,
          p.origen_registro,
          p.direccion_consultada,
          p.direccion_encontrada,
          p.error_consulta_direccion,
          p.fecha_consulta_direccion,
          p.fecha_actualizacion,
          cp.placa,
          d.direccion,
          d.municio_departamento,
          d.telefono,
          d.tipo_direccion,
          CASE
            WHEN p.direccion_consultada = FALSE OR p.direccion_consultada IS NULL THEN
              CASE WHEN p.numero_documento = ANY($1::text[]) THEN 'EN_PROCESO' ELSE 'PENDIENTE' END
            WHEN p.direccion_encontrada = TRUE THEN 'ENCONTRADA'
            WHEN p.error_consulta_direccion IS NOT NULL
              AND p.error_consulta_direccion !~* '(no se (encontr|encuentr)|sin (informaci|dat|resultados)|no existe|no registra|no aplica)'
              THEN 'ERROR'
            ELSE 'SIN_INFORMACION'
          END AS estado_publico
        FROM persona_natural_propietario p
        LEFT JOIN direcciones d ON d.id_direcciones = p.fk_direcciones
        LEFT JOIN consultas_placas cp ON cp.id_consul_placa = p.fk_consul_placa
      ) t
      ${whereClause}
      ORDER BY COALESCE(t.fecha_consulta_direccion, t.fecha_actualizacion) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    // Opciones para el filtro de origen
    const origenes = await pool.query(`
      SELECT COALESCE(origen_registro, '(sin origen)') AS origen, COUNT(*)::int AS total
      FROM persona_natural_propietario
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1 ASC
    `);

    const total = conteo.rows[0].total;

    return res.json({
      ok: true,
      data: {
        results: resultado.rows,
        origenes: origenes.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
