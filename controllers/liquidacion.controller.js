const { scrapeLiquidacionTramite } = require('../scraping/liquidacionScraper');

function normalizarTexto(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor).trim().toUpperCase();
}

function validarItemLiquidacion(data) {
  const registro = normalizarTexto(data.registro);
  const placa = normalizarTexto(data.placa);
  const tipoDocumento = normalizarTexto(data.tipoDocumento);
  const numeroDocumento = normalizarTexto(data.numeroDocumento);
  const tramite = (data.tramite || '').toString().trim();
  const clasificacion = (data.clasificacion || '').toString().trim();
  const tarifa = (data.tarifa || '').toString().trim();

  if (!registro) {
    return { ok: false, error: 'El registro es obligatorio' };
  }

  const registrosConPlaca = ['RNA', 'RNMA', 'RNRS'];
  const registrosConDocumento = ['RNC', 'RNPNJ'];
  const registrosSinDatoExtra = ['RNET'];

  if (
    !registrosConPlaca.includes(registro) &&
    !registrosConDocumento.includes(registro) &&
    !registrosSinDatoExtra.includes(registro)
  ) {
    return { ok: false, error: `El registro ${registro} no es válido o no está soportado` };
  }

  if (registrosConPlaca.includes(registro) && !placa) {
    return { ok: false, error: `La placa es obligatoria para el registro ${registro}` };
  }

  if (registrosConDocumento.includes(registro) && !tipoDocumento) {
    return { ok: false, error: `El tipoDocumento es obligatorio para el registro ${registro}` };
  }

  if (registrosConDocumento.includes(registro) && !numeroDocumento) {
    return { ok: false, error: `El numeroDocumento es obligatorio para el registro ${registro}` };
  }

  if (!tramite) {
    return { ok: false, error: 'El trámite es obligatorio' };
  }

  return {
    ok: true,
    data: {
      registro,
      placa,
      tipoDocumento,
      numeroDocumento,
      tramite,
      clasificacion,
      tarifa
    }
  };
}

exports.consultarLiquidacion = async (req, res) => {
  try {
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
      data: resultado
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Error interno del servidor'
    });
  }
};

exports.consultarLiquidacionBatch = async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debe enviar un arreglo items con al menos un elemento'
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