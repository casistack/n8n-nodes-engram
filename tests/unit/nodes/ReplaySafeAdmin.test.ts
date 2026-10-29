import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Workflow, NodeHelpers, type INode, type IExecuteFunctions } from 'n8n-workflow';
import { EngramAdmin } from '../../../src/nodes/EngramAdmin/EngramAdmin.node';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { seedAutomaticCaptureSubject } from '../../helpers/automaticCaptureBackend';
import { resolveStoragePath } from '../../../src/utils/helpers';
import { readReplaySafeHumanCaptureRequest } from '../../../src/utils/replaySafeAutomaticAdmin';

describe('native replay-safe Admin routing', () => {
  let directory: string;
  let node: INode;
  let ctx: IExecuteFunctions;
  let credentials: jest.Mock;
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-admin-'));
    const storage = new GraphologyStorage(
      resolveStoragePath({ customStoragePath: directory, workflowId: 'synthetic-owner' }),
    );
    await storage.initialize();
    const { request } = await seedAutomaticCaptureSubject(storage);
    await storage.close();
    node = {
      id: 'synthetic-admin',
      name: 'Capture',
      type: 'n8n-nodes-engram.engramAdmin',
      typeVersion: 3,
      position: [0, 0],
      parameters: {
        resource: 'automaticMemory',
        operation: 'captureHuman',
        backend: 'embedded',
        customStoragePath: directory,
        automaticWorkflowId: 'synthetic-owner',
        automaticNamespace: request.namespace,
        automaticMemoryProfile: 'conservative',
        automaticIssuer: request.issuer,
        automaticActor: request.actorReference,
        automaticTurn: request.turn,
        automaticInput: request.source.content,
        automaticCaptureLifecycle: 'replaySafeV2',
      },
    };
    credentials = jest.fn().mockRejectedValue(new Error('private-credential-text'));
    ctx = {
      getNode: () => node,
      getNodeParameter: (name: string, _index: number, fallback: unknown) =>
        node.parameters[name] ?? fallback,
      getInputData: () => [{ json: {} }],
      getExecutionId: () => 'synthetic-attempt',
      getWorkflow: () => ({ id: 'synthetic-processing-workflow' }),
      getCredentials: credentials,
      getWorkflowStaticData: () => ({}),
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    } as unknown as IExecuteFunctions;
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('evaluates native outputs with Proceed at index zero and retains one legacy output', () => {
    const implementation = new EngramAdmin();
    const workflow = new Workflow({
      nodes: [node],
      connections: {},
      active: false,
      nodeTypes: { getByNameAndVersion: () => implementation } as never,
    });
    workflow.expression.getSimpleParameterValue(
      node,
      implementation.description.outputs as string,
      'internal',
      {},
    );
    expect(NodeHelpers.getNodeOutputs(workflow, node, implementation.description)).toEqual([
      { type: 'main', displayName: 'Proceed' },
      { type: 'main', displayName: 'Stopped' },
    ]);
    node.parameters.automaticCaptureLifecycle = 'legacy';
    expect(NodeHelpers.getNodeOutputs(workflow, node, implementation.description)).toEqual([
      'main',
    ]);
    node.parameters.automaticCaptureLifecycle = '={{ "legacy" }}';
    expect(NodeHelpers.getNodeOutputs(workflow, node, implementation.description)).toEqual([
      { type: 'main', displayName: 'Proceed' },
      { type: 'main', displayName: 'Stopped' },
    ]);
  });

  it('routes first commit to Proceed and redelivery to Stopped without extraction credentials', async () => {
    const first = await new EngramAdmin().execute!.call(ctx);
    expect(first[0]).toHaveLength(1);
    expect(first[1]).toEqual([]);
    expect(first[0][0].json.should_process).toBe(true);
    const second = await new EngramAdmin().execute!.call(ctx);
    expect(second[0]).toEqual([]);
    expect(second[1][0].json).toMatchObject({ status: 'committed_replay', should_process: false });
    expect(credentials).not.toHaveBeenCalled();
  });

  it.each(['continueOnFail', 'onError', 'durable', 'tool', 'unknownLifecycle'])(
    'stops unsupported %s mode before capture',
    async (kind) => {
      if (kind === 'continueOnFail') node.continueOnFail = true;
      if (kind === 'onError') node.onError = 'continueRegularOutput';
      if (kind === 'durable') node.parameters.automaticExecution = 'durable';
      if (kind === 'tool') node.type += 'Tool';
      if (kind === 'unknownLifecycle') node.parameters.automaticCaptureLifecycle = 'future';
      const result = await new EngramAdmin().execute!.call(ctx);
      expect(result[0]).toEqual([]);
      expect(result[1][0].json).toMatchObject({ status: 'failed', should_process: false });
      expect(credentials).not.toHaveBeenCalled();
    },
  );

  it('routes initialization and credential failures only to Stopped with bounded data', async () => {
    node.parameters.backend = 'neo4j';
    const result = await new EngramAdmin().execute!.call(ctx);
    expect(result[0]).toEqual([]);
    expect(result[1][0].json.should_process).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-credential-text');
  });

  it('keeps source provenance null while attempts vary across processing executions', () => {
    const first = readReplaySafeHumanCaptureRequest(ctx, 0);
    const second = readReplaySafeHumanCaptureRequest(
      { ...ctx, getExecutionId: () => 'synthetic-other-attempt' } as IExecuteFunctions,
      0,
    );
    expect(first.source).toEqual(second.source);
    expect(first.source).toMatchObject({
      sourceMessageId: null,
      conversationId: null,
      senderId: null,
      sourceWorkflowId: null,
      originalSourceExecutionId: null,
    });
    expect(first.attemptIdHash).not.toBe(second.attemptIdHash);
  });

  it('preserves input links when a batch splits between Proceed and Stopped', async () => {
    await new EngramAdmin().execute!.call(ctx);
    const turns = ['synthetic-new-zero', node.parameters.automaticTurn, 'synthetic-new-two'];
    const originalGet = ctx.getNodeParameter.bind(ctx);
    const mixed = {
      ...ctx,
      getInputData: () => [{ json: { index: 0 } }, { json: { index: 1 } }, { json: { index: 2 } }],
      getNodeParameter: (name: string, index: number, fallback: unknown) =>
        name === 'automaticTurn' ? turns[index] : originalGet(name, index, fallback as string),
    } as unknown as IExecuteFunctions;
    const result = await new EngramAdmin().execute!.call(mixed);
    expect(result[0].map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
    expect(result[1].map((item) => item.pairedItem)).toEqual([{ item: 1 }]);
    expect(result[0].every((item) => item.json.should_process === true)).toBe(true);
    expect(result[1][0].json.should_process).toBe(false);
  });

  it('pairs every input with a stopped receipt when initialization fails globally', async () => {
    node.parameters.backend = 'neo4j';
    const mixed = {
      ...ctx,
      getInputData: () => [{ json: {} }, { json: {} }, { json: {} }],
    } as IExecuteFunctions;
    const result = await new EngramAdmin().execute!.call(mixed);
    expect(result[0]).toEqual([]);
    expect(result[1].map((item) => item.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
      { item: 2 },
    ]);
  });

  it.each([
    ['resource', '={{ "automaticMemory" }}'],
    ['operation', '={{ "captureHuman" }}'],
    ['automaticCaptureLifecycle', '={{ "legacy" }}'],
    ['automaticCaptureLifecycle', null],
    ['automaticCaptureLifecycle', 'future'],
    ['resource', 'monitoring'],
    ['operation', 'previewAutomatic'],
  ])('keeps malformed or stale opt-in %s=%s on Stopped without any writes', async (key, value) => {
    node.parameters[key as string] = value;
    const implementation = new EngramAdmin();
    const workflow = new Workflow({
      nodes: [node],
      connections: {},
      active: false,
      nodeTypes: { getByNameAndVersion: () => implementation } as never,
    });
    expect(NodeHelpers.getNodeOutputs(workflow, node, implementation.description)).toEqual([
      { type: 'main', displayName: 'Proceed' },
      { type: 'main', displayName: 'Stopped' },
    ]);
    const path = resolveStoragePath({
      customStoragePath: directory,
      workflowId: 'synthetic-owner',
    });
    const before = fs.readFileSync(path, 'utf8');
    for (const continuation of [false, true]) {
      node.continueOnFail = continuation;
      const result = await implementation.execute!.call(ctx);
      expect(result[0]).toEqual([]);
      expect(result[1][0]).toMatchObject({
        json: { should_process: false },
        pairedItem: { item: 0 },
      });
      expect(fs.readFileSync(path, 'utf8')).toBe(before);
    }
    expect(credentials).not.toHaveBeenCalled();
  });

  it('retains an exact Unicode display mapping and rejects mismatched raw content before writes', async () => {
    const raw = node.parameters.automaticInput as string;
    const prefix = '🔊 Synthetic speaker: ';
    node.parameters.automaticInput = prefix + raw;
    node.parameters.automaticRawHuman = raw;
    node.parameters.automaticWrapper = 'enabled';
    node.parameters.automaticRegionStart = prefix.length;
    node.parameters.automaticRegionEnd = prefix.length + raw.length;
    const request = readReplaySafeHumanCaptureRequest(ctx, 0);
    expect(request.source.content).toBe(prefix + raw);
    expect(request.source.humanRegion).toEqual({
      start: prefix.length,
      end: prefix.length + raw.length,
    });
    const first = await new EngramAdmin().execute!.call(ctx);
    expect(first[0][0].json).toMatchObject({
      should_process: true,
      receiptSummary: { itemCounts: { accepted: 1 } },
    });
    const path = resolveStoragePath({
      customStoragePath: directory,
      workflowId: 'synthetic-owner',
    });
    const before = fs.readFileSync(path, 'utf8');
    node.parameters.automaticTurn = 'synthetic-next-event';
    node.parameters.automaticRawHuman = 'Different human content';
    const rejected = await new EngramAdmin().execute!.call(ctx);
    expect(rejected[0]).toEqual([]);
    expect(rejected[1][0].json.should_process).toBe(false);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    delete node.parameters.automaticRawHuman;
    const absentRaw = await new EngramAdmin().execute!.call(ctx);
    expect(absentRaw[0]).toEqual([]);
    expect(absentRaw[1][0].json.should_process).toBe(false);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
  });
});
