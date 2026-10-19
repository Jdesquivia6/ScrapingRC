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

const ANIO_MIN = 2000;
const ANIO_MAX = new Date().getFullYear() + 1;

/**
 * Normaliza el año de consulta que envía el servicio externo.
 *  - 0    → no viene año (se guarda NULL, solo es un organizador)
 *  - null → el valor viene pero no es válido
 */
function normalizarAnio(valor) {
  if (valor === undefined || valor === null || valor === '') return 0;

  const texto = String(valor).trim();
  // "0" / "0000" significa explícitamente "sin año" (mismo criterio que el
  // filtro ?anio=0 del panel); no es un año inválido.
  if (texto === '0' || texto === '0000') return 0;
  if (!/^\d{4}$/.test(texto)) return null;

  const anio = Number(texto);
  if (anio < ANIO_MIN || anio > ANIO_MAX) return null;

  return anio;
}

/**
 * Extrae el año de una metadata arbitraria. Contravenciones lo envía como
 * `metadata.anio_consulta`; también aceptamos `metadata.anio`.
 */
function anioDeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  if (metadata.anio_consulta != null && metadata.anio_consulta !== '') return metadata.anio_consulta;
  if (metadata.anio != null && metadata.anio !== '') return metadata.anio;
  return undefined;
}

/**
 * Resuelve el año recorriendo las fuentes por orden de prioridad y devolviendo
 * la primera que normalice a un año válido (> 0).
 *
 *   > 0  → año válido
 *   0    → ninguna fuente vino (la persona queda sin año)
 *   null → hubo fuentes pero ninguna fue válida (fila INVALIDO / 400)
 *
 * Tolerante a la forma en que cada integrador envíe el dato: si un campo viene
 * corrupto pero otro trae el año bien, se usa el bueno en vez de rechazar.
 */
function resolverAnio(fuentes) {
  let algunaInvalida = false;

  for (const fuente of fuentes) {
    if (fuente == null || fuente === '' || fuente === 0) continue;
    const anio = normalizarAnio(fuente);
    if (anio === null) {
      algunaInvalida = true;
      continue;
    }
    if (anio > 0) return anio;
  }

  return algunaInvalida ? null : 0;
}

