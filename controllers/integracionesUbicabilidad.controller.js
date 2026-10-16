const pool = require('../utils/db');
const {
  homologarTipoDocumento,
  clavesTipoDocumento,
  normalizarClave
} = require('../utils/tipoDocumento');

const MODULOS_EN_CURSO = ['ubicabilidad-personas', 'personas-direcciones'];

const PATRON_SIN_DATOS = /no se (encontr[oó]|encuentra|encuentran)|sin (informaci[oó]n|datos|resultados)|no existe|no registra|no aplica/i;

/* ───────────────────────── utilidades ───────────────────────── */

function maximoPorRequest() {
  const valor = Number(process.env.INTEGRACION_MAX_PERSONAS);
  return Number.isFinite(valor) && valor > 0 ? valor : 5000;
}

function logIntegracion({ cliente, endpoint, recibidos, insertados, existentes, invalidos, duplicados, inicio }) {
  const tiempo = Date.now() - inicio;
  console.log(
    `[integracion] cliente=${cliente} endpoint=${endpoint} recibidos=${recibidos}` +
    ` insertados=${insertados || 0} existentes=${existentes || 0}` +
    ` invalidos=${invalidos || 0} duplicados=${duplicados || 0} tiempo=${tiempo}ms`
  );
}

function estadoPublico(row, enProceso) {
  if (!row.direccion_consultada) return enProceso ? 'EN_PROCESO' : 'PENDIENTE';
  if (row.direccion_encontrada) return 'ENCONTRADA';
  const error = row.error_consulta_direccion ? String(row.error_consulta_direccion).trim() : '';
  if (error && !PATRON_SIN_DATOS.test(error)) return 'ERROR';
  return 'SIN_INFORMACION';
}

function armarPersonaDetalle(row) {
  if (!row) return null;
  return {
    nombres: row.nombres || null,
    apellidos: row.apellidos || null,
    celular: row.celular || null,
    correo: row.correo || null
  };
}

function armarDireccionDetalle(row) {
  if (!row || !row.direccion) return null;
  return {
    direccion: row.direccion || null,
    municipio: row.municio_departamento || null,
    telefono: row.telefono || null,
    tipo_direccion: row.tipo_direccion || null
  };
}

const SELECT_PERSONA = `
  SELECT
    p.id_per_natural_dir,
    p.tipo_documento,
    p.numero_documento,
    p.nombres,
    p.apellidos,
    p.celular,
    p.correo,
    p.direccion_consultada,
    p.direccion_encontrada,
    p.error_consulta_direccion,
    p.fecha_consulta_direccion,
    p.origen_registro,
    d.direccion,
    d.municio_departamento,
    d.telefono,
    d.tipo_direccion
  FROM persona_natural_propietario p
  LEFT JOIN direcciones d ON d.id_direcciones = p.fk_direcciones
`;

/**
 * Marca como EN_PROCESO los documentos que tienen un worker_job_item
 * activo en este momento. Una sola consulta por lote.
 */
async function documentosEnProceso(numeros) {
  if (!numeros || numeros.length === 0) return new Set();
  try {
    const r = await pool.query(`
      SELECT DISTINCT wji.documento
      FROM worker_job_items wji
      JOIN worker_jobs wj ON wj.id_job = wji.fk_job
      WHERE wj.modulo = ANY($1::text[])
        AND wj.estado = 'procesando'
        AND wji.estado = 'procesando'
        AND wji.documento = ANY($2::text[])
    `, [MODULOS_EN_CURSO, numeros]);
    return new Set(r.rows.map(x => x.documento));
  } catch (_) {
    return new Set();
  }
}

/**
 * Indexa las personas existentes por numero_documento + tipo normalizado,
 * tolerando las grafías históricas heterogéneas de tipo_documento.
 */
function indexarExistentes(rows) {
  const indice = new Map();
  for (const row of rows) {
    const numero = String(row.numero_documento || '').trim();
    if (!numero) continue;
    const claves = new Set(clavesTipoDocumento(row.tipo_documento));
    if (!indice.has(numero)) indice.set(numero, []);
    indice.get(numero).push({ row, claves });
  }
  return indice;
}

