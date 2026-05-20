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
      ORDER BY p.numero_documento, p.fecha_actualizacion DESC
      LIMIT $1
    `, [limit]);

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
    const limit = Math.min(Number(req.query.limit) || 100, 1000);

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
      LIMIT $1
    `, [limit]);

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
