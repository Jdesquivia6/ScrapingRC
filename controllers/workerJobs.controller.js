const pool = require('../utils/db');
const axios = require('axios');
const { obtenerEstadoSesionRunt } = require('../utils/runtSession');
const { API_HIKVISION } = require('../config');

const EXTERNAL_API_PERSONAS = `http://${API_HIKVISION}:5051/v1/rest/api/personas/enriquecer`;

const JOB_STATES = new Set([
  'pendiente',
  'procesando',
  'pausado',
  'finalizado',
  'fallido',
  'cancelado',
  'sesion_vencida'
]);

const ITEM_STATES = new Set([
  'pendiente',
  'procesando',
  'exitoso',
  'fallido',
  'sin_informacion',
  'timeout',
  'sesion_vencida'
]);

const MODULES = new Set([
  'consulta-placa',
  'datos-vehiculo',
  'personas-direcciones',
  'liquidaciones',
  'liquidacion',
  'ubicabilidad-personas'
]);

// Límite de ítems por job según módulo (evita sesiones RUNT muy largas)
const MAX_ITEMS_POR_JOB = {
  'ubicabilidad-personas': 90
};

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function sanitizeEstado(estado, allowedSet) {
  if (!estado) return null;
  const value = String(estado).trim().toLowerCase();
  return allowedSet.has(value) ? value : null;
}

function extractDocumento(payload = {}) {
  return payload.numeroDocumento || payload.documento || null;
}

