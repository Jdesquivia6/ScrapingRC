-- Agregar columnas de control de envío externo a persona_natural_propietario
-- Estas columnas permiten saber si el registro fue enviado al microservicio de enriquecimiento

ALTER TABLE persona_natural_propietario
ADD COLUMN IF NOT EXISTS enviado_externo BOOLEAN DEFAULT FALSE;

ALTER TABLE persona_natural_propietario
ADD COLUMN IF NOT EXISTS fecha_envio_externo TIMESTAMP NULL;

ALTER TABLE persona_natural_propietario
ADD COLUMN IF NOT EXISTS intentos_envio_externo INT DEFAULT 0;

ALTER TABLE persona_natural_propietario
ADD COLUMN IF NOT EXISTS error_envio_externo TEXT NULL;

-- Comentario para referencia
COMMENT ON COLUMN persona_natural_propietario.enviado_externo IS 'TRUE si el registro fue enviado exitosamente al microservicio externo';
COMMENT ON COLUMN persona_natural_propietario.fecha_envio_externo IS 'Fecha y hora del último envío exitoso al microservicio externo';
COMMENT ON COLUMN persona_natural_propietario.intentos_envio_externo IS 'Cantidad de intentos de envío al microservicio externo (máximo 3)';
COMMENT ON COLUMN persona_natural_propietario.error_envio_externo IS 'Último mensaje de error del envío al microservicio externo';
