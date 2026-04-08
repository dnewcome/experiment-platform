import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import flagRoutes from './routes/flags.js';
import evaluateRoute from './routes/evaluate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });

await app.register(staticPlugin, {
  root: join(__dirname, 'public'),
  prefix: '/',
  maxAge: 0,
  etag: false,
});

await app.register(flagRoutes,    { prefix: '/api' });
await app.register(evaluateRoute, { prefix: '/api' });

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
