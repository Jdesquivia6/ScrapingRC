module.exports = {
  API_HIKVISION: process.env.API_HIKVISION || '10.10.20.108',
  // API de ENRIQUECIMIENTO DE PERSONAS de CONTRAVENCIONES (ubicabilidad).
  // OJO: NO es el enriquecer de FOTOMULTAS (API_HIKVISION:5051), es otro servicio.
  // La URL base NO incluye el sufijo; el cliente agrega '/batch' cuando aplica.
  CONTRAVENCIONES_ENRIQUECER_URL:
    process.env.CONTRAVENCIONES_ENRIQUECER_URL ||
    'http://contravenciones.civitrans.com.co:4200/v1/rest/api/personas/enriquecer',
  CONTRAVENCIONES_ENRIQUECER_API_KEY:
    process.env.CONTRAVENCIONES_ENRIQUECER_API_KEY || process.env.API_KEY || ''
};
