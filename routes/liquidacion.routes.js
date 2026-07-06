const express = require('express');
const router = express.Router();

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

// Imprimir PDFs
router.post('/imprimir-pdfs', imprimirPdfs);

module.exports = router;