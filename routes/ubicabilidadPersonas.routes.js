const express = require('express');
const multer = require('multer');
const router = express.Router();

const {
  validarArchivo,
  guardarDocumentos,
  obtenerDocumentosParaProcesar,
  listarResultados,
  listarPendientes,
  listarHistorial,
  limpiarDocumentos,
  listarPendientesApi,
  listarOrigenesApi,
  listarErroresEnvio,
  limpiarDocumentosApi
} = require('../controllers/ubicabilidadPersonas.controller');

const { enviarAnioExterno } = require('../controllers/enriquecimientoExterno.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Validar archivo Excel/CSV
router.post('/validar-archivo', upload.single('archivo'), validarArchivo);

// Guardar documentos validados en BD
router.post('/guardar-documentos', guardarDocumentos);

// Eliminar documentos pendientes cargados desde Excel
router.delete('/limpiar-documentos', limpiarDocumentos);

// Obtener estado de documentos en BD antes de procesar
router.post('/obtener-documentos', obtenerDocumentosParaProcesar);

// Listar resultados con paginación
router.get('/resultados', listarResultados);

// Listar personas pendientes de consulta (origen Excel)
router.get('/pendientes', listarPendientes);

// Listar historial de consultados con dirección completa
router.get('/historial', listarHistorial);

// ── Integraciones API (NO se mezclan con fotodetección/Excel) ──

// Resumen de pendientes agrupados por origen de servicio
router.get('/origenes-api', listarOrigenesApi);

// Pendientes provenientes exclusivamente de servicios API (origen LIKE 'API_%')
router.get('/pendientes-api', listarPendientesApi);

// Eliminar pendientes provenientes de servicios API
router.delete('/limpiar-api', limpiarDocumentosApi);

// Enviar los resultados del scraping de un año a CONTRAVENCIONES
router.post('/enviar-externo', enviarAnioExterno);

// Detalle de las respuestas que CONTRAVENCIONES rechazó (para reintentar)
router.get('/errores-envio', listarErroresEnvio);

module.exports = router;
