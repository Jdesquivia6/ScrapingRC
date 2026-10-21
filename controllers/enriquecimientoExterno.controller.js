const pool = require('../utils/db');
const { codigoParaEnviar, armarPayload, enviarBatch } = require('../utils/contravencionesClient');

const LIMITE_DEFECTO = 5000;
const LIMITE_MAXIMO = 20000;
const TAMANO_UPDATE = 500;

function esFallo(estado) {
  const e = String(estado || '').toUpperCase();
  return e === 'ERROR' || e === 'FALLIDA' || e === 'FALLIDO' || e === 'RECHAZADA';
}

function clavesResultado(respuesta) {
  const mapa = new Map();
  for (const r of respuesta?.resultados || []) {
    mapa.set(`${r?.tipoDocumento || ''}|${r?.numeroDocumento || ''}`, r);
  }
  return mapa;
}

async function seleccionarRegistros(client, { anio, origen, limite }) {
  const params = [];
  const condiciones = [
    'p.direccion_consultada = TRUE',
    'p.direccion_encontrada = TRUE',
    "p.origen_registro LIKE 'API_%'",
    'p.numero_documento IS NOT NULL',
    "TRIM(p.numero_documento) <> ''"
  ];

  if (anio === 0) {
    params.push(0);
    condiciones.push(`COALESCE(p.anio_consulta, 0) = $${params.length}`);
  } else {
    params.push(anio);
    condiciones.push(`p.anio_consulta = $${params.length}`);
  }

  if (origen) {
    params.push(origen);
    condiciones.push(`p.origen_registro = $${params.length}`);
  }

  params.push(limite);

  return client.query(`
    SELECT p.id_per_natural_dir,
           p.tipo_documento,
           p.numero_documento,
           p.nombres,
           p.apellidos,
           p.celular,
           p.correo,
           d.direccion,
           d.municio_departamento,
           d.telefono
    FROM persona_natural_propietario p
    LEFT JOIN direcciones d ON d.id_direcciones = p.fk_direcciones
    WHERE ${condiciones.join('\n      AND ')}
    ORDER BY p.id_per_natural_dir
    LIMIT $${params.length}
  `, params);
}

async function marcarExitosos(client, registros) {
  for (let i = 0; i < registros.length; i += TAMANO_UPDATE) {
    const lote = registros.slice(i, i + TAMANO_UPDATE);
    const ids = lote.map(r => r.id);
    const personaIds = lote.map(r => (r.personaId || null));

    try {
      await client.query(`
        UPDATE persona_natural_propietario p
        SET enviado_externo = TRUE,
            fecha_envio_externo = NOW(),
            intentos_envio_externo = COALESCE(p.intentos_envio_externo, 0) + 1,
            error_envio_externo = NULL,
            externo_persona_id = u.persona_id
        FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::bigint[]) AS persona_id) u
        WHERE p.id_per_natural_dir = u.id
      `, [ids, personaIds]);
    } catch (err) {
      // externo_persona_id aún no existe: marcamos el envío igual.
      if (!String(err.message).includes('externo_persona_id')) throw err;
      await client.query(`
        UPDATE persona_natural_propietario
        SET enviado_externo = TRUE,
            fecha_envio_externo = NOW(),
            intentos_envio_externo = COALESCE(intentos_envio_externo, 0) + 1,
            error_envio_externo = NULL
        WHERE id_per_natural_dir = ANY($1::uuid[])
      `, [ids]);
    }
  }
}

async function marcarFallidos(client, registros) {
  for (let i = 0; i < registros.length; i += TAMANO_UPDATE) {
    const lote = registros.slice(i, i + TAMANO_UPDATE);
    await client.query(`
      UPDATE persona_natural_propietario
      SET enviado_externo = FALSE,
          fecha_envio_externo = NOW(),
          intentos_envio_externo = COALESCE(intentos_envio_externo, 0) + 1,
          error_envio_externo = $2
      WHERE id_per_natural_dir = ANY($1::uuid[])
    `, [
      lote.map(r => r.id),
      lote.map(r => r.error || 'contravenciones la contó como fallida y no dio motivo (ver consola)')
        .join(' | ')
    ]);
  }
}

/**
 * Envía los resultados del scraping de un año a CONTRAVENCIONES.
 *
 * Body: { anio, origen?, limite? }
 *  - anio: año de consulta registrado desde el primer payload (0 = "sin año")
 *  - solo personas consultadas con dirección encontrada, aunque ya se hayan enviado
 */
