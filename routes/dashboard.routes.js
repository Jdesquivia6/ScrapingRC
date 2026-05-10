const express = require('express');
const router = express.Router();

const {
  obtenerDashboard,
  exportarDashboardExcel
} = require('../controllers/dashboard.controller');

router.get('/', obtenerDashboard);
router.get('/exportar-excel', exportarDashboardExcel);

module.exports = router;