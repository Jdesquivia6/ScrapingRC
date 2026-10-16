const pool = require('../utils/db');
const { scrapeDireccionesPN } = require('../scraping/runtScraper');

const ORIGEN_EXCEL = 'CARGADO_POR_EXCEL';

/**
 * Valida un archivo Excel/CSV con columnas tipo_documento y numero_documento.
 * Devuelve resumen de la validación sin procesar aún.
 */
exports.validarArchivo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se envió ningún archivo' });
    }

    const XLSX = require('xlsx');
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'El archivo está vacío' });
    }

    // Verificar columnas requeridas
    const primeraFila = rows[0];
    const tieneTipoDoc = 'tipo_documento' in primeraFila;
    const tieneNumDoc = 'numero_documento' in primeraFila;

    if (!tieneTipoDoc || !tieneNumDoc) {
      return res.status(400).json({
        ok: false,
        error: 'El archivo debe contener las columnas "tipo_documento" y "numero_documento"'
      });
    }

    // Procesar filas
    const duplicadosSet = new Set();
    const duplicados = [];
    const validos = [];
    const errores = [];

    rows.forEach((row, i) => {
      const tipo = String(row.tipo_documento || '').trim().toUpperCase();
      const numero = String(row.numero_documento || '').trim();

      // Ignorar filas completamente vacías
      if (!tipo && !numero) return;

      // Validar que tenga datos
      if (!tipo || !numero) {
        errores.push({ fila: i + 2, mensaje: 'Fila vacía o sin datos suficientes' });
        return;
      }

      // Detectar duplicados dentro del mismo archivo
      const key = `${tipo}|${numero}`;
      if (duplicadosSet.has(key)) {
        duplicados.push({ fila: i + 2, tipo, numero });
        return;
      }

      duplicadosSet.add(key);
      validos.push({ tipo, numero });
    });

    res.json({
      ok: true,
      data: {
        total_filas: rows.length,
        registros_validos: validos.length,
        registros_duplicados: duplicados.length,
        registros_error: errores.length,
        documentos: validos
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Guarda documentos validados en persona_natural_propietario con origen CARGADO_POR_EXCEL.
 * Valida contra duplicados existentes y solo inserta los nuevos en lote.
 * Body: { documentos: [{ tipo: "C.C.", numero: "12345" }, ...] }
 */
exports.guardarDocumentos = async (req, res) => {
  try {
    const { documentos } = req.body;

    if (!documentos || !Array.isArray(documentos) || documentos.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe enviar un arreglo de documentos' });
    }

    // 1) Limpiar y filtrar documentos válidos
    const docsValidos = documentos.filter(d => {
      const tipo = String(d.tipo || '').trim();
      const numero = String(d.numero || '').trim();
      return tipo && numero;
    }).map(d => ({
      tipo: String(d.tipo || '').trim(),
      numero: String(d.numero || '').trim()
    }));

    if (docsValidos.length === 0) {
      return res.status(400).json({ ok: false, error: 'No hay documentos válidos para guardar' });
    }

    // 2) Verificar cuáles ya existen en la BD (cualquier origen)
    const tipos = docsValidos.map(d => d.tipo);
    const numeros = docsValidos.map(d => d.numero);

    const existentes = await pool.query(`
      SELECT DISTINCT tipo_documento, numero_documento
      FROM persona_natural_propietario
      WHERE (tipo_documento, numero_documento) IN (
        SELECT * FROM unnest($1::text[], $2::text[]) AS u(tipo, numero)
      )
    `, [tipos, numeros]);

    const existentesSet = new Set(
      existentes.rows.map(r => `${r.tipo_documento}|${r.numero_documento}`)
    );

    // 3) Filtrar solo los nuevos
    const nuevos = docsValidos.filter(d => {
      const key = `${d.tipo}|${d.numero}`;
      return !existentesSet.has(key);
    });

    const duplicados = docsValidos.length - nuevos.length;

    // 4) Insertar solo los nuevos en lote
    let insertados = 0;
    if (nuevos.length > 0) {
      const nuevosTipos = nuevos.map(d => d.tipo);
      const nuevosNumeros = nuevos.map(d => d.numero);

      const result = await pool.query(`
        INSERT INTO persona_natural_propietario (
          tipo_documento, numero_documento,
          direccion_consultada, direccion_encontrada,
          origen_registro, fecha_actualizacion
        )
        SELECT u.tipo, u.numero, FALSE, FALSE, $3, NOW()
        FROM unnest($1::text[], $2::text[]) AS u(tipo, numero)
        ON CONFLICT (tipo_documento, numero_documento) DO NOTHING
        RETURNING id_per_natural_dir
      `, [nuevosTipos, nuevosNumeros, ORIGEN_EXCEL]);

      insertados = result.rowCount;
    }

    return res.json({
      ok: true,
      insertados,
      duplicados,
      yaExistian: duplicados,
      mensaje: `${insertados} insertado(s), ${duplicados} ya existían en BD`
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Recibe lista de documentos, los busca en la BD y devuelve los que aún no tienen
 * dirección consultada (para saber cuáles procesar).
 */
exports.obtenerDocumentosParaProcesar = async (req, res) => {
  try {
    const { documentos } = req.body;

    if (!documentos || !Array.isArray(documentos) || documentos.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe enviar un arreglo de documentos' });
    }

    const resultados = [];

    for (const doc of documentos) {
      const { tipo, numero } = doc;
      const result = await pool.query(`
        SELECT
          id_per_natural_dir,
          tipo_documento,
          numero_documento,
          nombres,
          apellidos,
          CASE
            WHEN direccion_consultada = TRUE THEN 'YA_CONSULTADA'
            WHEN direccion_encontrada = FALSE AND direccion_consultada = TRUE THEN 'ERROR'
            ELSE 'PENDIENTE'
          END AS estado_proceso
        FROM persona_natural_propietario
        WHERE tipo_documento = $1 AND numero_documento = $2
        LIMIT 1
      `, [tipo, numero]);

      if (result.rows.length === 0) {
        // No existe — se creará con SCRAPING como origen
        resultados.push({ tipo, numero, existe_en_bd: false, estado_proceso: 'NUEVO' });
      } else {
        resultados.push({ ...result.rows[0], existe_en_bd: true });
      }
    }

    res.json({ ok: true, data: resultados });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Lista personas con origen CARGADO_POR_EXCEL con paginación.
 * Query params: page, limit, documento, estado, fecha_inicio, fecha_fin
 */
exports.listarResultados = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    const filtros = [];
    const params = [];
    let paramCount = 0;

    // Filtro fijo por origen
    paramCount++;
    filtros.push(`p.origen_registro = $${paramCount}`);
    params.push(ORIGEN_EXCEL);

    // Filtro opcional por documento
    if (req.query.documento) {
      paramCount++;
      filtros.push(`p.numero_documento = $${paramCount}`);
      params.push(req.query.documento);
    }

    // Filtro opcional por estado (no agrega parámetro: es una expresión literal)
    if (req.query.estado) {
      if (req.query.estado === 'ERROR') {
        filtros.push(`p.direccion_consultada = TRUE AND p.direccion_encontrada = FALSE`);
      } else if (req.query.estado === 'PENDIENTE') {
        filtros.push(`p.direccion_consultada = FALSE`);
      } else if (req.query.estado === 'CONSULTADA') {
        filtros.push(`p.direccion_encontrada = TRUE`);
      }
    }

    // Filtro opcional por rango de fechas
    if (req.query.fecha_inicio) {
      paramCount++;
      filtros.push(`DATE(p.fecha_consulta_direccion) >= $${paramCount}`);
      params.push(req.query.fecha_inicio);
    }
    if (req.query.fecha_fin) {
      paramCount++;
      filtros.push(`DATE(p.fecha_consulta_direccion) <= $${paramCount}`);
      params.push(req.query.fecha_fin);
    }

    const whereClause = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

    // Count total
    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM persona_natural_propietario p
      ${whereClause}
    `, params);

    // Datos paginados
    const dataParams = [...params, limit, offset];
    const dataResult = await pool.query(`
      SELECT
        p.id_per_natural_dir,
        p.tipo_documento,
        p.numero_documento,
        p.nombres,
        p.apellidos,
        p.direccion_consultada,
        p.direccion_encontrada,
        p.error_consulta_direccion,
        p.fecha_consulta_direccion,
        p.origen_registro
      FROM persona_natural_propietario p
      ${whereClause}
      ORDER BY p.fecha_consulta_direccion DESC NULLS LAST
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, dataParams);

    const total = parseInt(countResult.rows[0].total);

    res.json({
      ok: true,
      data: {
        results: dataResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Lista personas pendientes de consulta con origen CARGADO_POR_EXCEL.
 * Agrupa por tipo de documento para facilitar la carga en bloques.
 */
exports.listarPendientes = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);

    const result = await pool.query(`
      SELECT DISTINCT ON (p.numero_documento)
        p.id_per_natural_dir,
        p.tipo_documento,
        p.numero_documento,
        p.nombres,
        p.apellidos,
        p.direccion_consultada,
        p.direccion_encontrada,
        p.fecha_consulta_direccion
      FROM persona_natural_propietario p
      WHERE p.direccion_consultada = FALSE
        AND p.numero_documento IS NOT NULL
        AND TRIM(p.numero_documento) <> ''
        AND p.origen_registro = $1
      ORDER BY p.numero_documento, p.fecha_actualizacion DESC
      LIMIT $2
    `, [ORIGEN_EXCEL, limit]);

    const personas = result.rows;

    // Agrupar por tipo de documento
    const gruposMap = {};
    for (const persona of personas) {
      const tipo = persona.tipo_documento || 'SIN_TIPO';
      if (!gruposMap[tipo]) {
        gruposMap[tipo] = { tipoDocumento: tipo, documentos: [], count: 0 };
      }
      gruposMap[tipo].documentos.push(persona.numero_documento);
      gruposMap[tipo].count++;
    }

    return res.json({
      ok: true,
      total: personas.length,
      documentos: personas.map(p => p.numero_documento),
      grupos: Object.values(gruposMap)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Lista historial de personas consultadas con origen CARGADO_POR_EXCEL.
 * Incluye dirección completa para exportación a Excel.
 */
exports.listarHistorial = async (req, res) => {
  try {
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
        d.direccion,
        d.municio_departamento,
        d.telefono,
        d.tipo_direccion
      FROM persona_natural_propietario p
      LEFT JOIN direcciones d ON d.id_direcciones = p.fk_direcciones
      WHERE p.direccion_consultada = TRUE
        AND p.origen_registro = $1
      ORDER BY p.numero_documento, COALESCE(p.fecha_consulta_direccion, p.fecha_actualizacion) DESC
      ${limit !== null ? 'LIMIT $2' : ''}
    `, limit !== null ? [ORIGEN_EXCEL, limit] : [ORIGEN_EXCEL]);

    return res.json({
      ok: true,
      total: result.rows.length,
      results: result.rows
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Elimina documentos pendientes con origen CARGADO_POR_EXCEL.
 * Solo borra los que aún no han sido consultados (direccion_consultada = FALSE).
 */
exports.limpiarDocumentos = async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM persona_natural_propietario
      WHERE origen_registro = $1
        AND (direccion_consultada = FALSE OR direccion_consultada IS NULL)
    `, [ORIGEN_EXCEL]);

    return res.json({
      ok: true,
      eliminados: result.rowCount,
      mensaje: `${result.rowCount} documento(s) eliminado(s)`
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/* ════════════════════════════════════════════════════════════════
   INTEGRACIONES API  (separadas a propósito de fotodetección/Excel)
   Nunca se mezclan con el endpoint /pendientes existente.
   ════════════════════════════════════════════════════════════════ */

/**
 * Resumen de pendientes por origen (solo servicios API).
 * GET /origenes-api
 */
exports.listarOrigenesApi = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.origen_registro AS origen, COUNT(*)::int AS total
      FROM persona_natural_propietario p
      WHERE p.direccion_consultada = FALSE
        AND p.origen_registro LIKE 'API_%'
        AND p.numero_documento IS NOT NULL
        AND TRIM(p.numero_documento) <> ''
      GROUP BY p.origen_registro
      ORDER BY COUNT(*) DESC, p.origen_registro ASC
    `);

    const total = result.rows.reduce((suma, fila) => suma + fila.total, 0);

    return res.json({ ok: true, total, origenes: result.rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Pendientes provenientes EXCLUSIVAMENTE de servicios API.
 * GET /pendientes-api?limit=1000&origen=API_CONTRAVENCIONES
 *
 * - `origenes` siempre devuelve los totales reales por origen (sin límite).
 * - `grupos` devuelve los documentos listos para el textarea, opcionalmente
 *   filtrados por un origen concreto y acotados por `limit`.
 */
exports.listarPendientesApi = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 1000, 50000);
    const origenFiltro = req.query.origen ? String(req.query.origen).trim() : '';

    // 1) Resumen por origen (siempre completo)
    const resumenResult = await pool.query(`
      SELECT p.origen_registro AS origen, COUNT(*)::int AS total
      FROM persona_natural_propietario p
      WHERE p.direccion_consultada = FALSE
        AND p.origen_registro LIKE 'API_%'
        AND p.numero_documento IS NOT NULL
        AND TRIM(p.numero_documento) <> ''
      GROUP BY p.origen_registro
      ORDER BY COUNT(*) DESC, p.origen_registro ASC
    `);

    // 2) Documentos para el textarea
    const params = [];
    let where = `
      WHERE p.direccion_consultada = FALSE
        AND p.origen_registro LIKE 'API_%'
        AND p.numero_documento IS NOT NULL
        AND TRIM(p.numero_documento) <> ''
    `;

    if (origenFiltro) {
      if (!/^API_[A-Za-z0-9_]+$/.test(origenFiltro)) {
        return res.status(400).json({ ok: false, error: 'Origen inválido (debe iniciar con API_)' });
      }
      params.push(origenFiltro);
      where += ` AND p.origen_registro = $${params.length}`;
    }

    params.push(limit);
    const result = await pool.query(`
      SELECT DISTINCT ON (p.numero_documento)
        p.tipo_documento,
        p.numero_documento,
        p.origen_registro
      FROM persona_natural_propietario p
      ${where}
      ORDER BY p.numero_documento, p.fecha_actualizacion DESC
      LIMIT $${params.length}
    `, params);

    // 3) Agrupar por origen y tipo de documento
    const gruposMap = new Map();
    for (const fila of result.rows) {
      const origen = fila.origen_registro;
      const tipo = fila.tipo_documento || 'SIN_TIPO';
      const clave = `${origen}||${tipo}`;
      if (!gruposMap.has(clave)) {
        gruposMap.set(clave, { origen, tipoDocumento: tipo, documentos: [], count: 0 });
      }
      const grupo = gruposMap.get(clave);
      grupo.documentos.push(fila.numero_documento);
      grupo.count++;
    }

    const grupos = Array.from(gruposMap.values());
    const total = resumenResult.rows.reduce((suma, fila) => suma + fila.total, 0);

    return res.json({
      ok: true,
      total,
      origenes: resumenResult.rows,
      grupos,
      documentos: result.rows.map(f => f.numero_documento)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

/**
 * Elimina pendientes provenientes de servicios API.
 * DELETE /limpiar-api?origen=API_CONTRAVENCIONES
 * Sin ?origen borra todos los pendientes API_.
 */
exports.limpiarDocumentosApi = async (req, res) => {
  try {
    const origenFiltro = req.query.origen ? String(req.query.origen).trim() : '';
    const params = [];

    let where = `
      WHERE origen_registro LIKE 'API_%'
        AND (direccion_consultada = FALSE OR direccion_consultada IS NULL)
    `;

    if (origenFiltro) {
      if (!/^API_[A-Za-z0-9_]+$/.test(origenFiltro)) {
        return res.status(400).json({ ok: false, error: 'Origen inválido (debe iniciar con API_)' });
      }
      params.push(origenFiltro);
      where += ` AND origen_registro = $${params.length}`;
    }

    const result = await pool.query(`
      DELETE FROM persona_natural_propietario
      ${where}
    `, params);

    return res.json({
      ok: true,
      eliminados: result.rowCount,
      origen: origenFiltro || 'TODOS',
      mensaje: `${result.rowCount} pendiente(s) de servicios API eliminado(s)`
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
