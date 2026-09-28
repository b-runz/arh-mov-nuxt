export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },
  modules: [
    '@nuxtjs/tailwindcss'
  ],
  css: ['~/assets/css/main.css'],
  app: {
  },
  ssr: true,
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ['/']
    }
  },
  experimental: {
    payloadExtraction: false
  },
  runtimeConfig: {
    tmdbApiKey: process.env.TMDB_READ_TOKEN,
    public: {
      // The Jev proxy (see azure-functions/jev-proxy) is a separate
      // deployable, so its URL is a browser-visible public config rather
      // than a secret -- the key it holds never reaches this app.
      jevProxyUrl: process.env.NUXT_PUBLIC_JEV_PROXY_URL || 'http://localhost:7071/api/jevRecommend'
    }
  }
})