// Bench harness only: make node:cluster fork exactly four workers
const os = require('os'); const c = os.cpus().slice(0, 4); os.cpus = () => c;
