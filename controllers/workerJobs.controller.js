const pool = require('../utils/db');
const { obtenerEstadoSesionRunt } = require('../utils/runtSession');

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
  'liquidacion'
]);

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

    await client.query('BEGIN');

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
      preparedItems.length
    ]);

    const job = jobInsert.rows[0];

    for (const payload of preparedItems) {
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

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      job
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
          AND (
            $2 = 'administrador'
            OR j.fk_usuario = $3
          )
        ORDER BY j.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE worker_jobs j
      SET estado = 'procesando',
          started_at = COALESCE(j.started_at, NOW()),
          worker_name = COALESCE($4, j.worker_name)
      FROM candidate c
      WHERE j.id_job = c.id_job
      RETURNING j.*
    `, [
      modulosValidos,
      req.user.rol,
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

    const estadoSesion = obtenerEstadoSesionRunt();
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
      ? JSON.stringify(resultado)
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
