-- Tabla para historial de liquidaciones (módulo historial unificado)
CREATE TABLE IF NOT EXISTS historial_liquidaciones (
    id SERIAL PRIMARY KEY,
    placa VARCHAR(20) NOT NULL,
    tramites TEXT,
    total_tramites INTEGER DEFAULT 0,
    exitosa BOOLEAN DEFAULT true,
    error TEXT,
    fecha_consulta TIMESTAMP DEFAULT NOW()
);

-- Verificar que la tabla se creó
SELECT EXISTS (
    SELECT FROM information_schema.tables 
    WHERE table_name = 'historial_liquidaciones'
) as existe;
