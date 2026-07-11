const path = require('path');
const fs = require('fs');
const pool = require('../utils/db');
const { scrapeLiquidacionTramite } = require('../scraping/liquidacionScraper');
const { obtenerEstadoSesionRunt } = require('../utils/runtSession');
const { obtenerConfigImpresora } = require('./configController');
const pdf_to_printer = require('pdf-to-printer');

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

    const MAX_ITEMS = 50;
    if (items.length > MAX_ITEMS) {
      return res.status(400).json({
        ok: false,
        error: `El batch excede el límite máximo de ${MAX_ITEMS} items por solicitud`
      });
    }

    // Verificar sesión RUNT antes de empezar
    const session = await obtenerEstadoSesionRunt();
    if (!session.puedeConsultar) {
      return res.status(409).json({
        ok: false,
        error: session.activa
          ? `Sesión RUNT por expirar. Solo quedan ${session.minutosRestantes} minutos.`
          : 'La sesión RUNT está vencida. Debe iniciar sesión nuevamente.',
        session
      });
    }

    // Calcular tiempo estimado (~40s por placa con tramites incluidos)
    const minutosEstimados = Math.ceil((items.length * 40) / 60);
    if (minutosEstimados > session.minutosRestantes) {
      return res.status(409).json({
        ok: false,
        error: `El batch de ${items.length} placas requiere ~${minutosEstimados} min, pero solo quedan ${session.minutosRestantes} min de sesión RUNT. Reduzca la cantidad de placas.`,
        session,
        maxRecomendado: Math.floor((session.minutosRestantes * 60) / 40)
      });
    }

    // ── Streaming NDJSON: escribir cada resultado ni bien termina ──
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let exitosos = 0;
    let fallidos = 0;

    // Enviar evento de inicio
    res.write(JSON.stringify({
      tipo: 'inicio',
      total: items.length
    }) + '\n');

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const parsed = parsePayload(item);

      if (!parsed.ok) {
        const errorResult = {
          index: i,
          ok: false,
          error: parsed.error,
          entrada: item,
          placa: item.placa || 'DESCONOCIDA',
          tramites: item.tramites || []
        };
        fallidos++;
        guardarHistorialLiquidacion({
          placa: errorResult.placa,
          tramites: errorResult.tramites,
          exitosa: false,
          error: parsed.error
        });
        res.write(JSON.stringify({ tipo: 'resultado', ...errorResult }) + '\n');
        continue;
      }

      try {
        const resultado = await scrapeLiquidacionTramite({
          placa: parsed.data.placa,
          tramites: parsed.data.tramites
        });

        const resultData = {
          index: i,
          ok: resultado.ok,
          data: resultado.ok ? resultado.data : null,
          error: resultado.ok ? null : resultado.error,
          entrada: parsed.data,
          placa: parsed.data.placa,
          tramites: parsed.data.tramites
        };

        if (resultado.ok) exitosos++;
        else fallidos++;

        guardarHistorialLiquidacion({
          placa: parsed.data.placa,
          tramites: parsed.data.tramites,
          exitosa: resultado.ok,
          error: resultado.ok ? null : (resultado.error || 'Error desconocido')
        });

        res.write(JSON.stringify({ tipo: 'resultado', ...resultData }) + '\n');
      } catch (error) {
        fallidos++;
        guardarHistorialLiquidacion({
          placa: parsed.data.placa,
          tramites: parsed.data.tramites,
          exitosa: false,
          error: error.message || 'Error procesando item batch'
        });
        res.write(JSON.stringify({
          tipo: 'resultado',
          index: i,
          ok: false,
          error: error.message || 'Error procesando item batch',
          entrada: parsed.data,
          placa: parsed.data.placa,
          tramites: parsed.data.tramites
        }) + '\n');
      }
    }

    // Enviar evento de finalización
    res.write(JSON.stringify({
      tipo: 'completo',
      total: items.length,
      exitosos,
      fallidos
    }) + '\n');
    res.end();
  } catch (error) {
    // Si ocurre un error antes de empezar el streaming
    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: error.message || 'Error interno del servidor'
      });
    }
    // Si ya empezó el streaming, escribir el error como NDJSON
    res.write(JSON.stringify({
      tipo: 'error',
      error: error.message || 'Error interno del servidor'
    }) + '\n');
    res.end();
  }
};

