const express = require('express');
const router = express.Router();

const { autenticarApiKey } = require('../middlewares/apiKeyMiddleware');
const {
  registrarPersonas,
  consultarResultados,
  consultarPersona
} = require('../controllers/integracionesUbicabilidad.controller');

// Límite de cuerpo específico para integraciones (los miles de personas
// viajan en un solo request). Express lo aplica antes del parser global.
router.use(express.json({ limit: '5mb' }));

// 1) Ingesta: los sistemas externos SOLO insertan personas.
router.post(
  '/ubicabilidad/personas',
  autenticarApiKey('puede_insertar'),
  registrarPersonas
);

// 2) Consulta de resultados (polling).
router.post(
  '/ubicabilidad/resultados',
  autenticarApiKey('puede_consultar'),
  consultarResultados
);

// 3) Consulta individual.
router.get(
  '/ubicabilidad/personas/:tipo/:documento',
  autenticarApiKey('puede_consultar'),
  consultarPersona
);

module.exports = router;