function buscarExistente(indice, tipo, numero) {
  const candidatos = indice.get(numero);
  if (!candidatos || candidatos.length === 0) return null;

  const claves = clavesTipoDocumento(tipo);

  // Coincidencia por claves normalizadas (tolera grafías históricas)
  for (const clave of claves) {
    for (const candidato of candidatos) {
      if (candidato.claves.has(clave)) return candidato.row;
    }
  }

  // Si el tipo no se reconoce, caer al único candidato con ese número
  if (claves.length === 0 && candidatos.length === 1) return candidatos[0].row;

  return null;
}

/* ───────────────────────── endpoints ───────────────────────── */

/**
 * POST /api/v1/integraciones/ubicabilidad/personas
 * Único propósito: autenticar, validar, insertar/detectar y responder.
 * NO crea worker_jobs, NO toca RUNT, NO usa sesión biométrica.
 */
exports.registrarPersonas = async (req, res) => {
  const inicio = Date.now();
  const cliente = req.apiClient;
  const origen = `API_${cliente.codigo}`;

  let recibidos = 0;
  let insertados = 0;
  let existentes = 0;
  let invalidos = 0;
  let duplicados = 0;

  try {
    const body = req.body || {};
    const lista = body.personas;

    if (!Array.isArray(lista) || lista.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe enviar "personas" como arreglo no vacío' });
    }

    recibidos = lista.length;
    const maximo = maximoPorRequest();
    if (recibidos > maximo) {
      return res.status(413).json({
        ok: false,
        error: `Máximo ${maximo} personas por solicitud (recibidas: ${recibidos})`
      });
    }

    // 1) Validar, homologar y deduplicar dentro de la misma solicitud
    const response = [];
    const validos = [];
    const vistos = new Set();

    lista.forEach((persona, indice) => {
      const ref = persona && persona.referencia_externa != null
        ? String(persona.referencia_externa)
        : null;
      const tipoOriginal = String((persona && persona.tipo_documento) || '').trim();
      const numero = String((persona && persona.numero_documento) || '').trim();
      const metadata = persona && persona.metadata && typeof persona.metadata === 'object' && !Array.isArray(persona.metadata)
        ? persona.metadata
        : null;

      const base = { referencia_externa: ref, tipo_documento: tipoOriginal, numero_documento: numero };
      if (metadata !== null) base.metadata = metadata;

      if (!tipoOriginal || !numero) {
        invalidos++;
        response.push({
          ...base,
          estado_recepcion: 'INVALIDO',
          estado_consulta: null,
          resultado_disponible: false,
          error: 'tipo_documento y numero_documento son obligatorios'
        });
        return;
      }

      if (numero.length > 30 || tipoOriginal.length > 60) {
        invalidos++;
        response.push({
          ...base,
          estado_recepcion: 'INVALIDO',
          estado_consulta: null,
          resultado_disponible: false,
          error: 'Longitud máxima excedida'
        });
        return;
      }

      const tipo = homologarTipoDocumento(tipoOriginal);
      if (!tipo) {
        invalidos++;
        response.push({
          ...base,
          estado_recepcion: 'INVALIDO',
          estado_consulta: null,
          resultado_disponible: false,
          error: 'tipo_documento no reconocido'
        });
        return;
      }

      const clave = `${normalizarClave(tipo)}|${numero}`;
      if (vistos.has(clave)) {
        duplicados++;
        response.push({
          ...base,
          estado_recepcion: 'DUPLICADO',
          estado_consulta: null,
          resultado_disponible: false,
          error: 'Duplicado dentro de la misma solicitud'
        });
        return;
      }

      vistos.add(clave);
      const registro = { indice: response.length, ref, tipo, tipoOriginal, numero, metadata };
      validos.push(registro);
      // placeholder: se completa después de consultar la BD
      response.push({
        ...base,
        tipo_documento: tipoOriginal,
        estado_recepcion: null,
        estado_consulta: null,
        resultado_disponible: false
      });
    });

    // 2) Detectar existentes (tolerante a grafías históricas de tipo_documento)
    const numeros = Array.from(new Set(validos.map(v => v.numero)));
    const existentesRows = numeros.length
      ? (await pool.query(`${SELECT_PERSONA} WHERE p.numero_documento = ANY($1::text[])`, [numeros])).rows
      : [];
    const indice = indexarExistentes(existentesRows);

    const enProceso = await documentosEnProceso(numeros);

    // 3) Insertar en lote los que no existen (respetando el UNIQUE)
    const nuevos = validos.filter(v => !buscarExistente(indice, v.tipo, v.numero));
    let insertadosSet = new Set();

    if (nuevos.length > 0) {
      const tipos = nuevos.map(n => n.tipo);
      const nums = nuevos.map(n => n.numero);
      try {
        const r = await pool.query(`
          INSERT INTO persona_natural_propietario (
            tipo_documento, numero_documento,
            direccion_consultada, direccion_encontrada,
            origen_registro, fecha_actualizacion
          )
          SELECT u.tipo, u.numero, FALSE, FALSE, $3, NOW()
          FROM unnest($1::text[], $2::text[]) AS u(tipo, numero)
          ON CONFLICT (tipo_documento, numero_documento) DO NOTHING
          RETURNING numero_documento
        `, [tipos, nums, origen]);
        insertadosSet = new Set(r.rows.map(x => x.numero_documento));
      } catch (err) {
        console.error('[integracion] error insertando lote:', err.message);
      }
    }

    // 4) Completar la respuesta persona por persona
    for (const valido of validos) {
      const item = response[valido.indice];
      const existente = buscarExistente(indice, valido.tipo, valido.numero);

      if (!existente && insertadosSet.has(valido.numero)) {
        insertados++;
        item.estado_recepcion = 'INSERTADO';
        item.estado_consulta = 'PENDIENTE';
        item.resultado_disponible = false;
        continue;
      }

      if (existente) {
        existentes++;
        item.estado_recepcion = 'YA_EXISTIA';
        item.estado_consulta = estadoPublico(existente, enProceso.has(valido.numero));
        item.resultado_disponible = item.estado_consulta === 'ENCONTRADA';
        if (item.resultado_disponible) {
          item.persona = armarPersonaDetalle(existente);
          item.direccion = armarDireccionDetalle(existente);
          if (existente.fecha_consulta_direccion) {
            item.fecha_consulta = existente.fecha_consulta_direccion;
          }
        } else if (item.estado_consulta === 'ERROR') {
          item.error = existente.error_consulta_direccion;
        }
        continue;
      }

      // Carrera concurrente: el ON CONFLICT no devolvió la fila
      existentes++;
      item.estado_recepcion = 'YA_EXISTIA';
      item.estado_consulta = enProceso.has(valido.numero) ? 'EN_PROCESO' : 'PENDIENTE';
      item.resultado_disponible = false;
    }

    logIntegracion({
      cliente: cliente.codigo,
      endpoint: '/ubicabilidad/personas',
      recibidos, insertados, existentes, invalidos, duplicados, inicio
    });

    return res.json({
      ok: true,
      cliente: cliente.codigo,
      total_recibidos: recibidos,
      insertados,
      existentes,
      invalidos,
      duplicados,
      personas: response
    });
  } catch (error) {
    logIntegracion({
      cliente: cliente.codigo,
      endpoint: '/ubicabilidad/personas',
      recibidos, insertados, existentes, invalidos, duplicados, inicio
    });
    console.error('[integracion] error:', error.message);
    return res.status(500).json({ ok: false, error: 'Error procesando la solicitud' });
  }
};

