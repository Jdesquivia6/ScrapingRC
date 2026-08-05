const {
  iniciarSesionRunt,
  reiniciarSesionRunt,
  obtenerEstadoSesionRunt,
  simularMinutosRestantes,
  limpiarSesionTest
} = require('../utils/runtSession');

exports.iniciarSesion = async (req, res) => {
  await iniciarSesionRunt();
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    message: 'Sesión RUNT registrada correctamente',
    session
  });
};

exports.iniciarSesionPage = async (req, res) => {
  try {
    await iniciarSesionRunt();
    const session = await obtenerEstadoSesionRunt();

    const payload = JSON.stringify({ ok: true, session });
    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Sesión RUNT renovada</title></head>
<body style="background:#059669;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;flex-direction:column;padding:24px;box-sizing:border-box">
  <div style="max-width:440px;text-align:center">
    <p style="font-size:2rem;margin:0 0 .5rem">✅</p>
    <p style="font-size:1.25rem;margin:0 0 .5rem;font-weight:700">Sesión RUNT renovada</p>
    <p style="font-size:1rem;margin:0 0 1rem;opacity:.95">${session.minutosRestantes} minutos restantes</p>
    <p style="font-size:.85rem;margin:0;opacity:.85">Esta ventana se cerrará automáticamente.</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'runt-session-iniciada', payload: ${payload} }, '*');
    }
    setTimeout(() => window.close(), 2500);
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
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    message: 'Sesión RUNT reiniciada correctamente',
    session
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
