const express = require('express');
const router = express.Router();

const {
  consultarComparendo
} = require('../controllers/civitrans.controller');

router.post('/consultar-comparendo', consultarComparendo);

module.exports = router;