/**
 * POST /api/v1/integraciones/ubicabilidad/resultados
 * Solo consulta. No inserta ni dispara trabajos.
 */
exports.consultarResultados = async (req, res) => {
  const inicio = Date.now();
  const cliente = req.apiClient;

  try {
    const lista = (req.body && req.body.personas) || [];
    if (!Array.isArray(lista) || lista.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe enviar "personas" como arreglo no vacío' });
    }

    const maximo = maximoPorRequest();
    if (lista.length > maximo) {
      return res.status(413).json({ ok: false, error: `Máximo ${maximo} personas por solicitud` });
    }

    const consultas = lista.map(p => ({
      ref: p && p.referencia_externa != null ? String(p.referencia_externa) : null,
      tipo: homologarTipoDocumento(String((p && p.tipo_documento) || '').trim()),
      tipoOriginal: String((p && p.tipo_documento) || '').trim(),
      numero: String((p && p.numero_documento) || '').trim(),
      metadata: p && p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata) ? p.metadata : null
    }));

    const numeros = Array.from(new Set(consultas.map(c => c.numero).filter(Boolean)));
    const rows = numeros.length
      ? (await pool.query(`${SELECT_PERSONA} WHERE p.numero_documento = ANY($1::text[])`, [numeros])).rows
      : [];
    const indice = indexarExistentes(rows);
    const enProceso = await documentosEnProceso(numeros);

    const resumen = { pendientes: 0, encontrados: 0, sin_informacion: 0, errores: 0, no_registradas: 0 };
    const personas = [];

    for (const c of consultas) {
      const base = { referencia_externa: c.ref, tipo_documento: c.tipoOriginal, numero_documento: c.numero };
      if (c.metadata !== null) base.metadata = c.metadata;

      if (!c.numero) {
        personas.push({ ...base, estado: 'NO_REGISTRADA', resultado_disponible: false });
        resumen.no_registradas++;
        continue;
      }

      const existente = buscarExistente(indice, c.tipo, c.numero);

      if (!existente) {
        personas.push({ ...base, estado: 'NO_REGISTRADA', resultado_disponible: false });
        resumen.no_registradas++;
        continue;
      }

      const estado = estadoPublico(existente, enProceso.has(c.numero));
      const item = { ...base, estado };

      if (estado === 'ENCONTRADA') {
        item.resultado_disponible = true;
        item.persona = armarPersonaDetalle(existente);
        item.direccion = armarDireccionDetalle(existente);
        if (existente.fecha_consulta_direccion) item.fecha_consulta = existente.fecha_consulta_direccion;
        resumen.encontrados++;
      } else {
        item.resultado_disponible = false;
        if (estado === 'PENDIENTE') resumen.pendientes++;
        else if (estado === 'SIN_INFORMACION') resumen.sin_informacion++;
        else if (estado === 'ERROR') {
          resumen.errores++;
          item.error = existente.error_consulta_direccion;
        }
      }

      personas.push(item);
    }

    logIntegracion({
      cliente: cliente.codigo,
      endpoint: '/ubicabilidad/resultados',
      recibidos: lista.length, insertados: 0, existentes: personas.length,
      invalidos: 0, duplicados: 0, inicio
    });

    return res.json({
      ok: true,
      cliente: cliente.codigo,
      total_solicitados: lista.length,
      resumen,
      personas
    });
  } catch (error) {
    console.error('[integracion] error consultando resultados:', error.message);
    return res.status(500).json({ ok: false, error: 'Error consultando la solicitud' });
  }
};

