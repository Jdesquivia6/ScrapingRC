const express = require('express');
const router = express.Router();

const {
  consultarLiquidacion,
  consultarLiquidacionBatch,
  descargarLiquidacion,
  imprimirPdfs,
  crearJobImpresion
} = require('../controllers/liquidacion.controller');

// Consulta individual (soporta múltiples trámites)
router.post('/consultar-liquidacion', consultarLiquidacion);

// Consulta masiva
router.post('/consultar-liquidacion-batch', consultarLiquidacionBatch);

// Descargar PDF
router.get('/descargar/:fileName', descargarLiquidacion);

// Crear job de impresión local
router.post('/crear-job-impresion', crearJobImpresion);

// Imprimir PDFs (legacy - ahora usa worker job)
router.post('/imprimir-pdfs', imprimirPdfs);

module.exports = router;