import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          secure: false,
        },
      },
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'prompt',
        strategies: 'injectManifest',
        srcDir: '.',
        filename: 'sw.ts',
        injectRegister: false,
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'pwa-*.png'],
        manifest: {
          name: 'Tech Trolley — Asset Manager',
          short_name: 'Tech Trolley',
          description: 'Professional AV & IT asset management for conferences and events',
          theme_color: '#00AEEF',
          background_color: '#020617',
          display: 'standalone',
          orientation: 'portrait-primary',
          scope: '/',
          start_url: '/',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        },
        injectManifest: { globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,ttf}'] },
        devOptions: {
          enabled: false, // Development must not install a persistent worker by default.
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
