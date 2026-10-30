const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DEFAULT_N8N_VERSION = '2.12.3';
const QUALIFIED_N8N_NODE_MAJORS = Object.freeze({
  '2.12.3': 22,
  '2.44.6': 24,
});
const CONSUMER_PACKAGES = Object.freeze({
  n8nNodesBase: 'n8n-nodes-base',
  n8nLangchain: '@n8n/n8n-nodes-langchain',
});
const WORKFLOW_PACKAGE = 'n8n-workflow';

function expectedN8nVersion(env = process.env) {
  const expected = Object.hasOwn(env, 'ENGRAM_EXPECTED_N8N_VERSION')
    ? env.ENGRAM_EXPECTED_N8N_VERSION
    : DEFAULT_N8N_VERSION;
  if (typeof expected !== 'string' || !Object.hasOwn(QUALIFIED_N8N_NODE_MAJORS, expected)) {
    throw new Error('ENGRAM_EXPECTED_N8N_VERSION must be 2.12.3 or 2.44.6');
  }
  return expected;
}

function nodeMajor(version) {
  if (typeof version !== 'string') throw new Error('Node runtime version is unavailable');
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error('Node runtime version is invalid');
  return Number(match[1]);
}

function assertQualifiedRuntime(expected, actual, actualNode) {
  const requiredMajor = QUALIFIED_N8N_NODE_MAJORS[expected];
  if (requiredMajor === undefined) {
    throw new Error('ENGRAM_EXPECTED_N8N_VERSION must be 2.12.3 or 2.44.6');
  }
  if (actual !== expected) {
    throw new Error(`Expected n8n ${expected}; installed runtime is ${String(actual)}`);
  }
  if (nodeMajor(actualNode) !== requiredMajor) {
    throw new Error(`n8n ${expected} qualification requires Node ${requiredMajor}`);
  }
}

function readPackageManifest(packageJsonPath, expectedName) {
  let packageData;
  try {
    packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    throw new Error(`Required n8n runtime component is unavailable: ${expectedName}`);
  }
  if (
    !packageData ||
    packageData.name !== expectedName ||
    typeof packageData.version !== 'string'
  ) {
    throw new Error(`Required n8n runtime component has invalid metadata: ${expectedName}`);
  }
  return { packageJsonPath, version: packageData.version };
}

function findPackageManifest(entryPath, packageName) {
  let directory = path.dirname(fs.realpathSync(entryPath));
  while (true) {
    const packageJsonPath = path.join(directory, 'package.json');
    let packageData;
    try {
      packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch {
      packageData = undefined;
    }
    if (packageData?.name === packageName) {
      if (typeof packageData.version !== 'string') {
        throw new Error(`Required n8n runtime component has invalid metadata: ${packageName}`);
      }
      return { packageJsonPath, version: packageData.version };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Required n8n runtime component is unavailable: ${packageName}`);
}

function resolvePackageFrom(anchorPath, packageName) {
  const requireFromAnchor = createRequire(anchorPath);
  let packageJsonPath;
  let entryPath;
  try {
    packageJsonPath = requireFromAnchor.resolve(`${packageName}/package.json`);
  } catch {
    // Some packages do not export package.json. In that case, resolve their
    // normal consumer entry and walk up to the owning manifest below.
  }
  if (packageJsonPath) {
    return {
      ...readPackageManifest(packageJsonPath, packageName),
      anchorPath: packageJsonPath,
    };
  }

  try {
    entryPath = requireFromAnchor.resolve(packageName);
  } catch {
    throw new Error(`Required n8n runtime component is unavailable: ${packageName}`);
  }
  const manifest = findPackageManifest(entryPath, packageName);
  return { ...manifest, anchorPath: manifest.packageJsonPath };
}

function sha256File(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath);
  } catch {
    throw new Error('ENGRAM_TEST_PACKAGE must point to the tested package tarball');
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error('ENGRAM_TEST_PACKAGE must point to the tested package tarball');
  }
  return createHash('sha256').update(contents).digest('hex');
}

function getNativeRuntimeIdentity(options = {}) {
  const env = options.env ?? process.env;
  const runtimeRoot = options.runtimeRoot ?? env.ENGRAM_N8N_RUNTIME;
  const packagePath = options.packagePath ?? env.ENGRAM_TEST_PACKAGE;
  if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) {
    throw new Error('Explicit n8n runtime required');
  }
  if (typeof packagePath !== 'string' || packagePath.length === 0) {
    throw new Error('Explicit tested package required');
  }

  const absoluteRuntimeRoot = path.resolve(runtimeRoot);
  const n8nPackageJsonPath = path.join(absoluteRuntimeRoot, 'node_modules', 'n8n', 'package.json');
  const expected = expectedN8nVersion(env);
  const n8n = readPackageManifest(n8nPackageJsonPath, 'n8n').version;
  assertQualifiedRuntime(expected, n8n, process.version);
  const resolvedConsumers = {};
  for (const [key, packageName] of Object.entries(CONSUMER_PACKAGES)) {
    resolvedConsumers[key] = resolvePackageFrom(n8nPackageJsonPath, packageName);
  }
  const n8nWorkflow = resolvePackageFrom(n8nPackageJsonPath, WORKFLOW_PACKAGE);
  const baseWorkflow = resolvePackageFrom(
    resolvedConsumers.n8nNodesBase.anchorPath,
    WORKFLOW_PACKAGE,
  );
  const langchainWorkflow = resolvePackageFrom(
    resolvedConsumers.n8nLangchain.anchorPath,
    WORKFLOW_PACKAGE,
  );

  return Object.freeze({
    actualNode: process.version,
    actualNodeExecutable: process.execPath,
    n8n,
    componentVersions: Object.freeze({
      n8nNodesBase: resolvedConsumers.n8nNodesBase.version,
      n8nLangchain: resolvedConsumers.n8nLangchain.version,
      n8nWorkflow: Object.freeze({
        n8n: n8nWorkflow.version,
        n8nNodesBase: baseWorkflow.version,
        n8nLangchain: langchainWorkflow.version,
      }),
    }),
    engramTestPackageSha256: sha256File(path.resolve(packagePath)),
  });
}

module.exports = {
  DEFAULT_N8N_VERSION,
  assertQualifiedRuntime,
  expectedN8nVersion,
  getNativeRuntimeIdentity,
  sha256File,
};
