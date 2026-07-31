-- Tabla para el catálogo de impresoras registradas
-- La impresora activa se mantiene en config_impresora.printer_name
CREATE TABLE IF NOT EXISTS impresoras (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);
