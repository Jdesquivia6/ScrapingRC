-- ============================================================
-- Año de consulta en persona_natural_propietario
-- ------------------------------------------------------------
-- Los servicios externos envían el año de los comparendos que
-- motivan la solicitud. Hoy ese dato se descartaba.
--
-- Se persiste para poder agrupar/filtrar las solicitudes API por
-- año en la pantalla de Ubicabilidad Personas.
--
-- IMPORTANTE: es SOLO un organizador. El formulario de RUNT para
-- consultar direcciones no tiene filtro de año, así que el
-- scraping sigue siendo persona por persona.
--
-- Ejecutar con:
--   psql -h 84.247.165.214 -U postgres -d Automatizacion-RUNT-PRO \
--        -f scripts/addAnioConsulta.sql
-- ============================================================

BEGIN;

ALTER TABLE persona_natural_propietario
  ADD COLUMN IF NOT EXISTS anio_consulta SMALLINT NULL;

COMMENT ON COLUMN persona_natural_propietario.anio_consulta IS
  'Año de los comparendos que motivaron la solicitud (viene del JSON de integración). Solo organizador: RUNT no filtra por año.';

-- Índice parcial: solo cubre lo que de verdad se consulta en la pantalla
-- de pendientes (sin consultar y con origen API).
CREATE INDEX IF NOT EXISTS idx_pnp_pendientes_api
  ON persona_natural_propietario (origen_registro, anio_consulta, tipo_documento)
  WHERE direccion_consultada = FALSE
    AND origen_registro LIKE 'API_%';

COMMIT;

-- ---------- Verificación opcional ----------
-- Debe devolver la columna anio_consulta.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'persona_natural_propietario'
  AND column_name = 'anio_consulta';