function canUseModulo(req, modulo) {
  if (req.user.rol === 'administrador') return true;
  return Array.isArray(req.user.modulos) && req.user.modulos.includes(modulo);
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function canManageJob(req, job) {
  if (req.user.rol === 'administrador') return true;
  return String(job.fk_usuario) === String(req.user.id_usuario);
}

async function recalcularYActualizarJob(client, idJob) {
  const countersResult = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE estado IN ('exitoso', 'fallido', 'sin_informacion', 'timeout', 'sesion_vencida')
      )::int AS procesadas,
      COUNT(*) FILTER (WHERE estado = 'exitoso')::int AS exitosas,
      COUNT(*) FILTER (
        WHERE estado IN ('fallido', 'sin_informacion', 'timeout', 'sesion_vencida')
      )::int AS fallidas,
      COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
      COUNT(*) FILTER (WHERE estado = 'procesando')::int AS en_proceso
    FROM worker_job_items
    WHERE fk_job = $1::uuid
  `, [idJob]);

  const counters = countersResult.rows[0] || {
    total: 0,
    procesadas: 0,
    exitosas: 0,
    fallidas: 0,
    pendientes: 0,
    en_proceso: 0
  };

  const procesadas = Number(counters.procesadas || 0);
  const total = Number(counters.total || 0);
  const pendientes = Number(counters.pendientes || 0);
  const enProceso = Number(counters.en_proceso || 0);

  let nuevoEstado = 'procesando';

  if (total > 0 && procesadas >= total && pendientes === 0 && enProceso === 0) {
    nuevoEstado = 'finalizado';
  }

  const updateResult = await client.query(`
    UPDATE worker_jobs
    SET total = $2::int,
        procesadas = $3::int,
        exitosas = $4::int,
        fallidas = $5::int,
        estado = $6::varchar,
        finished_at = CASE
          WHEN $6::varchar = 'finalizado' THEN NOW()
          ELSE NULL
        END,
        error = CASE
          WHEN $6::varchar = 'finalizado' THEN NULL
          ELSE error
        END
    WHERE id_job = $1::uuid
    RETURNING *
  `, [
    idJob,
    total,
    procesadas,
    Number(counters.exitosas || 0),
    Number(counters.fallidas || 0),
    String(nuevoEstado)
  ]);

  return {
    job: updateResult.rows[0],
    counters: {
      total,
      procesadas,
      exitosas: Number(counters.exitosas || 0),
      fallidas: Number(counters.fallidas || 0),
      pendientes,
      enProceso
    }
  };
}

exports.crearJob = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      modulo,
      workerName = null,
      items = []
    } = req.body;

    const moduloSanitizado = String(modulo || '').trim();

    if (!MODULES.has(moduloSanitizado)) {
      return res.status(400).json({
        ok: false,
        error: 'El modulo no es valido'
      });
    }

    if (!canUseModulo(req, moduloSanitizado)) {
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos para crear trabajos en este modulo'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debe enviar items[] con al menos un elemento'
      });
    }

    const preparedItems = items
      .map((item) => (item && typeof item === 'object' ? item : null))
      .filter(Boolean);

    if (preparedItems.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Los items deben ser objetos validos'
      });
    }

    // Determinar tamaño de chunk según módulo (sin límite = todo en un job)
    const limitePorJob = MAX_ITEMS_POR_JOB[moduloSanitizado];
    const chunks = limitePorJob && preparedItems.length > limitePorJob
      ? chunkArray(preparedItems, limitePorJob)
      : [preparedItems];

    await client.query('BEGIN');

    const jobs = [];

    for (const chunk of chunks) {
      const jobInsert = await client.query(`
        INSERT INTO worker_jobs (
          modulo,
          estado,
          fk_usuario,
          worker_name,
          total,
          procesadas,
          exitosas,
          fallidas
        )
        VALUES ($1, 'pendiente', $2, $3, $4, 0, 0, 0)
        RETURNING *
      `, [
        moduloSanitizado,
        req.user.id_usuario,
        workerName,
        chunk.length
      ]);

      const job = jobInsert.rows[0];

      for (const payload of chunk) {
        await client.query(`
          INSERT INTO worker_job_items (
            fk_job,
            payload,
            placa,
            documento,
            estado
          )
          VALUES ($1, $2::jsonb, $3, $4, 'pendiente')
        `, [
          job.id_job,
          JSON.stringify(payload),
          payload.placa || null,
          extractDocumento(payload)
        ]);
      }

      jobs.push(job);
    }

    await client.query('COMMIT');

    if (jobs.length === 1) {
      return res.status(201).json({
        ok: true,
        job: jobs[0]
      });
    }

    return res.status(201).json({
      ok: true,
      jobs,
      message: `Se crearon ${jobs.length} trabajos (máx ${limitePorJob} documentos cada uno)`
    });

  } catch (error) {
    await client.query('ROLLBACK');

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};

exports.listarJobs = async (req, res) => {
  try {
    const {
      modulo,
      estado,
      workerName,
      limit = 50,
      offset = 0,
      mine = 'false'
    } = req.query;

    const params = [];
    const where = [];

    if (req.user.rol !== 'administrador') {
      params.push(req.user.id_usuario);
      where.push(`j.fk_usuario = $${params.length}`);
    }

    if (mine === 'true') {
      params.push(req.user.id_usuario);
      where.push(`j.fk_usuario = $${params.length}`);
    }

    if (modulo) {
      params.push(modulo);
      where.push(`j.modulo = $${params.length}`);
    }

    const estadoSanitizado = sanitizeEstado(estado, JOB_STATES);

    if (estado && !estadoSanitizado) {
      return res.status(400).json({
        ok: false,
        error: 'El estado no es valido'
      });
    }

    if (estadoSanitizado) {
      params.push(estadoSanitizado);
      where.push(`j.estado = $${params.length}`);
    }

    if (workerName) {
      params.push(workerName);
      where.push(`j.worker_name = $${params.length}`);
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    params.push(safeLimit);
    params.push(safeOffset);

    const whereSql = where.length > 0
      ? `WHERE ${where.join(' AND ')}`
      : '';

    const result = await pool.query(`
      SELECT
        j.*
      FROM worker_jobs j
      ${whereSql}
      ORDER BY j.created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `, params);

    return res.json({
      ok: true,
      total: result.rows.length,
      results: result.rows
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.obtenerDetalleJob = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

    const jobResult = await pool.query(`
      SELECT *
      FROM worker_jobs
      WHERE id_job = $1
    `, [id]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Job no encontrado'
      });
    }

    const job = jobResult.rows[0];

    if (req.user.rol !== 'administrador' && String(job.fk_usuario) !== String(req.user.id_usuario)) {
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos para ver este job'
      });
    }

    const itemsResult = await pool.query(`
      SELECT *
      FROM worker_job_items
      WHERE fk_job = $1
      ORDER BY created_at ASC
      LIMIT $2
    `, [id, limit]);

    return res.json({
      ok: true,
      job,
      items: itemsResult.rows
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.cancelarJob = async (req, res) => {
  try {
    const { id } = req.params;

    const update = await pool.query(`
      UPDATE worker_jobs
      SET estado = 'cancelado',
          finished_at = NOW(),
          error = NULL
      WHERE id_job = $1
        AND estado IN ('pendiente', 'procesando', 'pausado', 'sesion_vencida')
        AND (
          $2 = 'administrador'
          OR fk_usuario = $3
        )
      RETURNING *
    `, [id, req.user.rol, req.user.id_usuario]);

    if (update.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Job no encontrado o no cancelable'
      });
    }

    return res.json({
      ok: true,
      job: update.rows[0]
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.reintentarFallidos = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const jobResult = await client.query(`
      SELECT *
      FROM worker_jobs
      WHERE id_job = $1
      FOR UPDATE
    `, [id]);

    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        error: 'Job no encontrado'
      });
    }

    const sourceJob = jobResult.rows[0];

    if (req.user.rol !== 'administrador' && String(sourceJob.fk_usuario) !== String(req.user.id_usuario)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos para reintentar este job'
      });
    }

    const failedItems = await client.query(`
      SELECT payload, placa, documento
      FROM worker_job_items
      WHERE fk_job = $1
        AND estado IN ('fallido', 'timeout', 'sesion_vencida')
      ORDER BY created_at ASC
    `, [id]);

    if (failedItems.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'El job no tiene items fallidos para reintentar'
      });
    }

    const insertJob = await client.query(`
      INSERT INTO worker_jobs (
        modulo,
        estado,
        fk_usuario,
        worker_name,
        total,
        procesadas,
        exitosas,
        fallidas
      )
      VALUES ($1, 'pendiente', $2, $3, $4, 0, 0, 0)
      RETURNING *
    `, [
      sourceJob.modulo,
      sourceJob.fk_usuario,
      sourceJob.worker_name,
      failedItems.rows.length
    ]);

    const retryJob = insertJob.rows[0];

    for (const item of failedItems.rows) {
      await client.query(`
        INSERT INTO worker_job_items (
          fk_job,
          payload,
          placa,
          documento,
          estado
        )
        VALUES ($1, $2::jsonb, $3, $4, 'pendiente')
      `, [
        retryJob.id_job,
        JSON.stringify(item.payload),
        item.placa,
        item.documento
      ]);
    }

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      sourceJobId: sourceJob.id_job,
      retryJob
    });

  } catch (error) {
    await client.query('ROLLBACK');

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};

exports.tomarSiguienteJob = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      workerName = null,
      modulosPermitidos = [],
      sesionActiva,
      huellaViva
    } = req.body;

    if (!asBoolean(sesionActiva)) {
      return res.status(409).json({
        ok: false,
        error: 'Sesion RUNT no activa para tomar trabajos'
      });
    }

    if (!asBoolean(huellaViva)) {
      return res.status(409).json({
        ok: false,
        error: 'Huella no validada para tomar trabajos'
      });
    }

    const modulosUsuario = req.user.rol === 'administrador'
      ? modulosPermitidos
      : req.user.modulos || [];

    const modulosValidos = modulosUsuario.filter((m) => MODULES.has(m));

    if (!Array.isArray(modulosValidos) || modulosValidos.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No hay modulos permitidos para tomar jobs'
      });
    }

    await client.query('BEGIN');

    const result = await client.query(`
      WITH candidate AS (
        SELECT j.id_job
        FROM worker_jobs j
        WHERE j.estado = 'pendiente'
          AND j.modulo = ANY($1::text[])
          AND j.fk_usuario = $2
        ORDER BY j.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE worker_jobs j
      SET estado = 'procesando',
          started_at = COALESCE(j.started_at, NOW()),
          worker_name = COALESCE($3, j.worker_name)
      FROM candidate c
      WHERE j.id_job = c.id_job
      RETURNING j.*
    `, [
      modulosValidos,
      req.user.id_usuario,
      workerName
    ]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        ok: true,
        message: 'No hay jobs pendientes disponibles',
        job: null
      });
    }

    const job = result.rows[0];

    const items = await client.query(`
      SELECT *
      FROM worker_job_items
      WHERE fk_job = $1
        AND estado = 'pendiente'
      ORDER BY created_at ASC
    `, [job.id_job]);

    await client.query('COMMIT');

    return res.json({
      ok: true,
      job,
      items: items.rows
    });

  } catch (error) {
    await client.query('ROLLBACK');

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};

exports.workerHeartbeat = async (req, res) => {
  try {
    const {
      workerName = null,
      modulosPermitidos = [],
      huellaViva
    } = req.body;

    const estadoSesion = await obtenerEstadoSesionRunt();
    const huellaValidada = asBoolean(huellaViva);

    const modulosUsuario = req.user.rol === 'administrador'
      ? modulosPermitidos
      : req.user.modulos || [];

    const modulosValidos = modulosUsuario.filter((m) => MODULES.has(m));

    const elegible = Boolean(
      estadoSesion.activa &&
      estadoSesion.puedeConsultar &&
      huellaValidada &&
      modulosValidos.length > 0
    );

    const resumen = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
        COUNT(*) FILTER (WHERE estado = 'procesando')::int AS procesando,
        COUNT(*) FILTER (WHERE estado = 'pausado')::int AS pausados,
        COUNT(*) FILTER (WHERE estado = 'sesion_vencida')::int AS sesion_vencida
      FROM worker_jobs
      WHERE modulo = ANY($1::text[])
        AND (
          $2 = 'administrador'
          OR fk_usuario = $3
        )
    `, [
      modulosValidos,
      req.user.rol,
      req.user.id_usuario
    ]);

    return res.json({
      ok: true,
      workerName,
      elegible,
      reglas: {
        sesionActiva: Boolean(estadoSesion.activa),
        puedeConsultar: Boolean(estadoSesion.puedeConsultar),
        huellaViva: huellaValidada,
        modulosPermitidos: modulosValidos
      },
      session: estadoSesion,
      cola: resumen.rows[0] || {
        pendientes: 0,
        procesando: 0,
        pausados: 0,
        sesion_vencida: 0
      }
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.catalogoEstados = (req, res) => {
  return res.json({
    ok: true,
    jobEstados: Array.from(JOB_STATES),
    itemEstados: Array.from(ITEM_STATES),
    modulos: Array.from(MODULES)
  });
};

exports.actualizarEstadoItem = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      idItem,
      estado,
      resultado = null,
      error = null
    } = req.body;

    if (!idItem) {
      return res.status(400).json({
        ok: false,
        error: 'idItem es obligatorio'
      });
    }

    const estadoSanitizado = sanitizeEstado(estado, ITEM_STATES);

    if (!estadoSanitizado) {
      return res.status(400).json({
        ok: false,
        error: 'estado de item no valido'
      });
    }

    await client.query('BEGIN');

    const jobResult = await client.query(`
      SELECT *
      FROM worker_jobs
      WHERE id_job = $1
      FOR UPDATE
    `, [id]);

    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        error: 'Job no encontrado'
      });
    }

    const job = jobResult.rows[0];

    if (!canManageJob(req, job)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos para actualizar este job'
      });
    }

    if (!['procesando', 'pausado', 'sesion_vencida'].includes(job.estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'El job no permite reporte de items en su estado actual'
      });
    }

    const resultadoParam = resultado !== undefined && resultado !== null
      ? JSON.stringify(resultado.data || resultado)
      : 'null';

    const errorParam = error !== undefined && error !== null
      ? String(error)
      : null;

    const itemUpdate = await client.query(`
      UPDATE worker_job_items
      SET estado = $3::varchar,
          resultado = $4::jsonb,
          error = $5::text,
          updated_at = NOW()
      WHERE id_item = $1::uuid
        AND fk_job = $2::uuid
      RETURNING *
    `, [
      idItem,
      id,
      String(estadoSanitizado),
      resultadoParam,
      errorParam
    ]);

    if (itemUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        error: 'Item no encontrado para este job'
      });
    }

    const agregados = await recalcularYActualizarJob(client, id);

    await client.query('COMMIT');

    return res.json({
      ok: true,
      item: itemUpdate.rows[0],
      job: agregados.job,
      counters: agregados.counters
    });

  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};

