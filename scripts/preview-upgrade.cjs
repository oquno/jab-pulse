// Compatibility alias: the main manifest now uses the installed app's ID.
const path = require('node:path')
const root = path.resolve(__dirname, '..')
process.chdir(root)
require('./preview.cjs')
