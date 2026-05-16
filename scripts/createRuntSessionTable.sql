-- =====================================================
-- Tabla para almacenar sesión RUNT en base de datos
-- Esto permite que workers locales y servidor compartan la misma sesión
-- =====================================================

-- Crear tabla de sesión RUNT
CREATE TABLE IF NOT EXISTS runt_sesion (
    id SERIAL PRIMARY KEY,
    session_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insertar fila inicial si no existe (para que siempre haya una sesión)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM runt_sesion) THEN
        INSERT INTO runt_sesion (session_started_at) 
        VALUES (NULL);
    END IF;
END $$;

-- Verificar que se creó correctamente
SELECT * FROM runt_sesion ORDER BY id DESC LIMIT 1;