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
        documentos: validos.slice(0, 100) // Preview primeros 100
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
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

    // Filtro opcional por estado
    if (req.query.estado) {
      paramCount++;
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
        p.origen_registro,
        p.created_at,
        p.updated_at
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
