exports.permitirModulo = (modulo) => {
  return (req, res, next) => {

    if (req.user.rol === 'administrador') {
      return next();
    }

    const permitido = req.user.modulos.includes(modulo);

    if (!permitido) {
      return res.status(403).json({
        ok: false,
        error: 'No tienes permisos'
      });
    }

    next();
  };
};