/**
 * Cliente de la API de ENRIQUECIMIENTO DE PERSONAS de CONTRAVENCIONES.
 *
 * Servicio distinto al de fotomultas (API_HIKVISION:5051). Este vive en
 * CONTRAVENCIONES_ENRIQUECER_URL y exige el header `X-API-Key`.
 *
 * Autenticación: todas las peticiones requieren `X-API-Key`.
 * Batch: POST .../batch con un ARRAY de personas en el body (máx. 5000).
 * La respuesta trae `resultados[]` con { tipoDocumento, numeroDocumento, estado, personaId }.
 */

const axios = require('axios');
const { codigoTipoDocumento } = require('./tipoDocumento');
const config = require('../config');

const BASE_URL = String(config.CONTRAVENCIONES_ENRIQUECER_URL || '')
  .trim()
  .replace(/\/+$/, '');
const API_KEY = String(config.CONTRAVENCIONES_ENRIQUECER_API_KEY || '').trim();

// Códigos que CONTRAVENCIONES declara soportar.
const SOPORTADOS = new Set(['CC', 'CE', 'RC', 'TI', 'NIT', 'PA', 'SC']);

// Nuestro código canónico -> código de ellos. null = todavía no lo soportan.
const MAPEO_CODIGOS = {
  PAS: 'PA', // nosotros PAS, ellos PA
  PPT: null // Permiso por Protección Temporal: no está en su lista -> no se envía
};

// Palabras que nuestro homologador no reconoce pero ellos sí aceptan.
const ALIAS_EXTRA = {
  SALVOCONDUCTO: 'SC'
};

function normalizarTexto(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ellos recomiendan lotes de 1000 (máximo absoluto 5000).
const TAMANO_LOTE = 1000;
const TIMEOUT_MS = 120000;

/**
 * Traduce nuestro tipo de documento al código que CONTRAVENCIONES acepta.
 * Devuelve null si el tipo no se puede enviar (no reconocido o no soportado).
 */
function codigoParaEnviar(tipoDocumento) {
  const normalizado = normalizarTexto(tipoDocumento);
  // Si no lo reconoce nuestro homologador, aun así aceptamos el código tal cual
  // cuando CONTRAVENCIONES sí lo soporta (ej. 'SC' / Salvoconducto).
  const canonico =
    codigoTipoDocumento(tipoDocumento) ||
    ALIAS_EXTRA[normalizado] ||
    (SOPORTADOS.has(normalizado) ? normalizado : null);
  if (!canonico) return null;
  const codigo = Object.prototype.hasOwnProperty.call(MAPEO_CODIGOS, canonico)
    ? MAPEO_CODIGOS[canonico]
    : canonico;
  return codigo && SOPORTADOS.has(codigo) ? codigo : null;
}

function soloDigitos(valor) {
  const limpio = String(valor ?? '').replace(/\D/g, '');
  return limpio || null;
}

/** Arma el payload exacto que espera la spec (sin campos extra). */
function armarPayload(persona) {
  return {
    tipoDocumento: persona.tipoDocumento,
    numeroDocumento: persona.numeroDocumento,
    nombres: persona.nombres || null,
    apellidos: persona.apellidos || null,
    direccion: persona.direccion || null,
    municipioDepartamento: persona.municipioDepartamento || null,
    telefono: soloDigitos(persona.telefono),
    correo: persona.correo || null
  };
}

function resumenVacio() {
  return {
    enviadas: 0,
    procesadas: 0,
    exitosas: 0,
    fallidas: 0,
    yaExistian: 0,
    totalRecibidas: 0,
    resultados: []
  };
}

function esFallo(estado) {
  const e = String(estado || '').toUpperCase();
  return e === 'ERROR' || e === 'FALLIDA' || e === 'FALLIDO' || e === 'RECHAZADA';
}

function esExistente(estado) {
  const e = String(estado || '').toUpperCase();
  return e === 'YA_EXISTIA' || e === 'YA_EXISTE' || e === 'EXISTS' || e === 'EXISTENTE';
}

function acumular(resumen, data, enviadas) {
  resumen.enviadas += enviadas;
  resumen.procesadas += Number(data?.procesadas) || 0;
  resumen.exitosas += Number(data?.exitosas) || 0;
  resumen.fallidas += Number(data?.fallidas) || 0;
  resumen.yaExistian += Number(data?.yaExistian) || 0;
  resumen.totalRecibidas += Number(data?.totalRecibidas) || 0;

  if (Array.isArray(data?.resultados)) {
    resumen.resultados.push(...data.resultados);
  }

  // Si no trajeron contadores, los derivamos del listado de resultados.
  if (!Number(data?.exitosas) && !Number(data?.fallidas) && !Number(data?.yaExistian)) {
    for (const r of data.resultados || []) {
      if (esFallo(r?.estado)) resumen.fallidas += 1;
      else if (esExistente(r?.estado)) resumen.yaExistian += 1;
      else resumen.exitosas += 1;
    }
  }
}

function errorDeRespuesta(err) {
  const data = err?.response?.data;
  if (data?.message) return new Error(`Contravenciones rechazó el envío: ${data.message}`);
  if (err?.code === 'ECONNABORTED') return new Error('Contravenciones no respondió a tiempo (timeout).');
  if (err?.response) return new Error(`Contravenciones respondió ${err.response.status}.`);
  return new Error(`No se pudo contactar a Contravenciones: ${err?.message || 'error desconocido'}`);
}

function verificarConfiguracion() {
  if (!BASE_URL) throw new Error('Falta configurar CONTRAVENCIONES_ENRIQUECER_URL en .env');
  if (!API_KEY) throw new Error('Falta configurar CONTRAVENCIONES_ENRIQUECER_API_KEY en .env');
}

async function post(url, body) {
  try {
    const { data } = await axios.post(url, body, {
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS
    });
    if (data?.success === false) {
      throw new Error(data?.message || 'Contravenciones rechazó el envío.');
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Contravenciones rechazó')) throw err;
    throw errorDeRespuesta(err);
  }
}

/**
 * Envía personas en lote (de a 1000) a `.../enriquecer/batch`.
 * @param {Array} payloads ya armarizados con armarPayload()
 */
async function enviarBatch(payloads) {
  verificarConfiguracion();
  const resumen = resumenVacio();
  if (!Array.isArray(payloads) || payloads.length === 0) return resumen;

  for (let i = 0; i < payloads.length; i += TAMANO_LOTE) {
    const lote = payloads.slice(i, i + TAMANO_LOTE);
    const data = await post(`${BASE_URL}/batch`, lote);
    acumular(resumen, data, lote.length);
  }
  return resumen;
}

/** Envío individual a `.../enriquecer` (por si se necesita). */
async function enviarIndividual(payload) {
  verificarConfiguracion();
  const data = await post(BASE_URL, payload);
  return data;
}

module.exports = {
  BASE_URL,
  TAMANO_LOTE,
  SOPORTADOS,
  codigoParaEnviar,
  armarPayload,
  soloDigitos,
  enviarBatch,
  enviarIndividual
};
