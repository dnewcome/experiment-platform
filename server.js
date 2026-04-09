import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import flagRoutes from './routes/flags.js';
import evaluateRoute from './routes/evaluate.js';
import metricsRoutes from './routes/metrics.js';
import analysisRoutes from './routes/analysis.js';
import simulationRoutes from './routes/simulation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });

await app.register(staticPlugin, {
  root: join(__dirname, 'public'),
  prefix: '/',
  maxAge: 0,
  etag: false,
});

// Optional API key auth. Set API_KEY env var to require a Bearer token on all
// /api requests. Leave unset for unauthenticated local development.
if (process.env.API_KEY) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${process.env.API_KEY}`) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}

await app.register(flagRoutes,    { prefix: '/api' });
await app.register(evaluateRoute, { prefix: '/api' });
await app.register(metricsRoutes, { prefix: '/api' });
await app.register(analysisRoutes,   { prefix: '/api' });
await app.register(simulationRoutes, { prefix: '/api' });

app.setNotFoundHandler((_req, reply) => {
  reply.sendFile('index.html');
});

try {
  await app.listen({ port: 3000, host: '0.0.0.0' });
  console.log('Experiment platform running at http://localhost:3000');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
