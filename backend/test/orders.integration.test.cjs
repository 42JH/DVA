// Keep one fixture and registration order for the shared integration database.
const suite = require('./helpers/orders.cjs')();
require('./orders-creation.cjs')(suite);
require('./orders-reads.cjs')(suite);
require('./orders-updates.cjs')(suite);
require('./orders-submission.cjs')(suite);
require('./orders-payment.cjs')(suite);
require('./orders-concurrency.cjs')(suite);
require('./orders-call-context.cjs')(suite);
require('./orders-admin.cjs')(suite);
