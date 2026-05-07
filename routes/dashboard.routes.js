const express = require('express');
const router = express.Router();

const {
  obtenerDashboard
} = require('../controllers/dashboard.controller');

router.get('/', obtenerDashboard);

module.exports = router;