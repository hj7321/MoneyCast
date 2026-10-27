const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Expo detects workspace packages; shared font assets live beside those packages.
config.watchFolders = [...new Set([...config.watchFolders, path.resolve(__dirname, '../../assets')])];

// Shared sources use Node ESM .js specifiers; Metro resolves their TypeScript files.
const coreSourceDirectory = path.resolve(__dirname, '../../packages/core/src') + path.sep;
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const request = context.originModulePath.startsWith(coreSourceDirectory)
    && moduleName.startsWith('.') && moduleName.endsWith('.js')
    ? moduleName.slice(0, -3) : moduleName;
  return defaultResolveRequest
    ? defaultResolveRequest(context, request, platform)
    : context.resolveRequest(context, request, platform);
};

module.exports = config;
