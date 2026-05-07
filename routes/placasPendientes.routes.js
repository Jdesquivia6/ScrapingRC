const express = require('express');
const router = express.Router();

const {
  listarPlacasPendientes
} = require('../controllers/placasPendientes.controller');

router.get('/', listarPlacasPendientes);

module.exports = router;