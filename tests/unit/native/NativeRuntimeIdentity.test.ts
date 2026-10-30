import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const runtimeIdentity = createRequire(__filename)('../../native/runtime.cjs') as {
  DEFAULT_N8N_VERSION: string;
  assertQualifiedRuntime(expected: string, actual: string, actualNode: string): void;
  expectedN8nVersion(env?: NodeJS.ProcessEnv): string;
  getNativeRuntimeIdentity(options?: {
    env?: NodeJS.ProcessEnv;
    runtimeRoot?: string;
    packagePath?: string;
  }): {
    actualNode: string;
    actualNodeExecutable: string;
    n8n: string;
    componentVersions: {
      n8nNodesBase: string;
      n8nLangchain: string;
      n8nWorkflow: {
        n8n: string;
        n8nNodesBase: string;
        n8nLangchain: string;
      };
    };
    engramTestPackageSha256: string;
  };
};

type RuntimeVersions = {
  n8nNodesBase?: string;
  n8nLangchain?: string;
  n8nWorkflow?: { n8n: string; n8nNodesBase: string; n8nLangchain: string };
};

function writePackage(
  root: string,
  relativeDirectory: string,
  name: string,
  version: string,
): string {
  const packageDirectory = path.join(root, ...relativeDirectory.split('/'));
  const entryRelative = path.join('dist', 'index.js');
  fs.mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, entryRelative), 'module.exports = {};');
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name,
      version,
      main: entryRelative,
      // Deliberately do not export ./package.json; the helper must find the
      // manifest by walking upward from Node's resolved package entry.
      exports: { '.': { require: `./${entryRelative.split(path.sep).join('/')}` } },
    }),
  );
  return packageDirectory;
}

function writeRuntime(
  root: string,
  n8nVersion: string,
  options: { rootVersions?: RuntimeVersions; nestedVersions?: RuntimeVersions } = {},
): void {
  const nestedVersions = options.nestedVersions ?? {};
  const n8nDirectory = writePackage(root, 'node_modules/n8n', 'n8n', n8nVersion);
  const baseDirectory = writePackage(
    root,
    'node_modules/n8n/node_modules/n8n-nodes-base',
    'n8n-nodes-base',
    nestedVersions.n8nNodesBase ?? 'fixture-base-nested-1.0.0',
  );
  const langchainDirectory = writePackage(
    root,
    'node_modules/n8n/node_modules/@n8n/n8n-nodes-langchain',
    '@n8n/n8n-nodes-langchain',
    nestedVersions.n8nLangchain ?? 'fixture-langchain-nested-1.0.0',
  );

  writePackage(
    root,
    'node_modules/n8n/node_modules/n8n-workflow',
    'n8n-workflow',
    nestedVersions.n8nWorkflow?.n8n ?? 'fixture-workflow-n8n-1.0.0',
  );
  writePackage(
    root,
    'node_modules/n8n/node_modules/n8n-nodes-base/node_modules/n8n-workflow',
    'n8n-workflow',
    nestedVersions.n8nWorkflow?.n8nNodesBase ?? 'fixture-workflow-base-1.0.0',
  );
  writePackage(
    root,
    'node_modules/n8n/node_modules/@n8n/n8n-nodes-langchain/node_modules/n8n-workflow',
    'n8n-workflow',
    nestedVersions.n8nWorkflow?.n8nLangchain ?? 'fixture-workflow-langchain-1.0.0',
  );

  if (options.rootVersions) {
    writePackage(
      root,
      'node_modules/n8n-nodes-base',
      'n8n-nodes-base',
      options.rootVersions.n8nNodesBase ?? 'fixture-base-root-1.0.0',
    );
    writePackage(
      root,
      'node_modules/@n8n/n8n-nodes-langchain',
      '@n8n/n8n-nodes-langchain',
      options.rootVersions.n8nLangchain ?? 'fixture-langchain-root-1.0.0',
    );
    writePackage(
      root,
      'node_modules/n8n-workflow',
      'n8n-workflow',
      options.rootVersions.n8nWorkflow?.n8n ?? 'fixture-workflow-root-1.0.0',
    );
  }

  expect(fs.existsSync(path.join(n8nDirectory, 'package.json'))).toBe(true);
  expect(fs.existsSync(path.join(baseDirectory, 'package.json'))).toBe(true);
  expect(fs.existsSync(path.join(langchainDirectory, 'package.json'))).toBe(true);
}

function withNodeIdentity<T>(version: string, executable: string, run: () => T): T {
  const versionDescriptor = Object.getOwnPropertyDescriptor(process, 'version');
  const executableDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
  Object.defineProperty(process, 'version', { ...versionDescriptor, value: version });
  Object.defineProperty(process, 'execPath', { ...executableDescriptor, value: executable });
  try {
    return run();
  } finally {
    if (versionDescriptor) Object.defineProperty(process, 'version', versionDescriptor);
    if (executableDescriptor) Object.defineProperty(process, 'execPath', executableDescriptor);
  }
}

