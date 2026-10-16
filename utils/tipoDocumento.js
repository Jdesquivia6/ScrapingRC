/**
 * Homologación centralizada de tipos de documento.
 *
 * Objetivo:
 *  - Un único punto de transformación para valores que llegan por API/Excel.
 *  - NO romper el histórico: la tabla persona_natural_propietario guarda
 *    valores heterogéneos ('Cédula Ciudadanía', 'CEDULA DE CIUDADANIA', 'CC'...)
 *    y el índice UNIQUE es (tipo_documento, numero_documento).
 *
 * Por eso exponemos dos funciones:
 *  - homologarTipoDocumento(valor) -> canónico para INSERTAR
 *  - clavesTipoDocumento(valor)    -> variantes normalizadas para DETECTAR
 *    si la persona ya existe con otra grafía histórica
 */

const CANONICO = {
  CC: 'Cédula Ciudadanía',
  CE: 'Cédula de Extranjería',
  NIT: 'NIT',
  PAS: 'Pasaporte',
  PPT: 'Permiso por Protección Temporal',
  RC: 'Registro Civil',
  TI: 'Tarjeta de Identidad'
};

const ALIAS = {
  CC: [
    'CC', 'C.C', 'C.C.', 'CEDULA', 'CEDULA DE CIUDADANIA',
    'CEDULA CIUDADANIA', 'CEDULA CIUDADADANIA'
  ],
  CE: [
    'CE', 'C.E', 'C.E.', 'CEDULA DE EXTRANJERIA', 'CEDULA EXTRANJERIA'
  ],
  NIT: ['NIT', 'N.I.T', 'N.I.T.'],
  PAS: ['PA', 'PAS', 'PASAPORTE'],
  PPT: ['PPT', 'P.P.T', 'P.P.T.', 'PERMISO POR PROTECCION TEMPORAL'],
  RC: ['RC', 'REGISTRO CIVIL'],
  TI: ['TI', 'TARJETA DE IDENTIDAD', 'TARJETA IDENTIDAD']
};

/** Quita tildes, puntos, guiones y espacios extra para comparar sin acentos. */
function normalizarClave(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Devuelve el código corto (CC, CE, NIT...) si el valor es reconocible. */
function codigoTipoDocumento(valor) {
  const clave = normalizarClave(valor);
  if (!clave) return null;

  for (const [codigo, alias] of Object.entries(ALIAS)) {
    if (alias.some(a => normalizarClave(a) === clave)) return codigo;
  }

  // Coincidencia parcial defensiva (ej. "CEDULA DE CIUDADANIA COLOMBIANA")
  if (clave.includes('CEDULA') && clave.includes('EXTRANJER')) return 'CE';
  if (clave.includes('CEDULA')) return 'CC';
  if (clave.includes('PASAPORTE')) return 'PAS';
  if (clave.includes('PROTECCION TEMPORAL') || clave.includes('PPT')) return 'PPT';
  if (clave.includes('REGISTRO CIVIL')) return 'RC';
  if (clave.includes('TARJETA')) return 'TI';
  if (clave.includes('NIT')) return 'NIT';

  return null;
}

/**
 * Valor canónico a GUARDAR en persona_natural_propietario.
 * Si no se reconoce, devuelve el valor recortado tal cual (no se pierde dato).
 */
function homologarTipoDocumento(valor) {
  const original = String(valor || '').trim();
  if (!original) return '';
  const codigo = codigoTipoDocumento(original);
  return codigo ? CANONICO[codigo] : original;
}

/**
 * Variantes normalizadas de un tipo de documento, para buscar personas
 * existentes escritas con otra grafía histórica.
 * Ej: 'CC' -> ['CÉDULA CIUDADANIA', 'C.C', 'CC', ...] ya sin tildes/puntos.
 */
function clavesTipoDocumento(valor) {
  const codigo = codigoTipoDocumento(valor);
  if (!codigo) {
    const propia = normalizarClave(valor);
    return propia ? [propia] : [];
  }
  const set = new Set([normalizarClave(CANONICO[codigo]), normalizarClave(codigo)]);
  for (const a of ALIAS[codigo]) set.add(normalizarClave(a));
  return Array.from(set);
}

module.exports = {
  CANONICO,
  normalizarClave,
  codigoTipoDocumento,
  homologarTipoDocumento,
  clavesTipoDocumento
};
