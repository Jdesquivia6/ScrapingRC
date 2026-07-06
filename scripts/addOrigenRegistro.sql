-- Agregar columna origen_registro a persona_natural_propietario
-- Valores: SCRAPING (flujo normal), CARGADO_POR_EXCEL (carga desde Excel)
ALTER TABLE persona_natural_propietario
ADD COLUMN IF NOT EXISTS origen_registro VARCHAR(50) DEFAULT 'SCRAPING';

-- Agregar origen_registro a worker_job_items para trazabilidad
ALTER TABLE worker_job_items
ADD COLUMN IF NOT EXISTS origen_registro VARCHAR(50) DEFAULT NULL;