describe('native runtime identity qualification', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-native-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  test('defaults only to the legacy n8n version and requires explicit opt-in for 2.44.6', () => {
    expect(runtimeIdentity.DEFAULT_N8N_VERSION).toBe('2.12.3');
    expect(runtimeIdentity.expectedN8nVersion({} as NodeJS.ProcessEnv)).toBe('2.12.3');
    expect(
      runtimeIdentity.expectedN8nVersion({
        ENGRAM_EXPECTED_N8N_VERSION: '2.44.6',
      } as NodeJS.ProcessEnv),
    ).toBe('2.44.6');
    expect(() =>
      runtimeIdentity.expectedN8nVersion({
        ENGRAM_EXPECTED_N8N_VERSION: '2.44.7',
      } as NodeJS.ProcessEnv),
    ).toThrow('ENGRAM_EXPECTED_N8N_VERSION must be 2.12.3 or 2.44.6');
    expect(() =>
      runtimeIdentity.expectedN8nVersion({ ENGRAM_EXPECTED_N8N_VERSION: '' } as NodeJS.ProcessEnv),
    ).toThrow('ENGRAM_EXPECTED_N8N_VERSION must be 2.12.3 or 2.44.6');
  });

  test.each([
    ['2.12.3', '2.12.3', 'v22.17.0'],
    ['2.44.6', '2.44.6', 'v24.19.0'],
  ])('accepts only the qualified runtime pair %s / %s / %s', (expected, actual, node) => {
    expect(() => runtimeIdentity.assertQualifiedRuntime(expected, actual, node)).not.toThrow();
  });

  test.each([
    ['2.12.3', '2.44.6', 'v22.17.0'],
    ['2.44.6', '2.44.6', 'v22.17.0'],
    ['2.12.3', '2.12.3', 'v24.19.0'],
  ])('rejects a mismatched or unqualified runtime pair %s / %s / %s', (expected, actual, node) => {
    expect(() => runtimeIdentity.assertQualifiedRuntime(expected, actual, node)).toThrow();
  });

  test('finds nested components without root copies and hashes the exact tested tarball bytes', () => {
    const runtimeRoot = path.join(temporaryDirectory, 'runtime');
    writeRuntime(runtimeRoot, '2.12.3');
    const packagePath = path.join(temporaryDirectory, 'n8n-nodes-engram-0.8.0.tgz');
    const packageBytes = Buffer.from([0, 1, 2, 13, 10, 255]);
    fs.writeFileSync(packagePath, packageBytes);

    const identity = withNodeIdentity('v22.17.0', '/qualified/node22/bin/node', () =>
      runtimeIdentity.getNativeRuntimeIdentity({
        runtimeRoot,
        packagePath,
        env: {},
      }),
    );

    expect(identity).toEqual({
      actualNode: 'v22.17.0',
      actualNodeExecutable: '/qualified/node22/bin/node',
      n8n: '2.12.3',
      componentVersions: {
        n8nNodesBase: 'fixture-base-nested-1.0.0',
        n8nLangchain: 'fixture-langchain-nested-1.0.0',
        n8nWorkflow: {
          n8n: 'fixture-workflow-n8n-1.0.0',
          n8nNodesBase: 'fixture-workflow-base-1.0.0',
          n8nLangchain: 'fixture-workflow-langchain-1.0.0',
        },
      },
      engramTestPackageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    });
  });

  test('resolves component versions from the installed n8n package, not conflicting root copies', () => {
    const runtimeRoot = path.join(temporaryDirectory, 'runtime');
    writeRuntime(runtimeRoot, '2.12.3', {
      rootVersions: {
        n8nNodesBase: 'root-base-9.9.9',
        n8nLangchain: 'root-langchain-9.9.9',
        n8nWorkflow: {
          n8n: 'root-workflow-n8n-9.9.9',
          n8nNodesBase: 'root-workflow-base-9.9.9',
          n8nLangchain: 'root-workflow-langchain-9.9.9',
        },
      },
      nestedVersions: {
        n8nNodesBase: 'selected-base-2.0.0',
        n8nLangchain: 'selected-langchain-2.0.0',
      },
    });
    const packagePath = path.join(temporaryDirectory, 'n8n-nodes-engram-0.8.0.tgz');
    fs.writeFileSync(packagePath, 'synthetic package bytes');

    const identity = withNodeIdentity('v22.17.0', '/qualified/node22/bin/node', () =>
      runtimeIdentity.getNativeRuntimeIdentity({ runtimeRoot, packagePath, env: {} }),
    );

    expect(identity.componentVersions.n8nNodesBase).toBe('selected-base-2.0.0');
    expect(identity.componentVersions.n8nLangchain).toBe('selected-langchain-2.0.0');
  });

  test('reports n8n-workflow versions resolved independently by each consumer package', () => {
    const runtimeRoot = path.join(temporaryDirectory, 'runtime');
    writeRuntime(runtimeRoot, '2.12.3', {
      nestedVersions: {
        n8nWorkflow: {
          n8n: 'workflow-n8n-2.0.0',
          n8nNodesBase: 'workflow-base-2.1.0',
          n8nLangchain: 'workflow-langchain-2.2.0',
        },
      },
    });
    const packagePath = path.join(temporaryDirectory, 'n8n-nodes-engram-0.8.0.tgz');
    fs.writeFileSync(packagePath, 'synthetic package bytes');

    const identity = withNodeIdentity('v22.17.0', '/qualified/node22/bin/node', () =>
      runtimeIdentity.getNativeRuntimeIdentity({ runtimeRoot, packagePath, env: {} }),
    );

    expect(identity.componentVersions.n8nWorkflow).toEqual({
      n8n: 'workflow-n8n-2.0.0',
      n8nNodesBase: 'workflow-base-2.1.0',
      n8nLangchain: 'workflow-langchain-2.2.0',
    });
  });

  test('uses an exported component manifest when its package entry is broken', () => {
    const runtimeRoot = path.join(temporaryDirectory, 'runtime');
    writeRuntime(runtimeRoot, '2.44.6');
    const langchainManifestPath = path.join(
      runtimeRoot,
      'node_modules/n8n/node_modules/@n8n/n8n-nodes-langchain/package.json',
    );
    const langchainManifest = JSON.parse(fs.readFileSync(langchainManifestPath, 'utf8')) as {
      main?: string;
      exports?: Record<string, unknown>;
    };
    langchainManifest.main = './missing-root-entry.js';
    langchainManifest.exports = {
      '.': {
        types: './missing-root-entry.d.ts',
        import: './missing-root-entry.js',
        require: './missing-root-entry.js',
      },
      './package.json': './package.json',
    };
    fs.writeFileSync(langchainManifestPath, JSON.stringify(langchainManifest));

    const packagePath = path.join(temporaryDirectory, 'n8n-nodes-engram-0.8.0.tgz');
    fs.writeFileSync(packagePath, 'synthetic package bytes');
    const identity = withNodeIdentity('v24.19.0', '/qualified/node24/bin/node', () =>
      runtimeIdentity.getNativeRuntimeIdentity({
        runtimeRoot,
        packagePath,
        env: { ENGRAM_EXPECTED_N8N_VERSION: '2.44.6' } as NodeJS.ProcessEnv,
      }),
    );

    expect(identity.componentVersions.n8nLangchain).toBe('fixture-langchain-nested-1.0.0');
    expect(identity.componentVersions.n8nWorkflow.n8nLangchain).toBe(
      'fixture-workflow-langchain-1.0.0',
    );
  });

  test('requires explicit 2.44.6 selection and enforces its Node 24 host', () => {
    const runtimeRoot = path.join(temporaryDirectory, 'runtime');
    writeRuntime(runtimeRoot, '2.44.6');
    const packagePath = path.join(temporaryDirectory, 'n8n-nodes-engram-0.8.0.tgz');
    fs.writeFileSync(packagePath, 'synthetic package bytes');
    const options = {
      runtimeRoot,
      packagePath,
      env: { ENGRAM_EXPECTED_N8N_VERSION: '2.44.6' } as NodeJS.ProcessEnv,
    };

    expect(() =>
      withNodeIdentity('v22.17.0', '/qualified/node22/bin/node', () =>
        runtimeIdentity.getNativeRuntimeIdentity(options),
      ),
    ).toThrow('n8n 2.44.6 qualification requires Node 24');

    const identity = withNodeIdentity('v24.19.0', '/qualified/node24/bin/node', () =>
      runtimeIdentity.getNativeRuntimeIdentity(options),
    );
    expect(identity.n8n).toBe('2.44.6');
    expect(identity.actualNode).toBe('v24.19.0');
  });

  test('fails closed when the installed runtime disagrees with the requested version', () => {
    const runtimeRoot = path.join(temporaryDirectory, 'runtime');
    writeRuntime(runtimeRoot, '2.44.6');
    const packagePath = path.join(temporaryDirectory, 'n8n-nodes-engram-0.8.0.tgz');
    fs.writeFileSync(packagePath, 'synthetic package bytes');

    expect(() =>
      withNodeIdentity('v22.17.0', '/qualified/node22/bin/node', () =>
        runtimeIdentity.getNativeRuntimeIdentity({
          runtimeRoot,
          packagePath,
          env: {},
        }),
      ),
    ).toThrow('Expected n8n 2.12.3; installed runtime is 2.44.6');
  });
});
