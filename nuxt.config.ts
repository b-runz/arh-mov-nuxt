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
    tmdbApiKey: process.env.TMDB_READ_TOKEN
  }
})