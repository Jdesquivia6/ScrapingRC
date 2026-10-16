const pool = require('../utils/db');
const {
  iniciarSesionRunt,
  reiniciarSesionRunt,
  obtenerEstadoSesionRunt,
  simularMinutosRestantes,
  limpiarSesionTest
} = require('../utils/runtSession');

// Resetear jobs 'sesion_vencida' a 'pendiente' al renovar la sesion
// La sesion RUNT es por PC, no por usuario, por eso resetea todos los jobs de la PC
async function reanudarJobsSesionVencida() {
  try {
    const result = await pool.query(`
      UPDATE worker_jobs
      SET estado = 'pendiente',
          error = NULL
      WHERE estado = 'sesion_vencida'
        AND modulo IN ('ubicabilidad-personas', 'personas-direcciones')
      RETURNING id_job
    `);

    if (result.rowCount > 0) {
      console.log(`[runtSession] ${result.rowCount} jobs sesion_vencida reseteados a 'pendiente'`);
    }
    return result.rowCount;
  } catch (err) {
    console.error('[runtSession] Error al reanudar jobs sesion_vencida:', err.message);
    return 0;
  }
}

exports.iniciarSesion = async (req, res) => {
  await iniciarSesionRunt();
  const jobsReanudados = await reanudarJobsSesionVencida();
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    message: jobsReanudados > 0
      ? `Sesion RUNT registrada. ${jobsReanudados} trabajo(s) sesion_vencida reanudado(s).`
      : 'Sesión RUNT registrada correctamente',
    session,
    jobsReanudados
  });
};

exports.iniciarSesionPage = async (req, res) => {
  try {
    await iniciarSesionRunt();
    const jobsReanudados = await reanudarJobsSesionVencida();
    const session = await obtenerEstadoSesionRunt();

    const mensajeJobs = jobsReanudados > 0
      ? `<p style="font-size:.95rem;margin:1rem 0 .5rem;background:rgba(255,255,255,.15);padding:.5rem 1rem;border-radius:.5rem">🔄 ${jobsReanudados} trabajo(s) sesion_vencida reanudado(s) automaticamente</p>`
      : '';

    const payload = JSON.stringify({ ok: true, session, jobsReanudados });
    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Sesión RUNT renovada</title></head>
<body style="background:#059669;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;flex-direction:column;padding:24px;box-sizing:border-box">
  <div style="max-width:520px;text-align:center">
    <p style="font-size:2.5rem;margin:0 0 .5rem">✅</p>
    <p style="font-size:1.3rem;margin:0 0 .25rem;font-weight:700">Sesión RUNT renovada</p>
    <p style="font-size:1rem;margin:0 0 .5rem;opacity:.95">${session.minutosRestantes} minutos restantes</p>
    ${mensajeJobs}
    <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid rgba(255,255,255,.3);text-align:left">
      <p style="font-size:.85rem;margin:0 0 .5rem;font-weight:600;opacity:.95">Pasos realizados:</p>
      <p style="font-size:.8rem;margin:.25rem 0;opacity:.85">1. Sesion registrada en el sistema</p>
      <p style="font-size:.8rem;margin:.25rem 0;opacity:.85">2. ${jobsReanudados > 0 ? `${jobsReanudados} trabajo(s) en cola reactivado(s)` : 'Sin trabajos pendientes de reanudar'}</p>
      <p style="font-size:.8rem;margin:.25rem 0;opacity:.85">3. Listo para seguir consultando</p>
    </div>
    <p style="font-size:.8rem;margin:1rem 0 0;opacity:.7">Esta ventana se cerrara automaticamente en 4 segundos.</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'runt-session-iniciada', payload: ${payload} }, '*');
    }
    setTimeout(() => window.close(), 4000);
  <\/script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    const htmlError = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Error al renovar sesión RUNT</title></head>
<body style="background:#dc2626;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;flex-direction:column;padding:24px;box-sizing:border-box">
  <div style="max-width:440px;text-align:center">
    <p style="font-size:2rem;margin:0 0 .5rem">❌</p>
    <p style="font-size:1.25rem;margin:0 0 .5rem;font-weight:700">No se pudo renovar la sesión RUNT</p>
    <p style="font-size:.9rem;margin:0;opacity:.9">Intenta nuevamente o contacta al administrador.</p>
  </div>
</body>
</html>`;
    res.status(500).send(htmlError);
  }
};

exports.reiniciarSesion = async (req, res) => {
  await reiniciarSesionRunt();
  const jobsReanudados = await reanudarJobsSesionVencida();
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    message: jobsReanudados > 0
      ? `Sesion RUNT reiniciada. ${jobsReanudados} trabajo(s) sesion_vencida reanudado(s).`
      : 'Sesión RUNT reiniciada correctamente',
    session,
    jobsReanudados
  });
};

exports.estadoSesion = async (req, res) => {
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    session
  });
};

exports.simularTest = async (req, res) => {
  try {
    const { minutos, limpiar } = req.body || {};

    if (limpiar === true) {
      await limpiarSesionTest();
      const session = await obtenerEstadoSesionRunt();
      return res.json({
        ok: true,
        message: 'Sesion limpiada (TEST)',
        session
      });
    }

    const mins = Number(minutos);
    if (Number.isNaN(mins)) {
      return res.status(400).json({
        ok: false,
        error: 'minutos es obligatorio (numero entre 0 y 120) o limpiar: true'
      });
    }

    await simularMinutosRestantes(mins);
    const session = await obtenerEstadoSesionRunt();

    return res.json({
      ok: true,
      message: `Sesion simulada a ${mins} minutos restantes (TEST)`,
      session
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};