/**
 * Imprime una lista de PDFs de liquidacion de forma sincrónica.
 * POST /api/liquidacion/imprimir-pdfs
 * Body: { fileNames: string[] }
 */
exports.imprimirPdfs = async (req, res) => {
  try {
    // Soportar POST (JSON body) y GET (query param) para compatibilidad con navegador
    let fileNames = [];
    if (req.method === 'GET') {
      const filesParam = (req.query.files || '').toString();
      if (!filesParam) {
        return res.status(400).send(htmlRespuesta('Error', 'No se recibieron archivos para imprimir'));
      }
      fileNames = filesParam.split(',').map(f => f.trim()).filter(Boolean);
    } else {
      fileNames = req.body.fileNames;
    }

    if (!Array.isArray(fileNames) || fileNames.length === 0) {
      const msg = 'Debe enviar un array fileNames';
      if (req.method === 'GET') {
        return res.status(400).send(htmlRespuesta('Error', msg));
      }
      return res.status(400).json({ ok: false, error: msg });
    }

    const config = await obtenerConfigImpresora();
    const printerOptions = config.printer_name
      ? { printer: config.printer_name }
      : {};

    let exitosas = 0;
    let fallidas = 0;
    const errores = [];

    for (const fileName of fileNames) {
      const safeName = path.basename(fileName);
      const filePath = path.join(DOWNLOAD_DIR, safeName);

      if (!fs.existsSync(filePath)) {
        fallidas++;
        errores.push(`No encontrado: ${safeName}`);
        continue;
      }

      try {
        await pdf_to_printer.print(filePath, printerOptions);
        exitosas++;
        console.log(`[print] Impreso: ${safeName} ${config.printer_name ? `(impresora: ${config.printer_name})` : '(predeterminada)'}`);

        // Eliminar PDF después de impresión exitosa
        try {
          fs.unlinkSync(filePath);
          console.log(`[print] Eliminado: ${safeName}`);
        } catch (deleteErr) {
          console.warn(`[print] No se pudo eliminar ${safeName}: ${deleteErr.message}`);
        }
      } catch (printErr) {
        fallidas++;
        errores.push(`${safeName}: ${printErr.message}`);
        console.error(`[print] Error imprimiendo ${safeName}:`, printErr.message);
      }
    }

    if (req.method === 'GET') {
      const titulo = fallidas === 0 ? 'Éxito' : 'Parcial';
      const mensaje = fallidas === 0
        ? `${exitosas} PDF(s) enviado(s) a la impresora`
        : `${exitosas} impreso(s), ${fallidas} fallido(s)`;
      const detalle = errores.length > 0 ? `<br><small>${errores.join('<br>')}</small>` : '';
      return res.send(htmlRespuesta(titulo, mensaje + detalle));
    }

    res.json({
      ok: true,
      data: {
        total: fileNames.length,
        exitosas,
        fallidas,
        errores
      }
    });
  } catch (error) {
    console.error('[print] Error general:', error);
    if (req.method === 'GET') {
      return res.status(500).send(htmlRespuesta('Error', error.message));
    }
    res.status(500).json({ ok: false, error: error.message });
  }
};

function htmlRespuesta(titulo, mensaje) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Impresión - ${titulo}</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
    .ok { color: #2e7d32; }
    .warn { color: #f57c00; }
    .error { color: #c62828; }
    small { color: #666; display: block; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2 class="${titulo === 'Éxito' ? 'ok' : titulo === 'Parcial' ? 'warn' : 'error'}">${titulo}</h2>
    <p>${mensaje}</p>
  </div>
</body>
</html>`;
}
