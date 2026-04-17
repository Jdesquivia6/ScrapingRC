const express = require('express');
const router = express.Router();

const {
  consultarLiquidacion,
  consultarLiquidacionBatch
} = require('../controllers/liquidacion.controller');

// Consulta individual
router.post('/consultar-liquidacion', consultarLiquidacion);

// Consulta masiva
router.post('/consultar-liquidacion-batch', consultarLiquidacionBatch);

module.exports = router;