const express = require('express');
const router = express.Router();

const {
  obtenerConfigImpresora,
  guardarConfigImpresora,
  listarImpresoras,
  listarImpresorasDisponibles,
  agregarImpresora,
  eliminarImpresora,
  activarImpresora
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

// Listar impresoras registradas en el catálogo + cuál está activa
router.get('/impresoras', async (req, res) => {
  try {
    const [impresoras, config] = await Promise.all([
      listarImpresoras(),
      obtenerConfigImpresora()
    ]);
    res.json({
      ok: true,
      data: {
        activa: config.printer_name || '',
        impresoras
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Detectar impresoras instaladas en Windows
router.get('/impresoras/disponibles', async (req, res) => {
  try {
    const disponibles = await listarImpresorasDisponibles();
    res.json({ ok: true, data: disponibles });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Registrar una nueva impresora en el catálogo
router.post('/impresoras', async (req, res) => {
  try {
    const { nombre } = req.body;
    const impresora = await agregarImpresora(nombre);
    res.json({ ok: true, data: impresora, mensaje: 'Impresora agregada' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// Activar una impresora registrada (actualiza config_impresora.printer_name)
router.post('/impresoras/:id/activar', async (req, res) => {
  try {
    const nombre = await activarImpresora(req.params.id);
    res.json({ ok: true, data: { nombre }, mensaje: `Impresora "${nombre}" activada` });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// Eliminar una impresora del catálogo
router.delete('/impresoras/:id', async (req, res) => {
  try {
    const impresora = await eliminarImpresora(req.params.id);
    res.json({ ok: true, data: impresora, mensaje: 'Impresora eliminada' });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

module.exports = router;
