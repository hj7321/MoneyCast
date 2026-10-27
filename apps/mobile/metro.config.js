const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo detects workspace packages; shared font assets live beside those packages.
config.watchFolders = [...new Set([...config.watchFolders, path.resolve(__dirname, '../../assets')])];

module.exports = config;
