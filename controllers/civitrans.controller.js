const {
  scrapeComparendos
} = require('../scraping/civitransScraper');

exports.consultarComparendo = async (req, res) => {
  try {
    const { numero } = req.body;

    if (!numero) {
      return res.status(400).json({
        ok: false,
        error: 'Número de comparendo requerido'
      });
    }

    const data = await scrapeComparendos(numero);

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
