const express = require('express');
const router = express.Router();

const { procesarPlacasBatch } = require('../controllers/vehiculo.controller');

router.post('/procesar-batch', procesarPlacasBatch);

module.exports = router;