function logIntegracion({ cliente, endpoint, recibidos, insertados, reactivados = 0, existentes, invalidos, duplicados, fallidos = 0, inicio }) {
  const tiempo = Date.now() - inicio;
  console.log(
    `[integracion] cliente=${cliente} endpoint=${endpoint} recibidos=${recibidos}` +
    ` insertados=${insertados || 0} reactivados=${reactivados || 0} existentes=${existentes || 0}` +
    ` invalidos=${invalidos || 0} duplicados=${duplicados || 0} fallidos=${fallidos || 0} tiempo=${tiempo}ms`
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
    p.anio_consulta,
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
  let reactivados = 0;
  let existentes = 0;
  let invalidos = 0;
  let duplicados = 0;
  let totalFallidos = 0;

  try {
    const body = req.body || {};
    const lista = body.personas;

    if (!Array.isArray(lista) || lista.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe enviar "personas" como arreglo no vacío' });
    }

    // Diagnóstico: deja rastro de qué llegó realmente del servicio externo.
    // Con esto se distingue de un solo vistazo si el año viaja en la raíz,
    // por persona, dentro de metadata, con otro nombre, o no viaja.
    {
      const muestra = lista.slice(0, 3).map((p) => ({
        claves: p && typeof p === 'object' ? Object.keys(p) : typeof p,
        anio: p && typeof p === 'object' ? p.anio : undefined,
        anioCons: p && typeof p === 'object' ? p.anio_consulta : undefined,
        anioMetadata: anioDeMetadata(p && typeof p === 'object' ? p.metadata : null),
        numero: p && typeof p === 'object' ? p.numero_documento : undefined
      }));
      console.log(
        `[integracion] body.claves=${JSON.stringify(Object.keys(body))}` +
        ` anioRaiz=${JSON.stringify(body.anio)}` +
        ` anioConsRaiz=${JSON.stringify(body.anio_consulta)}` +
        ` anioMetadataRaiz=${JSON.stringify(anioDeMetadata(body.metadata))}` +
        ` muestras=${JSON.stringify(muestra)}`
      );
    }

    // Año por defecto para todo el lote. Cada persona puede pisarlo con su
    // propio "anio". Es solo un organizador: RUNT no filtra por año.
    //
    // Precedencia: anio por persona > anio_consulta por persona > metadata
    // por persona > anio en la raíz > anio_consulta en la raíz > metadata en
    // la raíz. Contravenciones lo manda dentro de metadata.
    const anioSolicitud = resolverAnio([
      body.anio,
      body.anio_consulta,
      anioDeMetadata(body.metadata)
    ]);
    if (anioSolicitud === null) {
      return res.status(400).json({
        ok: false,
        error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}`
      });
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
      // Fuentes del año para ESTA persona, de mayor a menor prioridad.
      // La última es el año por defecto del lote.
      const fuentesAnio = [
        persona && persona.anio,
        persona && persona.anio_consulta,
        anioDeMetadata(persona && persona.metadata),
        anioSolicitud
      ];
      const anio = resolverAnio(fuentesAnio);
      // El primer valor que vino, para devolverlo como eco aunque sea inválido.
      const anioBruto = fuentesAnio.find((f) => f != null && f !== '' && f !== 0);

      const base = { referencia_externa: ref, tipo_documento: tipoOriginal, numero_documento: numero, anio: anioBruto ?? null };
      if (metadata !== null) base.metadata = metadata;

      if (anio === null) {
        invalidos++;
        response.push({
          ...base,
          estado_recepcion: 'INVALIDO',
          estado_consulta: null,
          resultado_disponible: false,
          error: `anio debe ser un entero entre ${ANIO_MIN} y ${ANIO_MAX}`
        });
        return;
      }

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
      const registro = { indice: response.length, ref, tipo, tipoOriginal, numero, metadata, anio };
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
    const insertadosSet = new Set();
    const reactivadosSet = new Set();
    // clave `${tipoCanonico}|${numero}` -> { mensaje, codigo } de SQL
    const fallidos = new Map();

    if (nuevos.length > 0) {
      try {
        const r = await pool.query(`
          INSERT INTO persona_natural_propietario (
            tipo_documento, numero_documento,
            direccion_consultada, direccion_encontrada,
            origen_registro, anio_consulta, fecha_actualizacion
          )
          SELECT u.tipo, u.numero, FALSE, FALSE, $3, NULLIF(u.anio, 0), NOW()
          FROM unnest($1::text[], $2::text[], $4::int[]) AS u(tipo, numero, anio)
          ON CONFLICT (tipo_documento, numero_documento) DO NOTHING
          RETURNING numero_documento
        `, [
          nuevos.map(n => n.tipo),
          nuevos.map(n => n.numero),
          origen,
          nuevos.map(n => n.anio || 0)
        ]);
        r.rows.forEach(x => insertadosSet.add(x.numero_documento));
      } catch (err) {
        // Un solo registro inválido (ej. tipo_documento > 30) revierte TODO el
        // lote multi-fila. Reintentamos fila por fila para no perder el resto.
        console.error('[integracion] lote rechazado, reintentando fila por fila:', err.message);
        for (const n of nuevos) {
          try {
            const r = await pool.query(`
              INSERT INTO persona_natural_propietario (
                tipo_documento, numero_documento,
                direccion_consultada, direccion_encontrada,
                origen_registro, anio_consulta, fecha_actualizacion
              ) VALUES ($1, $2, FALSE, FALSE, $3, NULLIF($4, 0), NOW())
              ON CONFLICT (tipo_documento, numero_documento) DO NOTHING
              RETURNING numero_documento
            `, [n.tipo, n.numero, origen, n.anio || 0]);
            if (r.rowCount > 0) insertadosSet.add(n.numero);
          } catch (errFila) {
            fallidos.set(`${n.tipo}|${n.numero}`, {
              mensaje: errFila.message,
              codigo: errFila.code || null
            });
          }
        }
      }
    }

    // 3b) Re-activar personas que ya existían con un año de consulta MENOR.
    //     El único es (tipo_documento, numero_documento), así que la coincidencia
    //     es por número de documento — igual que en el resto del módulo.
    //     Se limpian las marcas de consulta para que vuelva a la cola; la
    //     dirección anterior se conserva en fk_direcciones hasta que el nuevo
    //     scraping la sobrescriba.
    //
    //     CORRECCIÓN: antes esto recorría solo `nuevos` (los que NO existían),
    //     lo que lo dejaba sin efecto — los reactivados ya venían del INSERT con
    //     su año puesto. Las filas que existían sin año (NULL) nunca se
    //     actualizaban y el operador veía "Sin año" aunque el servicio enviara
    //     el año de nuevo. Ahora se recorre TODO el lote válido.
    const reactivables = validos.filter(v => (v.anio || 0) > 0);
    if (reactivables.length > 0) {
      try {
        const r = await pool.query(`
          UPDATE persona_natural_propietario AS p
          SET
            anio_consulta = u.anio,
            origen_registro = $1,
            direccion_consultada = FALSE,
            direccion_encontrada = FALSE,
            error_consulta_direccion = NULL,
            fecha_consulta_direccion = NULL,
            fecha_actualizacion = NOW()
          FROM unnest($2::text[], $3::int[]) AS u(numero, anio)
          WHERE p.numero_documento = u.numero
            AND u.anio > 0
            AND COALESCE(p.anio_consulta, 0) < u.anio
          RETURNING p.numero_documento
        `, [
          origen,
          reactivables.map(n => n.numero),
          reactivables.map(n => n.anio || 0)
        ]);
        r.rows.forEach(x => reactivadosSet.add(x.numero_documento));
      } catch (err) {
        console.error('[integracion] no se pudo reactivar por año más nuevo:', err.message);
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
        item.anio = valido.anio || null;
        continue;
      }

      // Ya existía, pero llegó un año de consulta más nuevo: vuelve a la cola.
      if (existente && reactivadosSet.has(valido.numero)) {
        reactivados++;
        item.estado_recepcion = 'REACTIVADO';
        item.estado_consulta = 'PENDIENTE';
        item.resultado_disponible = false;
        item.anio = valido.anio || null;
        continue;
      }

      if (existente) {
        existentes++;
        item.estado_recepcion = 'YA_EXISTIA';
        item.estado_consulta = estadoPublico(existente, enProceso.has(valido.numero));
        item.resultado_disponible = item.estado_consulta === 'ENCONTRADA';
        item.anio = existente.anio_consulta ?? null;
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

      // Falló el INSERT de esta fila concreta: NO se guardó, no inventar 'YA_EXISTIA'
      const falla = fallidos.get(`${valido.tipo}|${valido.numero}`);
      if (falla) {
        totalFallidos++;
        item.estado_recepcion = 'ERROR';
        item.estado_consulta = null;
        item.resultado_disponible = false;
        item.error = falla.mensaje;
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
      recibidos, insertados, reactivados, existentes, invalidos, duplicados, fallidos: totalFallidos, inicio
    });

    const cuerpo = {
      cliente: cliente.codigo,
      total_recibidos: recibidos,
      insertados,
      reactivados,
      existentes,
      invalidos,
      duplicados,
      fallidos: totalFallidos,
      personas: response
    };

    // Si algo no se pudo guardar, NO responder 200: el integrador debe saberlo.
    if (totalFallidos > 0) {
      const soloLargo = Array.from(fallidos.values()).every(f => f.codigo === '22001');
      return res.status(soloLargo ? 400 : 500).json({
        ok: false,
        error: soloLargo
          ? 'Uno o más valores exceden el largo permitido por la base de datos'
          : 'No se pudieron insertar todas las personas',
        ...cuerpo
      });
    }

    return res.json({ ok: true, ...cuerpo });
  } catch (error) {
    logIntegracion({
      cliente: cliente.codigo,
      endpoint: '/ubicabilidad/personas',
      recibidos, insertados, reactivados, existentes, invalidos, duplicados, fallidos: totalFallidos, inicio
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
