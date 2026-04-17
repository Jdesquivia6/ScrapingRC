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

    const data = await scrapeDireccionesPN({ tipoDocumento, numeroDocumento });

    return res.json({ ok: true, data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
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
      processed: docsLimited.length,
      results
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
``