exports.enviarAnioExterno = async (req, res) => {
  const client = await pool.connect();
  try {
    const anioRaw = req.body?.anio;
    const anio = Number(anioRaw);
    if (!Number.isInteger(anio) || anio < 0 || String(anioRaw ?? '').trim().length > 4) {
      return res.status(400).json({ ok: false, error: 'anio inválido (año de 4 dígitos o 0 para "sin año")' });
    }

    const origen = req.body?.origen ? String(req.body.origen).trim() : '';
    if (origen && !/^API_[A-Za-z0-9_]+$/.test(origen)) {
      return res.status(400).json({ ok: false, error: 'Origen inválido (debe iniciar con API_)' });
    }

    const limite = Math.min(Number(req.body?.limite) || LIMITE_DEFECTO, LIMITE_MAXIMO);

    const { rows: seleccionadas } = await seleccionarRegistros(client, { anio, origen, limite });

    if (seleccionadas.length === 0) {
      return res.json({
        ok: true,
        anio,
        seleccionadas: 0,
        enviadas: 0,
        exitosas: 0,
        fallidas: 0,
        yaExistian: 0,
        noSoportadas: 0,
        mensaje: `No hay personas con dirección encontrada para el año ${anio}.`
      });
    }

    // Separar lo que CONTRAVENCIONES acepta de lo que aún no (PPT no está en su lista).
    const enviables = [];
    const porTipoNoSoportado = {};

    for (const fila of seleccionadas) {
      const codigo = codigoParaEnviar(fila.tipo_documento);
      if (!codigo) {
        const clave = fila.tipo_documento || 'SIN_TIPO';
        porTipoNoSoportado[clave] = (porTipoNoSoportado[clave] || 0) + 1;
        continue;
      }
      enviables.push({
        id: fila.id_per_natural_dir,
        payload: armarPayload({
          tipoDocumento: codigo,
          numeroDocumento: fila.numero_documento,
          nombres: fila.nombres,
          apellidos: fila.apellidos,
          direccion: fila.direccion,
          municipioDepartamento: fila.municio_departamento,
          telefono: fila.telefono || fila.celular,
          correo: fila.correo
        })
      });
    }

    const noSoportadas = Object.values(porTipoNoSoportado).reduce((a, b) => a + b, 0);

    let respuesta = null;
    let errorEnvio = null;

    if (enviables.length > 0) {
      try {
        respuesta = await enviarBatch(enviables.map(e => e.payload));
      } catch (err) {
        errorEnvio = err.message;
      }
    }

    // Cruzar la respuesta de CONTRAVENCIONES con las filas que enviamos.
    const porDocumento = clavesResultado(respuesta);
    const hayDetalle = porDocumento.size > 0;
    const loteFallas = Number(respuesta?.fallidas) || 0;

    if (enviables.length > 0 && !hayDetalle) {
      console.warn(
        `[enriquecimiento] El año ${anio} no trajo detalle por persona en la respuesta; ` +
        'se confía en los contadores del lote.'
      );
    }

    // Su servicio usa nombres de campo libres para el motivo; probamos varios.
    const mensajeDe = (r) =>
      r?.mensaje || r?.message || r?.error || r?.detalle ||
      r?.description || r?.motivo || r?.observacion || r?.razon || null;

    const marcas = enviables.map(({ id, payload }) => {
      const clave = `${payload.tipoDocumento}|${payload.numeroDocumento}`;
      const resultado = porDocumento.get(clave);
      const falloExplicito = !!resultado && esFallo(resultado.estado);
      // Con detalle, solo sale bien el que aparece y no falla.
      // Sin detalle, confiamos en los contadores: si el lote no falló, salió bien.
      const exitoso =
        !errorEnvio &&
        !falloExplicito &&
        (hayDetalle ? !!resultado : loteFallas === 0);

      return {
        id,
        clave,
        numeroDocumento: payload.numeroDocumento,
        tipoDocumento: payload.tipoDocumento,
        personaId: resultado?.personaId ?? resultado?.id ?? null,
        estado: resultado?.estado ?? null,
        exitoso,
        error: errorEnvio || mensajeDe(resultado) || null
      };
    });

    const fallidas = marcas.filter(m => !m.exitoso);

    // Log de diagnóstico: qué decía CONTRAVENCIONES por cada fila que falló.
    if (fallidas.length > 0) {
      console.warn(`[enriquecimiento] === ${fallidas.length} fila(s) fallaron en el año ${anio} ===`);
      for (const m of fallidas) {
        console.warn(
          `[enriquecimiento] ✗ ${m.clave} | estado=${m.estado ?? '(sin estado)'} | ` +
          `personaId=${m.personaId ?? '(ninguno)'} | motivo=${m.error ?? '(no dieron motivo)'}`
        );
      }
      console.warn(`[enriquecimiento] respuesta cruda del lote: ${JSON.stringify(respuesta)}`);
      if (respuesta?.resultados) {
        console.warn(`[enriquecimiento] resultados[] crudo: ${JSON.stringify(respuesta.resultados)}`);
      }
    }

    await marcarExitosos(client, marcas.filter(m => m.exitoso));
    await marcarFallidos(client, fallidas);

    if (errorEnvio) {
      return res.status(502).json({
        ok: false,
        anio,
        seleccionadas: seleccionadas.length,
        enviadas: enviables.length,
        exitosas: 0,
        fallidas: enviables.length,
        yaExistian: 0,
        noSoportadas,
        porTipoNoSoportado,
        error: errorEnvio
      });
    }

    return res.json({
      ok: true,
      anio,
      seleccionadas: seleccionadas.length,
      enviadas: enviables.length,
      exitosas: respuesta?.exitosas ?? marcas.length - fallidas.length,
      fallidas: respuesta?.fallidas ?? fallidas.length,
      yaExistian: respuesta?.yaExistian ?? 0,
      totalRecibidas: respuesta?.totalRecibidas ?? 0,
      noSoportadas,
      porTipoNoSoportado,
      errores: fallidas.slice(0, 50).map(m => m.error).filter(Boolean),
      // Lo que dijo CONTRAVENCIONES por persona, para depurar sin abrir la consola.
      detalle: marcas.map(m => ({
        numeroDocumento: m.numeroDocumento,
        tipoDocumento: m.tipoDocumento,
        estado: m.estado,
        personaId: m.personaId,
        exitoso: m.exitoso,
        motivo: m.error
      })),
      crudo: respuesta
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    client.release();
  }
};
