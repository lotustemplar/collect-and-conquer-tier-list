import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error The cache helper is intentionally Node-only and is not part of the browser bundle.
import { resolveAndCache } from './scripts/card-cache.mjs'

function localCardApi(): Plugin {
  return {
    name: 'local-card-cache-api',
    configureServer(server) {
      server.middlewares.use('/api/cards/resolve', async (req, res, next) => {
        if (req.method !== 'POST') return next()
        const chunks: Buffer[] = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.once('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const names = Array.isArray(body.names) ? body.names.filter((name: unknown): name is string => typeof name === 'string') : []
            const result = await resolveAndCache(names)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(result))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localCardApi()],
  base: './',
})
