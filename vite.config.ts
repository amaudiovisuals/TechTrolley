import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
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
        registerType: 'autoUpdate',
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
        workbox: {
          // Cache all assets and API calls
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallbackDenylist: [/^\/admin/, /^\/api/],
          runtimeCaching: [
            {
              // Cache API calls to the Django backend
              urlPattern: /^https?:\/\/.*\/api\//,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'api-cache',
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 60 * 60 * 24, // 24 hours
                },
                networkTimeoutSeconds: 10,
              }
            },
            {
              // Cache FontAwesome icons
              urlPattern: /cdnjs\.cloudflare\.com\/.*\.css/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'cdn-css-cache',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
              }
            },
            {
              // Cache FontAwesome fonts/webfonts
              urlPattern: /cdnjs\.cloudflare\.com\/.*\.(woff2?|ttf|eot)/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'cdn-fonts-cache',
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              }
            }
          ]
        },
        devOptions: {
          enabled: true, // Enable PWA in dev mode for testing
        }
      })
    ],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