/**
 * GET /api/v1/integraciones/ubicabilidad/personas/:tipo/:documento
 */
exports.consultarPersona = async (req, res) => {
  try {
    const tipoOriginal = String(req.params.tipo || '').trim();
    const numero = String(req.params.documento || '').trim();

    if (!tipoOriginal || !numero) {
      return res.status(400).json({ ok: false, error: 'tipo y documento son obligatorios' });
    }

    const tipo = homologarTipoDocumento(tipoOriginal);
    const rows = (await pool.query(
      `${SELECT_PERSONA} WHERE p.numero_documento = $1`,
      [numero]
    )).rows;

    const indice = indexarExistentes(rows);
    const existente = buscarExistente(indice, tipo, numero);

    if (!existente) {
      return res.status(404).json({
        ok: false,
        tipo_documento: tipoOriginal,
        numero_documento: numero,
        estado: 'NO_REGISTRADA'
      });
    }

    const enProceso = await documentosEnProceso([numero]);
    const estado = estadoPublico(existente, enProceso.has(numero));

    const respuesta = {
      ok: true,
      tipo_documento: existente.tipo_documento,
      numero_documento: existente.numero_documento,
      estado
    };

    if (estado === 'ENCONTRADA') {
      respuesta.persona = armarPersonaDetalle(existente);
      respuesta.direccion = armarDireccionDetalle(existente);
      if (existente.fecha_consulta_direccion) respuesta.fecha_consulta = existente.fecha_consulta_direccion;
    } else if (estado === 'ERROR') {
      respuesta.error = existente.error_consulta_direccion;
    }

    return res.json(respuesta);
  } catch (error) {
    console.error('[integracion] error consultando persona:', error.message);
    return res.status(500).json({ ok: false, error: 'Error consultando la persona' });
  }
};
