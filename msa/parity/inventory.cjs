const { readFileSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { createHash } = require('node:crypto');

const owners = {
  'ai-settings': 'operations', audit: 'operations', auth: 'operations', faqs: 'operations',
  health: 'operations', observability: 'order', customers: 'customer', members: 'customer',
  organizations: 'customer', pins: 'customer', orders: 'order', payments: 'order',
  consultations: 'consultation', 'call-insights': 'consultation', dashboard: 'consultation',
  'unanswered-questions': 'consultation', webhooks: 'consultation',
};

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

function inventory(root = join(__dirname, '../..')) {
  const source = files(join(root, 'backend/src'));
  const routes = source.filter(path => path.endsWith('.controller.ts')).flatMap(path => {
    const text = readFileSync(path, 'utf8');
    const controller = /@Controller\((?:'([^']*)')?\)/.exec(text);
    if (!controller) throw new Error(`Unsupported controller: ${path}`);
    const file = relative(root, path).replaceAll('\\', '/');
    const service = owners[file.split('/')[2]];
    if (!service) throw new Error(`Missing service owner: ${file}`);
    return [...text.matchAll(/@(Get|Post|Patch|Put|Delete|Sse)\((?:'([^']*)')?\)/g)].map(match => {
      let route = [controller[1], match[2]].filter(Boolean).join('/');
      if (!['health', 'internal/metrics', 'webhooks/pbx/call-ended'].some(p => route === p || (p === 'health' && route === 'health/ready')))
        route = `api/${route}`;
      const method = match[1] === 'Sse' ? 'GET' : match[1].toUpperCase();
      // The /api/calls ingress owns intake reads and completion coordination.
      const owner = ['api/calls/:id/order-intake','api/calls/:id/order-intake/complete'].includes(route) ? 'consultation'
        : ['api/customers/:id/card','api/companies/:id/group-card','api/customers/cards','api/companies/group-cards'].includes(route) ? 'customer' : service;
      return { method, path: `/${route}`, service: owner, stream: match[1] === 'Sse', file };
    });
  });
  const migrations = files(join(root, 'backend/migrations')).filter(path => path.endsWith('.sql'))
    .map(path => ({ file: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex') }));
  return { routes, migrations,
    workers: source.filter(path => path.endsWith('.worker.ts') || path.endsWith('/active-call-count.service.ts') || path.endsWith('\\active-call-count.service.ts'))
      .map(path => relative(root, path).replaceAll('\\', '/')) };
}

function adminRoles(rootModule) {
  const routes = {}, visited = new Set();
  function visit(entry) {
    const module = entry?.module ?? entry;
    if (!module || visited.has(module)) return;
    visited.add(module);
    for (const child of Reflect.getMetadata('imports', module) ?? []) visit(child);
    for (const controller of Reflect.getMetadata('controllers', module) ?? []) {
      const prefix = Reflect.getMetadata('path', controller);
      if (Reflect.getMetadata('auth:public', controller) || ['health', 'webhooks/pbx'].includes(prefix) ||
        prefix?.startsWith('internal')) continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        const method = Reflect.getMetadata('method', handler);
        if (method === undefined || Reflect.getMetadata('auth:public', handler) ||
          Reflect.getMetadata('auth:ai-business', handler)) continue;
        if (Reflect.getMetadata('auth:mvp-ai-order-intake', handler) &&
          !Reflect.getMetadata('ai-settings:admin-read', handler)) continue;
        const path = '/api/' + [prefix, Reflect.getMetadata('path', handler)].filter(v => v && v !== '/').join('/');
        routes[`${{0:'GET',1:'POST',2:'PUT',3:'DELETE',4:'PATCH'}[method]} ${path}`] =
          Reflect.getMetadata('auth:roles', handler) ?? Reflect.getMetadata('auth:roles', controller) ??
          ['OPERATOR', 'SYSTEM_ADMIN'];
      }
    }
  }
  visit(rootModule);
  return routes;
}

module.exports = { inventory, adminRoles };
if (require.main === module) process.stdout.write(JSON.stringify(inventory(process.argv[2]), null, 2) + '\n');
