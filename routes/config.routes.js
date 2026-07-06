const express = require('express');
const router = express.Router();

const {
  obtenerConfigImpresora,
  guardarConfigImpresora
} = require('../controllers/configController');

router.get('/impresora', async (req, res) => {
  try {
    const config = await obtenerConfigImpresora();
    res.json({
      ok: true,
      data: {
        printer_name: config.printer_name || '',
        auto_print: config.auto_print || false,
        updated_at: config.updated_at
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/impresora', async (req, res) => {
  try {
    const { printer_name, auto_print } = req.body;
    await guardarConfigImpresora({ printer_name, auto_print });
    res.json({ ok: true, mensaje: 'Configuración de impresora guardada' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
