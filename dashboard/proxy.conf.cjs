module.exports = {
  '/api/**': {
    target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8001',
    changeOrigin: true,
  },
};
