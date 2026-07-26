import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  // nuxt
  modules: ['shadcn-nuxt', '@vueuse/nuxt'],
  nitro: {
    preset: "bun",
  },

  // types
  typescript: {
     tsConfig: {
       compilerOptions: {
         types: ["@types/w3c-web-hid"],
       },
     },
  },

  // styles
  css: ['~/assets/css/tailwind.css'],
  vite: {
    plugins: [
      tailwindcss(),
    ],
  },
  shadcn: {
    prefix: "",
    componentDir: "~~/layers/ui-kit/app/components/base",
  },
})