exports.actualizarEstadoJobWorker = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      estado,
      error = null
    } = req.body;

    const estadoSanitizado = sanitizeEstado(estado, JOB_STATES);

    if (!estadoSanitizado || estadoSanitizado === 'pendiente' || estadoSanitizado === 'cancelado') {
      return res.status(400).json({
        ok: false,
        error: 'Estado de job no permitido para este endpoint'
      });
    }

    const result = await pool.query(`
      UPDATE worker_jobs
      SET estado = $2,
          error = $3,
          started_at = CASE
            WHEN $2 = 'procesando' THEN COALESCE(started_at, NOW())
            ELSE started_at
          END,
          finished_at = CASE
            WHEN $2 IN ('finalizado', 'fallido') THEN NOW()
            ELSE NULL
          END
      WHERE id_job = $1
        AND (
          $4 = 'administrador'
          OR fk_usuario = $5
        )
      RETURNING *
    `, [
      id,
      estadoSanitizado,
      error,
      req.user.rol,
      req.user.id_usuario
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Job no encontrado o sin permisos'
      });
    }

    return res.json({
      ok: true,
      job: result.rows[0]
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.obtenerProgresoJob = async (req, res) => {
  try {
    const { id } = req.params;

    const jobResult = await pool.query(`
      SELECT *
      FROM worker_jobs
      WHERE id_job = $1
    `, [id]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Job no encontrado'
      });
    }

    const job = jobResult.rows[0];

    if (!canManageJob(req, job)) {
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos para ver este job'
      });
    }

    const counters = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE estado IN ('exitoso', 'fallido', 'sin_informacion', 'timeout', 'sesion_vencida')
        )::int AS procesadas,
        COUNT(*) FILTER (WHERE estado = 'exitoso')::int AS exitosas,
        COUNT(*) FILTER (
          WHERE estado IN ('fallido', 'sin_informacion', 'timeout', 'sesion_vencida')
        )::int AS fallidas,
        COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
        COUNT(*) FILTER (WHERE estado = 'procesando')::int AS en_proceso
      FROM worker_job_items
      WHERE fk_job = $1
    `, [id]);

    const byStatus = await pool.query(`
      SELECT estado, COUNT(*)::int AS total
      FROM worker_job_items
      WHERE fk_job = $1
      GROUP BY estado
      ORDER BY estado ASC
    `, [id]);

    return res.json({
      ok: true,
      job,
      counters: counters.rows[0],
      byStatus: byStatus.rows
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

// Guardar resultado de scraping desde worker local
exports.guardarResultadoScraping = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const { idItem, modulo, resultado, fk_usuario } = req.body;

    if (!idItem || !modulo || !resultado) {
      return res.status(400).json({
        ok: false,
        error: 'idItem, modulo y resultado son obligatorios'
      });
    }

    const usuarioId = fk_usuario || req.user?.id_usuario;

    await client.query('BEGIN');

    // ================================================
    // CONSULTA-PLACA: Guardar en 3 tablas
    // ================================================
    if (modulo === 'consulta-placa') {
      const placa = resultado.placa || '';
      
      // 1. Insertar/actualizar consultas_placas
      await client.query(`
        INSERT INTO consultas_placas 
          (placa, estado_consulta, fecha_consulta, fk_usuario)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (placa) DO UPDATE SET
          estado_consulta = EXCLUDED.estado_consulta,
          fecha_consulta = NOW(),
          fk_usuario = COALESCE(consultas_placas.fk_usuario, EXCLUDED.fk_usuario)
        RETURNING id_consul_placa
      `, [placa, resultado.ok ? true : false, usuarioId]);

      // Obtener el id de la placa consultada
      const placaResult = await client.query(
        'SELECT id_consul_placa FROM consultas_placas WHERE placa = $1',
        [placa]
      );
      const id_consul_placa = placaResult.rows[0]?.id_consul_placa;

      if (id_consul_placa && resultado.ok) {
        // 2. Insertar/actualizar SOAT/Técnico/Propietario
        // Primero eliminar registros existentes de este propietario para evitar duplicados
        await client.query(
          'DELETE FROM runt_soat_tecno_propietario WHERE numero_identificacion_propietario = $1',
          [resultado.numero_identificacion_propietario]
        );

        // Luego insertar nuevo registro
        await client.query(`
          INSERT INTO runt_soat_tecno_propietario (
            tipo_identificacion_propietario,
            numero_identificacion_propietario,
            nombre_razon_social_propietario,
            fecha_expedicion_tecno,
            fecha_vigencia_tecno,
            fecha_inicio_vigencia_soat,
            fecha_vencimiento_vigencia_soat,
            fk_consul_placa,
            data
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [
          resultado.tipo_identificacion_propietario || null,
          resultado.numero_identificacion_propietario || null,
          resultado.nombre_razon_social_propietario || null,
          resultado.fecha_expedicion_tecno || null,
          resultado.fecha_vigencia_tecno || null,
          resultado.fecha_inicio_vigencia_soat || null,
          resultado.fecha_vencimiento_vigencia_soat || null,
          id_consul_placa,
          JSON.stringify(resultado.data || resultado)
        ]);

        // 3. Insertar/actualizar persona natural propietario
        const nombres = (resultado.nombre_razon_social_propietario || '').split(' ').slice(0, -1).join(' ');
        const apellidos = (resultado.nombre_razon_social_propietario || '').split(' ').slice(-1).join(' ');

        // Verificar si ya existe
        const existingPersona = await client.query(
          'SELECT id_per_natural_dir FROM persona_natural_propietario WHERE numero_documento = $1',
          [resultado.numero_identificacion_propietario]
        );

        if (existingPersona.rows.length > 0) {
          // Actualizar
          await client.query(`
            UPDATE persona_natural_propietario SET
              nombres = $1,
              apellidos = $2,
              estado_runt_persona = $3,
              fk_consul_placa = COALESCE(fk_consul_placa, $4)
            WHERE numero_documento = $5
          `, [nombres, apellidos || null, true, id_consul_placa, resultado.numero_identificacion_propietario]);
        } else {
          // Insertar
          await client.query(`
            INSERT INTO persona_natural_propietario (
              tipo_documento,
              numero_documento,
              nombres,
              apellidos,
              estado_runt_persona,
              fk_consul_placa,
              direccion_consultada
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [
            resultado.tipo_identificacion_propietario || 'Cédula Ciudadanía',
            resultado.numero_identificacion_propietario || null,
            nombres,
            apellidos || null,
            true,
            id_consul_placa,
            false
          ]);
        }
      }
    }

    // ================================================
    // DATOS-VEHICULO: Guardar en runt_datos_vehiculos
    // ================================================
    else if (modulo === 'datos-vehiculo') {
      const placa = resultado.placa || '';
      
      // Obtener id de la placa
      const placaResult = await client.query(
        'SELECT id_consul_placa FROM consultas_placas WHERE placa = $1',
        [placa]
      );
      const id_consul_placa = placaResult.rows[0]?.id_consul_placa;

      if (id_consul_placa && resultado.ok) {
        // Los datos vienen en resultado.datos_vehiculo
        const datosVehiculo = resultado.datos_vehiculo || {};
        
        // Primero eliminar registros existentes para evitar duplicados
        await client.query(
          'DELETE FROM runt_datos_vehiculos WHERE fk_consul_placa = $1',
          [id_consul_placa]
        );

        await client.query(`
          INSERT INTO runt_datos_vehiculos (
            clase, marca, linea, servicio, color, modelo,
            fk_consul_placa, data, estado_consulta, error_consulta
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [
          datosVehiculo.clase || null,
          datosVehiculo.marca || null,
          datosVehiculo.linea || null,
          datosVehiculo.servicio || null,
          datosVehiculo.color || null,
          datosVehiculo.modelo || null,
          id_consul_placa,
          JSON.stringify(resultado.data || resultado),
          true,
          null
        ]);
      }
    }

    // ================================================
    // PERSONAS-DIRECCIONES: Guardar en direcciones + persona_natural
    // ================================================
    else if (modulo === 'personas-direcciones') {
      const tipoDoc = resultado.tipoDocumento || '';
      const numDoc = resultado.numeroDocumento || '';

      if (resultado.ok && resultado.direcciones?.length > 0) {
        const primeraDir = resultado.direcciones[0] || {};

        const nombres = [primeraDir.primerNombre, primeraDir.segundoNombre]
          .filter(Boolean)
          .join(' ')
          .trim();
        const apellidos = [primeraDir.primerApellido, primeraDir.segundoApellido]
          .filter(Boolean)
          .join(' ')
          .trim();

        const direccion = primeraDir.direccion || null;
        const municipio = primeraDir.municipio || primeraDir.municipioDepartamento || primeraDir.municio_departamento || null;
        const telefono = primeraDir.telefono || primeraDir.celular || null;
        const tipoDireccion = primeraDir.tipoDireccion || primeraDir.tipo_direccion || null;
        const correo = primeraDir.correoElectronico || primeraDir.correo || null;

        // 1) Buscar o crear dirección para evitar duplicados
        let idDireccion = null;

        if (direccion) {
          const dirExistente = await client.query(`
            SELECT id_direcciones
            FROM direcciones
            WHERE direccion = $1
              AND COALESCE(municio_departamento, '') = COALESCE($2, '')
              AND COALESCE(telefono, '') = COALESCE($3, '')
              AND COALESCE(tipo_direccion, '') = COALESCE($4, '')
            LIMIT 1
          `, [direccion, municipio, telefono, tipoDireccion]);

          if (dirExistente.rows.length > 0) {
            idDireccion = dirExistente.rows[0].id_direcciones;
          } else {
            const insertedDir = await client.query(`
              INSERT INTO direcciones (
                direccion,
                municio_departamento,
                telefono,
                tipo_direccion,
                estado_direccion,
                dato_migrado,
                fecha_actualizacion
              ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
              RETURNING id_direcciones
            `, [direccion, municipio, telefono, tipoDireccion, true, primeraDir.direccionMigrada || null]);

            idDireccion = insertedDir.rows[0]?.id_direcciones || null;
          }
        }

        // 2) Actualizar persona por número de documento (no crear duplicados)
        const updatePersona = await client.query(`
          UPDATE persona_natural_propietario
          SET
            tipo_documento = COALESCE(NULLIF(tipo_documento, ''), $2),
            nombres = COALESCE(NULLIF(nombres, ''), $3),
            apellidos = COALESCE(NULLIF(apellidos, ''), $4),
            celular = COALESCE(NULLIF(celular, ''), $5),
            correo = COALESCE(NULLIF(correo, ''), $6),
            fk_direcciones = COALESCE($7, fk_direcciones),
            direccion_consultada = TRUE,
            direccion_encontrada = TRUE,
            error_consulta_direccion = NULL,
            fecha_consulta_direccion = NOW(),
            fecha_actualizacion = NOW()
          WHERE numero_documento = $1
          RETURNING id_per_natural_dir
        `, [
          numDoc,
          tipoDoc,
          nombres || null,
          apellidos || null,
          telefono,
          correo,
          idDireccion
        ]);

        if (updatePersona.rowCount === 0) {
          throw new Error(`No existe persona_natural_propietario para documento ${numDoc}`);
        }

        // 3) Obtener placa relacionada via JOIN y enviar al microservicio externo
        try {
          const personaConPlaca = await client.query(`
            SELECT
              p.id_per_natural_dir,
              p.numero_documento,
              cp.placa
            FROM persona_natural_propietario p
            LEFT JOIN consultas_placas cp ON cp.id_consul_placa = p.fk_consul_placa
            WHERE p.numero_documento = $1
            LIMIT 1
          `, [numDoc]);

          const placa = personaConPlaca.rows[0]?.placa || null;

          if (!placa) {
            console.log(`[personas] Sin placa relacionada para ${numDoc} — saltando envío externo`);
          } else {
            console.log(`[personas] Placa relacionada: ${placa} para ${numDoc} — enviando a externo`);

            const body = {
              tipoDocumento: tipoDoc,
              numeroDocumento: numDoc,
              nombres: nombres || null,
              apellidos: apellidos || null,
              direccion: direccion || null,
              municipioDepartamento: municipio || null,
              telefono: telefono || null,
              correo: correo || null,
              placa: placa
            };

            await axios.post(EXTERNAL_API_PERSONAS, body, {
              headers: { 'Content-Type': 'application/json' },
              timeout: 15000
            });

            console.log(`[personas] Enviado exitosamente al externo: ${numDoc} placa ${placa}`);

            // 4) Marcar como enviado exitoso
            await client.query(`
              UPDATE persona_natural_propietario
              SET
                enviado_externo = TRUE,
                fecha_envio_externo = NOW(),
                error_envio_externo = NULL
              WHERE numero_documento = $1
            `, [numDoc]);

            console.log(`[personas] Marcado como enviado_externo=TRUE para ${numDoc}`);
          }
        } catch (err) {
          // 5) Si falla, incrementar intentos y registrar error
          console.warn(`[personas] Error enviando al externo para ${numDoc}: ${err.message}`);

          await client.query(`
            UPDATE persona_natural_propietario
            SET
              intentos_envio_externo = COALESCE(intentos_envio_externo, 0) + 1,
              error_envio_externo = $2
            WHERE numero_documento = $1
          `, [numDoc, err.message]);

          console.log(`[personas] Intentos incremented for ${numDoc} — error: ${err.message}`);
        }
      }
    }

    // ================================================
    // UBICABILIDAD-PERSONAS: Crear/actualizar persona + direcciones
    // ================================================
    else if (modulo === 'ubicabilidad-personas') {
      const tipoDoc = resultado.tipoDocumento || '';
      const numDoc = resultado.numeroDocumento || '';

      if (resultado.ok && resultado.direcciones?.length > 0) {
        const primeraDir = resultado.direcciones[0] || {};

        const nombres = [primeraDir.primerNombre, primeraDir.segundoNombre]
          .filter(Boolean)
          .join(' ')
          .trim();
        const apellidos = [primeraDir.primerApellido, primeraDir.segundoApellido]
          .filter(Boolean)
          .join(' ')
          .trim();

        const direccion = primeraDir.direccion || null;
        const municipio = primeraDir.municipio || primeraDir.municipioDepartamento || primeraDir.municio_departamento || null;
        const telefono = primeraDir.telefono || primeraDir.celular || null;
        const tipoDireccion = primeraDir.tipoDireccion || primeraDir.tipo_direccion || null;
        const correo = primeraDir.correoElectronico || primeraDir.correo || null;

        // 1) Buscar o crear dirección
        let idDireccion = null;
        if (direccion) {
          const dirExistente = await client.query(`
            SELECT id_direcciones
            FROM direcciones
            WHERE direccion = $1
              AND COALESCE(municio_departamento, '') = COALESCE($2, '')
              AND COALESCE(telefono, '') = COALESCE($3, '')
              AND COALESCE(tipo_direccion, '') = COALESCE($4, '')
            LIMIT 1
          `, [direccion, municipio, telefono, tipoDireccion]);

          if (dirExistente.rows.length > 0) {
            idDireccion = dirExistente.rows[0].id_direcciones;
          } else {
            const insertedDir = await client.query(`
              INSERT INTO direcciones (
                direccion, municio_departamento, telefono,
                tipo_direccion, estado_direccion, dato_migrado, fecha_actualizacion
              ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
              RETURNING id_direcciones
            `, [direccion, municipio, telefono, tipoDireccion, true, primeraDir.direccionMigrada || null]);
            idDireccion = insertedDir.rows[0]?.id_direcciones || null;
          }
        }

        // 2) Crear o actualizar persona con origen CARGADO_POR_EXCEL
        const existePersona = await client.query(
          'SELECT id_per_natural_dir FROM persona_natural_propietario WHERE numero_documento = $1',
          [numDoc]
        );

        if (existePersona.rows.length > 0) {
          await client.query(`
            UPDATE persona_natural_propietario SET
              tipo_documento = COALESCE(NULLIF(tipo_documento, ''), $2),
              nombres = COALESCE(NULLIF(nombres, ''), $3),
              apellidos = COALESCE(NULLIF(apellidos, ''), $4),
              celular = COALESCE(NULLIF(celular, ''), $5),
              correo = COALESCE(NULLIF(correo, ''), $6),
              fk_direcciones = COALESCE($7, fk_direcciones),
              direccion_consultada = TRUE,
              direccion_encontrada = TRUE,
              error_consulta_direccion = NULL,
              fecha_consulta_direccion = NOW(),
              fecha_actualizacion = NOW(),
              origen_registro = 'CARGADO_POR_EXCEL'
            WHERE numero_documento = $1
          `, [numDoc, tipoDoc, nombres || null, apellidos || null, telefono, correo, idDireccion]);
        } else {
          await client.query(`
            INSERT INTO persona_natural_propietario (
              tipo_documento, numero_documento, nombres, apellidos,
              celular, correo, fk_direcciones,
              direccion_consultada, direccion_encontrada,
              error_consulta_direccion, fecha_consulta_direccion,
              origen_registro
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,NULL,NOW(),'CARGADO_POR_EXCEL')
          `, [
            tipoDoc || 'Cédula Ciudadanía',
            numDoc,
            nombres || null,
            apellidos || null,
            telefono,
            correo,
            idDireccion
          ]);
        }

        // 3) Enviar al microservicio externo (no debe bloquear el guardado local)
        try {
          const body = {
            tipoDocumento: tipoDoc,
            numeroDocumento: numDoc,
            nombres: nombres || null,
            apellidos: apellidos || null,
            direccion: direccion || null,
            municipioDepartamento: municipio || null,
            telefono: telefono || null,
            correo: correo || null,
            placa: null
          };

          await axios.post(EXTERNAL_API_PERSONAS, body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
          });

          await client.query(`
            UPDATE persona_natural_propietario
            SET enviado_externo = TRUE, fecha_envio_externo = NOW(), error_envio_externo = NULL
            WHERE numero_documento = $1
          `, [numDoc]);
        } catch (err) {
          console.warn(`[ubicabilidad-personas] Error enviando al externo ${numDoc}: ${err.message}`);
          try {
            await client.query(`
              UPDATE persona_natural_propietario
              SET intentos_envio_externo = COALESCE(intentos_envio_externo, 0) + 1, error_envio_externo = $2
              WHERE numero_documento = $1
            `, [numDoc, err.message]);
          } catch (updateErr) {
            console.warn(`[ubicabilidad-personas] No se pudo registrar intento externo ${numDoc}: ${updateErr.message}`);
          }
        }
      } else {
        // Sin direcciones o error — crear/actualizar con error
        const existePersona = await client.query(
          'SELECT id_per_natural_dir FROM persona_natural_propietario WHERE numero_documento = $1',
          [numDoc]
        );

        if (existePersona.rows.length > 0) {
          await client.query(`
            UPDATE persona_natural_propietario SET
              tipo_documento = COALESCE(NULLIF(tipo_documento, ''), $2),
              direccion_consultada = TRUE,
              direccion_encontrada = FALSE,
              error_consulta_direccion = $3,
              fecha_consulta_direccion = NOW(),
              origen_registro = 'CARGADO_POR_EXCEL'
            WHERE numero_documento = $1
          `, [numDoc, tipoDoc, resultado.error || 'No se encontraron direcciones']);
        } else {
          await client.query(`
            INSERT INTO persona_natural_propietario (
              tipo_documento, numero_documento,
              direccion_consultada, direccion_encontrada,
              error_consulta_direccion, fecha_consulta_direccion,
              origen_registro
            ) VALUES ($1,$2,TRUE,FALSE,$3,NOW(),'CARGADO_POR_EXCEL')
          `, [tipoDoc || 'Cédula Ciudadanía', numDoc, resultado.error || 'No se encontraron direcciones']);
        }
      }
    }

    await client.query('COMMIT');
    
    return res.json({
      ok: true,
      message: `Resultado guardado correctamente en ${modulo}`
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[guardarResultadoScraping] Error modulo=${modulo} item=${idItem}:`, error.message);
    console.error(error.stack);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};

// ============================================================
// REINTENTO: Enviar registros pendientes de personas al externo
// ============================================================

exports.reintentarEnviosPersonasPendientes = async (req, res) => {
  const client = await pool.connect();

  try {
    // 1) Obtener registros pendientes (no enviados, intentos < 3, con placa)
    const pendientes = await client.query(`
      SELECT
        p.id_per_natural_dir,
        p.numero_documento,
        p.tipo_documento,
        p.nombres,
        p.apellidos,
        p.celular,
        p.correo,
        p.fk_direcciones,
        d.direccion,
        d.municio_departamento,
        d.telefono,
        d.tipo_direccion,
        cp.placa
      FROM persona_natural_propietario p
      LEFT JOIN consultas_placas cp ON cp.id_consul_placa = p.fk_consul_placa
      LEFT JOIN direcciones d ON d.id_direcciones = p.fk_direcciones
      WHERE p.enviado_externo = FALSE
        AND p.intentos_envio_externo < 3
        AND cp.placa IS NOT NULL
        AND cp.placa != ''
      ORDER BY p.fecha_consulta_direccion ASC
      LIMIT 100
    `);

    const registros = registros.rows;
    let exitosos = 0;
    let fallidos = 0;
    const errores = [];

    for (const reg of registros) {
      try {
        const body = {
          tipoDocumento: reg.tipo_documento || null,
          numeroDocumento: reg.numero_documento || null,
          nombres: reg.nombres || null,
          apellidos: reg.apellidos || null,
          direccion: reg.direccion || null,
          municipioDepartamento: reg.municio_departamento || null,
          telefono: reg.telefono || reg.celular || null,
          correo: reg.correo || null,
          placa: reg.placa || null
        };

        await axios.post(EXTERNAL_API_PERSONAS, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        });

        // Éxito — marcar como enviado
        await client.query(`
          UPDATE persona_natural_propietario
          SET
            enviado_externo = TRUE,
            fecha_envio_externo = NOW(),
            error_envio_externo = NULL
          WHERE id_per_natural_dir = $1
        `, [reg.id_per_natural_dir]);

        console.log(`[personas-reintento] Enviado: ${reg.numero_documento} placa ${reg.placa}`);
        exitosos++;

      } catch (err) {
        // Fallo — incrementar intentos
        await client.query(`
          UPDATE persona_natural_propietario
          SET
            intentos_envio_externo = COALESCE(intentos_envio_externo, 0) + 1,
            error_envio_externo = $2
          WHERE id_per_natural_dir = $1
        `, [reg.id_per_natural_dir, err.message]);

        console.warn(`[personas-reintento] Error con ${reg.numero_documento}: ${err.message}`);
        errores.push({ numeroDocumento: reg.numero_documento, error: err.message });
        fallidos++;
      }
    }

    return res.json({
      ok: true,
      total: registros.length,
      exitosos,
      fallidos,
      restantes: pendientes.rowCount - exitosos - fallidos,
      errores
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};
