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