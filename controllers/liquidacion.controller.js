const path = require('path');
const fs = require('fs');
const pool = require('../utils/db');
const { scrapeLiquidacionTramite } = require('../scraping/liquidacionScraper');

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');

/**
 * Valores permitidos para RNA.
 */
const TRAMITES_VALIDOS = [
  'TRÁMITE MATRÍCULA INICIAL',
  'TRÁMITE INSCRIPCIÓN ALERTA'
];

const CLASIFICACIONES_VALIDAS = [
  'AUTOMOVIL',
  'MEDIDAS CAUTELARES',
  'MOTO',
  'MOTOCARRO'
];

/**
 * Valida un solo item de trámite (tramite + clasificacion).
 */
function validarItemTramite(item, index) {
  const tramite = (item.tramite || '').toString().trim().toUpperCase();
  const clasificacion = (item.clasificacion || '').toString().trim().toUpperCase();
  const errores = [];

  if (!tramite) {
    errores.push(`El trámite es obligatorio (item ${index + 1})`);
  } else if (!TRAMITES_VALIDOS.includes(tramite)) {
    errores.push(`Trámite no válido (item ${index + 1}): "${tramite}". Permitidos: ${TRAMITES_VALIDOS.join(', ')}`);
  }

  if (!clasificacion) {
    errores.push(`La clasificación es obligatoria (item ${index + 1})`);
  } else if (!CLASIFICACIONES_VALIDAS.includes(clasificacion)) {
    errores.push(`Clasificación no válida (item ${index + 1}): "${clasificacion}". Permitidas: ${CLASIFICACIONES_VALIDAS.join(', ')}`);
  }

  if (errores.length > 0) {
    return { ok: false, errores };
  }

  return {
    ok: true,
    data: { tramite, clasificacion }
  };
}

/**
 * Extrae y valida el payload completo del request.
 * Soporta tanto el formato nuevo (tramites array) como el legacy (tramite + clasificacion individual).
 */
function parsePayload(body) {
  const placa = (body.placa || '').toString().trim().toUpperCase();
  if (!placa) {
    return { ok: false, error: 'La placa es obligatoria' };
  }

  let tramites = [];

  // Formato nuevo: tramites array
  if (body.tramites && Array.isArray(body.tramites)) {
    tramites = body.tramites;
  }
  // Formato legacy: tramite + clasificacion individual
  else if (body.tramite) {
    tramites = [
      { tramite: body.tramite, clasificacion: body.clasificacion || '' }
    ];
  } else {
    return {
      ok: false,
      error: 'Debe enviar un array "tramites" con al menos un trámite, o los campos "tramite" + "clasificacion" (legacy)'
    };
  }

  if (tramites.length === 0) {
    return { ok: false, error: 'Debe enviar al menos un trámite en el array "tramites"' };
  }

  // Validar cada trámite
  const erroresGlobales = [];
  const tramitesValidos = [];
  for (let i = 0; i < tramites.length; i++) {
    const validacion = validarItemTramite(tramites[i], i);
    if (!validacion.ok) {
      erroresGlobales.push(...validacion.errores);
    } else {
      tramitesValidos.push(validacion.data);
    }
  }

  if (erroresGlobales.length > 0) {
    return { ok: false, error: erroresGlobales.join('; ') };
  }

  const fechaLiquidacion = (body.fechaLiquidacion || '').toString().trim();

  return {
    ok: true,
    data: {
      placa,
      tramites: tramitesValidos,
      fechaLiquidacion: fechaLiquidacion || undefined
    }
  };
}

/**
 * Asegura que la tabla historial_liquidaciones exista.
 */
let _tablaHistorialCreada = false;
async function asegurarTablaHistorial() {
  if (_tablaHistorialCreada) return;
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
    _tablaHistorialCreada = true;
  } catch (err) {
    console.error('Error creando historial_liquidaciones:', err.message);
  }
}

/**
 * Guarda un registro en el historial de liquidaciones.
 */
async function guardarHistorialLiquidacion({ placa, tramites, exitosa, error }) {
  try {
    await asegurarTablaHistorial();
    const tramitesStr = Array.isArray(tramites)
      ? tramites.map(t => `${t.tramite || t}`).join(', ')
      : String(tramites || '');
    const total = Array.isArray(tramites) ? tramites.length : 0;
    await pool.query(`
      INSERT INTO historial_liquidaciones (placa, tramites, total_tramites, exitosa, error)
      VALUES ($1, $2, $3, $4, $5)
    `, [placa, tramitesStr, total, exitosa, error || null]);
  } catch (err) {
    console.error('Error guardando historial liquidación:', err.message);
  }
}

