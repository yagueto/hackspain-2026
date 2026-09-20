// La clave de operador se inyecta aquí, en el proceso del proxy, para que no entre nunca al
// navegador ni haya que teclearla. Solo vale en desarrollo: el proxy escucha en 127.0.0.1, así
// que cualquiera con acceso a esta máquina puede despachar. En producción hace falta una
// sesión de verdad delante de la API.
const key = process.env.API_KEY || process.env.OPERATOR_API_KEY || '';

module.exports = {
  '/api/**': {
    target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8001',
    changeOrigin: true,
    ...(key ? { headers: { 'X-API-Key': key } } : {}),
  },
};
