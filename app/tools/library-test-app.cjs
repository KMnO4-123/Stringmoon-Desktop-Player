// Run the production app with test-owned library/artwork preferences and Chromium storage.
const { app } = require('electron')
const path = require('node:path')
app.setPath('userData', path.join(__dirname, '../.smoke/library/profile'))
app.getAppPath = () => path.join(__dirname, '..')
require('../out/main/index.js')