exports.consultarLiquidacion = async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        ok: false,
        error: 'El cuerpo de la petición debe ser un objeto JSON válido'
      });
    }

    const parsed = parsePayload(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const resultado = await scrapeLiquidacionTramite({
      placa: parsed.data.placa,
      tramites: parsed.data.tramites,
      fechaLiquidacion: parsed.data.fechaLiquidacion
    });

    if (!resultado.ok) {
      return res.status(500).json({
        ok: false,
        error: resultado.error || 'No fue posible consultar la liquidación'
      });
    }

    // Guardar en historial
    guardarHistorialLiquidacion({
      placa: parsed.data.placa,
      tramites: parsed.data.tramites,
      exitosa: resultado.ok,
      error: resultado.ok ? null : (resultado.error || 'Error desconocido')
    });

    return res.json({
      ok: true,
      data: {
        registro: 'RNA',
        tipoDocumentoSolicitante: resultado.data?.tipoDocumentoSolicitante,
        numeroDocumentoSolicitante: resultado.data?.numeroDocumentoSolicitante,
        nombreSolicitante: resultado.data?.nombreSolicitante,
        placa: resultado.data?.placa,
        tramites: resultado.data?.tramites || [],
        tramitesTabla: resultado.data?.tramitesTabla || [],
        descarga: resultado.data?.descarga || null,
        archivoLiquidacion: resultado.data?.descarga?.archivoLiquidacion || null,
        mensaje: resultado.mensaje
      }
    });
  } catch (error) {
    // Guardar en historial aunque haya error interno
    if (req.body) {
      const parsedError = parsePayload(req.body);
      if (parsedError.ok) {
        guardarHistorialLiquidacion({
          placa: parsedError.data.placa,
          tramites: parsedError.data.tramites,
          exitosa: false,
          error: error.message || 'Error interno del servidor'
        });
      }
    }
    return res.status(500).json({
      ok: false,
      error: error.message || 'Error interno del servidor'
    });
  }
};

/**
 * Descarga un PDF de liquidación por nombre de archivo.
 * GET /api/liquidacion/descargar/:fileName
 */
exports.descargarLiquidacion = async (req, res) => {
  try {
    const { fileName } = req.params;

    if (!fileName || !fileName.endsWith('.pdf')) {
      return res.status(400).json({ ok: false, error: 'Nombre de archivo inválido' });
    }

    // Sanitizar: solo permitir nombres de archivo seguros
    const safeName = path.basename(fileName);
    const filePath = path.join(DOWNLOAD_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'Archivo no encontrado' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Error al descargar el archivo'
    });
  }
};

/**
 * Batch — cada item puede tener múltiples trámites (misma placa) o ser legacy (un solo trámite).
 */
exports.consultarLiquidacionBatch = async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debe enviar un arreglo items con al menos un elemento'
      });
    }

    const MAX_ITEMS = 10;
    if (items.length > MAX_ITEMS) {
      return res.status(400).json({
        ok: false,
        error: `El batch excede el límite máximo de ${MAX_ITEMS} items por solicitud`
      });
    }

    const resultados = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const parsed = parsePayload(item);

      if (!parsed.ok) {
        resultados.push({
          index: i,
          ok: false,
          error: parsed.error,
          entrada: item
        });
        continue;
      }

      try {
        const resultado = await scrapeLiquidacionTramite({
          placa: parsed.data.placa,
          tramites: parsed.data.tramites
        });

        resultados.push({
          index: i,
          ok: resultado.ok,
          data: resultado.ok ? resultado.data : null,
          error: resultado.ok ? null : resultado.error,
          entrada: parsed.data
        });
      } catch (error) {
        resultados.push({
          index: i,
          ok: false,
          error: error.message || 'Error procesando item batch',
          entrada: parsed.data
        });
      }
    }

    // Guardar en historial (cada item del batch)
    for (const r of resultados) {
      guardarHistorialLiquidacion({
        placa: r.entrada?.placa || r.data?.placa || 'DESCONOCIDA',
        tramites: r.entrada?.tramites || [],
        exitosa: r.ok,
        error: r.ok ? null : (r.error || 'Error desconocido')
      });
    }

    return res.json({
      ok: true,
      total: resultados.length,
      exitosos: resultados.filter(r => r.ok).length,
      fallidos: resultados.filter(r => !r.ok).length,
      data: resultados
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Error interno del servidor'
    });
  }
};
