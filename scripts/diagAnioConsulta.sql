-- ============================================================
-- ¿Se está guardando el año de consulta (anio_consulta)?
-- ------------------------------------------------------------
-- SOLO LECTURA. No modifica nada.
-- Contra: 84.247.165.214:5432 / Automatizacion-RUNT-PRO
--
-- Qué esperar:
--   • Si TODAS las filas API tienen anio_consulta = NULL  -> el backend que
--     recibe a CONTRAVENCIONES no está corriendo el código que lee el año.
--   • Si alguna fila API tiene anio_consulta con valor    -> la escritura
--     funciona; el problema es del lado del servicio externo (no lo envía
--     en la forma que esperamos).
--   • Si filas de otros orígenes (SCRAPING, CARGADO_POR_EXCEL) sí tienen año
--     y las API no -> la columna está bien, falla solo la API.
-- ============================================================

-- 0) ¿Existe la columna y de qué tipo es?
SELECT column_name,
       data_type,
       character_maximum_length,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_name = 'persona_natural_propietario'
  AND column_name IN ('anio_consulta', 'origen_registro', 'tipo_documento', 'direccion_consultada')
ORDER BY column_name;

-- 1) Distribución POR AÑO de las solicitudes API (lo que muestra el panel).
--    anio = 0 significa que anio_consulta es NULL ("Sin año" en pantalla).
SELECT COALESCE(p.anio_consulta, 0)::int                        AS anio,
       COUNT(*)                                                 AS filas,
       COUNT(DISTINCT p.numero_documento)                       AS documentos,
       COUNT(*) FILTER (WHERE p.direccion_consultada = FALSE)   AS pendientes,
       COUNT(*) FILTER (WHERE p.direccion_consultada = TRUE)    AS ya_consultadas,
       MIN(p.fecha_actualizacion)                               AS primera,
       MAX(p.fecha_actualizacion)                               AS ultima
FROM persona_natural_propietario p
WHERE p.origen_registro LIKE 'API_%'
GROUP BY 1
ORDER BY 1 DESC;

-- 2) Mismo corte por ORIGEN, para ver qué servicios sí llegan con año.
SELECT p.origen_registro                                          AS origen,
       COALESCE(p.anio_consulta, 0)::int                          AS anio,
       COUNT(DISTINCT p.numero_documento)                         AS documentos,
       COUNT(*) FILTER (WHERE p.anio_consulta IS NULL)            AS sin_anio,
       COUNT(*) FILTER (WHERE p.anio_consulta IS NOT NULL)        AS con_anio
FROM persona_natural_propietario p
WHERE p.origen_registro LIKE 'API_%'
GROUP BY 1, 2
ORDER BY 1, 2 DESC;

-- 3) ¿La columna funciona en general? Otros orígenes con año cargado.
--    Si aquí HAY años y en (1)/(2) no hay ninguno, la falla es de la API.
SELECT COALESCE(p.anio_consulta, 0)::int AS anio,
       p.origen_registro                  AS origen,
       COUNT(*)                           AS filas
FROM persona_natural_propietario p
WHERE p.anio_consulta IS NOT NULL
GROUP BY 1, 2
ORDER BY 2, 1 DESC;

-- 4) Últimas 15 filas API: se ve de un vistazo qué llegó y cuándo se escribieron.
SELECT p.id_per_natural_dir,
       p.tipo_documento,
       p.numero_documento,
       p.anio_consulta,
       p.origen_registro,
       p.direccion_consultada,
       p.fecha_creacion,
       p.fecha_actualizacion
FROM persona_natural_propietario p
WHERE p.origen_registro LIKE 'API_%'
ORDER BY p.fecha_actualizacion DESC NULLS LAST
LIMIT 15;

-- 5) Cuántas filas API sin año se arreglaría con el backfill.
SELECT COUNT(*)                                                  AS filas_sin_anio,
       COUNT(DISTINCT p.numero_documento)                        AS documentos_sin_anio,
       COUNT(*) FILTER (WHERE p.direccion_consultada = FALSE)    AS pendientes_de_scrapear,
       COUNT(*) FILTER (WHERE p.direccion_consultada = TRUE)     AS ya_consultadas
FROM persona_natural_propietario p
WHERE p.origen_registro LIKE 'API_%'
  AND p.anio_consulta IS NULL;

-- 6) Documentos con año duplicado en distintos años (posible lote repetido
--    desde el servicio externo con años distintos).
SELECT p.numero_documento,
       array_agg(DISTINCT p.anio_consulta ORDER BY p.anio_consulta) AS anios,
       array_agg(DISTINCT p.origen_registro)                        AS origenes,
       COUNT(*)                                                     AS filas
FROM persona_natural_propietario p
WHERE p.origen_registro LIKE 'API_%'
  AND p.anio_consulta IS NOT NULL
GROUP BY p.numero_documento
HAVING COUNT(DISTINCT p.anio_consulta) > 1
ORDER BY 4 DESC, 1;

-- 7) Basura evidente: documentos que no son cédulas reales
--    (aparecen en la lista de la captura: "0", "123456789", ...).
SELECT p.numero_documento,
       p.anio_consulta,
       p.origen_registro,
       p.fecha_creacion
FROM persona_natural_propietario p
WHERE p.origen_registro LIKE 'API_%'
  AND (p.numero_documento !~ '^[0-9]{6,10}$'
       OR LENGTH(TRIM(p.numero_documento)) < 6)
ORDER BY p.fecha_creacion DESC;
