const { scrapeVehiculo } = require('../scraping/vehiculoScraper');
const pool = require('../utils/db');
const { obtenerEstadoSesionRunt } = require('../utils/runtSession');

exports.procesarPlacasBatch = async (req, res) => {
  try {
    const { placas } = req.body;

    if (!placas || !Array.isArray(placas) || placas.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Debe enviar un array de placas'
      });
    }

    const session = obtenerEstadoSesionRunt();

    if (!session.puedeConsultar) {
      return res.status(409).json({
        ok: false,
        error: session.activa
          ? `No es recomendable iniciar el lote. Solo quedan ${session.minutosRestantes} minutos de sesión RUNT.`
          : 'La sesión RUNT está vencida. Debe iniciar sesión nuevamente.',
        session
      });
    }

    if (placas.length > session.capacidadSegura) {
      return res.status(409).json({
        ok: false,
        error: `El lote es muy grande para el tiempo restante. Puede consultar máximo ${session.capacidadSegura} placa(s) en esta sesión.`,
        session,
        capacidadSegura: session.capacidadSegura
      });
    }

    const results = [];
    let detenidoPorSesion = false;

    for (const placa of placas) {
      const sessionActual = obtenerEstadoSesionRunt();

      if (!sessionActual.puedeConsultar) {
        results.push({
          placa,
          ok: false,
          sessionExpired: true,
          error: 'Proceso detenido por tiempo de sesión insuficiente'
        });

        detenidoPorSesion = true;
        break;
      }

      try {
        const placaNormalizada = String(placa || '').trim().toUpperCase();

        const consulta = await pool.query(`
          SELECT *
          FROM consultas_placas
          WHERE placa = $1
        `, [placaNormalizada]);

        if (consulta.rows.length === 0) {
          results.push({
            placa: placaNormalizada,
            ok: false,
            error: 'No existe en consultas_placas'
          });
          continue;
        }

        const row = consulta.rows[0];

        const result = await scrapeVehiculo({
          placa: placaNormalizada,
          id_consul_placa: row.id_consul_placa
        });

        results.push(result);

        if (result.sessionExpired) {
          detenidoPorSesion = true;
          break;
        }

      } catch (err) {
        results.push({
          placa,
          ok: false,
          error: err.message
        });
      }
    }

    return res.json({
      ok: true,
      detenidoPorSesion,
      total: placas.length,
      procesadas: results.length,
      exitosas: results.filter(r => r.ok).length,
      fallidas: results.filter(r => !r.ok).length,
      session: obtenerEstadoSesionRunt(),
      results
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};