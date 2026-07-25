const {
  iniciarSesionRunt,
  reiniciarSesionRunt,
  obtenerEstadoSesionRunt
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
<html>
<head><meta charset="utf-8"><title>Registrando sesión RUNT...</title></head>
<body style="background:#059669;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;flex-direction:column">
  <p style="font-size:1.2rem;margin-bottom:.5rem">✅ Sesión RUNT registrada</p>
  <p style="font-size:.9rem;opacity:.8">${session.minutosRestantes} minutos restantes</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'runt-session-iniciada', payload: ${payload} }, '*');
    }
    setTimeout(() => window.close(), 2000);
  <\/script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send('Error al iniciar sesión RUNT');
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
