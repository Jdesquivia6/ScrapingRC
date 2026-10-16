-- Migración: ampliar columnas que se quedaron cortas frente a la API de integraciones.
--
-- Motivo del error visto en producción:
--   [integracion] error insertando lote:
--   el valor es demasiado largo para el tipo character varying(30)
--
-- Causa: el valor canónico de PPT ("Permiso por Protección Temporal") mide
-- 31 caracteres y la columna tipo_documento era varchar(30). Como el INSERT
-- de la API es multi-fila (unnest), UN solo registro PPT revertía el lote completo.
--
-- Nota: el índice único idx_persona_unique_tipo_num se reconstruye solo.
-- Con ~1900 filas el ALTER es prácticamente instantáneo (bloqueo mínimo).

BEGIN;

-- 1) tipo_documento: 30 -> 60. Alineado con la validación de la API (máx 60)
--    y con el valor canónico más largo actual, "Permiso por Protección Temporal" (31).
ALTER TABLE persona_natural_propietario
  ALTER COLUMN tipo_documento TYPE varchar(60);

-- 2) origen_registro: 50 -> 60. El origen de la API es 'API_' || codigo,
--    y api_client.codigo admite hasta 50 caracteres (54 en el peor caso).
ALTER TABLE persona_natural_propietario
  ALTER COLUMN origen_registro TYPE varchar(60);

COMMENT ON COLUMN persona_natural_propietario.tipo_documento  IS 'Homologado por utils/tipoDocumento.js. varchar(60) para admitir el canonico de PPT (31).';
COMMENT ON COLUMN persona_natural_propietario.origen_registro IS 'SCRAPING | CARGADO_POR_EXCEL | API_<CODIGO_CLIENTE>.';

COMMIT;

-- Verificación (opcional):
--   SELECT column_name, data_type, character_maximum_length
--   FROM information_schema.columns
--   WHERE table_name = 'persona_natural_propietario'
--     AND column_name IN ('tipo_documento', 'origen_registro');
--
--   SELECT MAX(length(tipo_documento)) AS max_tipo, MAX(length(origen_registro)) AS max_origen
--   FROM persona_natural_propietario;
