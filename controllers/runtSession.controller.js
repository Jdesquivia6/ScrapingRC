const {
  iniciarSesionRunt,
  reiniciarSesionRunt,
  obtenerEstadoSesionRunt
} = require('../utils/runtSession');

exports.iniciarSesion = (req, res) => {
  iniciarSesionRunt();

  return res.json({
    ok: true,
    message: 'Sesión RUNT registrada correctamente',
    session: obtenerEstadoSesionRunt()
  });
};

exports.reiniciarSesion = (req, res) => {
  reiniciarSesionRunt();

  return res.json({
    ok: true,
    message: 'Sesión RUNT reiniciada correctamente',
    session: obtenerEstadoSesionRunt()
  });
};

exports.estadoSesion = (req, res) => {
  return res.json({
    ok: true,
    session: obtenerEstadoSesionRunt()
  });
};