// Keep one fixture and registration order for the shared integration database.
const suite = require('./helpers/ai-settings.cjs')();
require('./ai-settings-management.cjs')(suite);
require('./ai-settings-application.cjs')(suite);
require('./ai-settings-publishing.cjs')(suite);
require('./ai-settings-drafts.cjs')(suite);
