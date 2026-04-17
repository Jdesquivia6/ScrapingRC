const express = require('express');
const router = express.Router();
const { cargarPlacas } = require('../controllers/placas.controller');
const auth = require('../middlewares/auth');

router.post('/cargar', auth, cargarPlacas);

module.exports = router;