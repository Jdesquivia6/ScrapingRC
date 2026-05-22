const { scrapeLiquidacionTramite } = require('../scraping/liquidacionScraper');

/**
 * Valida que los datos mínimos para RNA estén presentes.
 * Solo RNA, placa + trámite + clasificación.
 */
function validarItemLiquidacion(data) {
  const placa = (data.placa || '').toString().trim().toUpperCase();
  const tramite = (data.tramite || '').toString().trim();
  const clasificacion = (data.clasificacion || '').toString().trim();

  if (!placa) {
    return { ok: false, error: 'La placa es obligatoria' };
  }

  if (!tramite) {
    return { ok: false, error: 'El trámite es obligatorio para RNA' };
  }

  if (!clasificacion) {
    return { ok: false, error: 'La clasificación es obligatoria' };
  }

  // Validar que sean valores permitidos
  const tramitesValidos = [
    'TRÁMITE MATRÍCULA INICIAL',
    'TRÁMITE INSCRIPCIÓN ALERTA'
  ];

  if (!tramitesValidos.includes(tramite.toUpperCase())) {
    return {
      ok: false,
      error: `Trámite no válido para RNA. Valores permitidos: ${tramitesValidos.join(', ')}`
    };
  }

  const clasificacionesValidas = [
    'AUTOMOVIL',
    'MEDIDAS CAUTELARES',
    'MOTO',
    'MOTOCARRO'
  ];

  if (!clasificacionesValidas.includes(clasificacion.toUpperCase())) {
    return {
      ok: false,
      error: `Clasificación no válida. Valores permitidos: ${clasificacionesValidas.join(', ')}`
    };
  }

  return {
    ok: true,
    data: {
      registro: 'RNA',
      placa,
      tramite: tramite.toUpperCase(),
      clasificacion: clasificacion.toUpperCase()
    }
  };
}

exports.consultarLiquidacion = async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        ok: false,
        error: 'El cuerpo de la petición debe ser un objeto JSON válido'
      });
    }

    const validacion = validarItemLiquidacion(req.body);

    if (!validacion.ok) {
      return res.status(400).json({
        ok: false,
        error: validacion.error
      });
    }

    const resultado = await scrapeLiquidacionTramite(validacion.data);

    if (!resultado.ok) {
      return res.status(500).json({
        ok: false,
        error: resultado.error || 'No fue posible consultar la liquidación'
      });
    }

    return res.json({
      ok: true,
      data: {
        registro: resultado.data?.registro,
        tipoDocumentoSolicitante: resultado.data?.tipoDocumentoSolicitante,
        numeroDocumentoSolicitante: resultado.data?.numeroDocumentoSolicitante,
        nombreSolicitante: resultado.data?.nombreSolicitante,
        placa: resultado.data?.placa,
        tramite: resultado.data?.tramite,
        clasificacion: resultado.data?.clasificacion,
        tarifa: resultado.data?.tarifa || null,
        tramitesTabla: resultado.data?.tramitesTabla || [],
        descarga: resultado.data?.descarga || null,
        mensaje: resultado.mensaje
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Error interno del servidor'
    });
  }
};

/**
 * Batch — solo acepta items RNA válidos.
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
      const validacion = validarItemLiquidacion(item);

      if (!validacion.ok) {
        resultados.push({
          index: i,
          ok: false,
          error: validacion.error,
          entrada: item
        });
        continue;
      }

      try {
        const resultado = await scrapeLiquidacionTramite(validacion.data);

        resultados.push({
          index: i,
          ok: resultado.ok,
          data: resultado.ok ? resultado : null,
          error: resultado.ok ? null : resultado.error,
          entrada: validacion.data
        });
      } catch (error) {
        resultados.push({
          index: i,
          ok: false,
          error: error.message || 'Error procesando item batch',
          entrada: validacion.data
        });
      }
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
