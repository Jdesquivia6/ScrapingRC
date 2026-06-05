const express = require('express');
const router = express.Router();

const {
  listarHistorialUnificado
} = require('../controllers/historial.controller');

// Endpoint unificado de historial
router.get('/', listarHistorialUnificado);

module.exports = router;
