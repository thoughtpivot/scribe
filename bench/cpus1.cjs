// Bench harness only: make node:cluster fork exactly one worker (os.cpus().length === 1)
const os = require('os'); const one = os.cpus()[0]; os.cpus = () => [one];
