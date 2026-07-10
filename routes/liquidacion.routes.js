const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/authMiddleware');

const {
  consultarLiquidacion,
  consultarLiquidacionBatch,
  descargarLiquidacion,
  imprimirPdfs
} = require('../controllers/liquidacion.controller');

// Consulta individual (soporta múltiples trámites)
router.post('/consultar-liquidacion', consultarLiquidacion);

// Consulta masiva
router.post('/consultar-liquidacion-batch', consultarLiquidacionBatch);

// Descargar PDF
router.get('/descargar/:fileName', descargarLiquidacion);

// Imprimir PDFs de liquidación (usado por backend local para impresión directa)
router.post('/imprimir-pdfs', verifyToken, imprimirPdfs);

module.exports = router;