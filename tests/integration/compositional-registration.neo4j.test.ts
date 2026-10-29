import neo4j from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { makeCompositionalCaptureFixture } from '../helpers/compositionalCaptureFixture';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

describeNeo('native Neo4j compositional registration preservation', () => {
  let storage: Neo4jStorage;
  let driver: ReturnType<typeof neo4j.driver>;
  let fixture: ReturnType<typeof makeCompositionalCaptureFixture>;
  const query = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  };
  beforeEach(async () => {
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    storage = new Neo4jStorage(uri, username, password, database);
    await storage.initialize();
    fixture = makeCompositionalCaptureFixture(
      undefined,
      neo4jAutomaticCaptureStoreHash(uri, database)!,
    );
  });
  afterEach(async () => {
    await storage?.close();
    if (fixture && driver) {
      const namespace = fixture.source.group_id;
      await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
        namespace,
      });
      await query(
        'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
        { namespace },
      );
      await query('MATCH (n:EpisodeGroupLock {group_id:$namespace}) DELETE n', { namespace });
    }
    await driver?.close();
  });
  const seed = async (withOperation: boolean) => {
    for (const entity of fixture.graph.entities) {
      await query('CREATE (e:Entity) SET e += $props', {
        props: { ...entity, attributes: JSON.stringify(entity.attributes) },
      });
    }
    await query('CREATE (e:Episode) SET e += $props', {
      props: {
        ...fixture.source,
        attributes: JSON.stringify(fixture.source.attributes),
        append_sequence: 1,
      },
    });
    if (withOperation) {
      const op = fixture.operation;
      await query('CREATE (op:AutomaticOperation) SET op += $props', {
        props: {
          operation_id: op.operationId,
          store_hash: op.identity.storeHash,
          namespace: op.identity.namespace,
          source_id: op.identity.sourceId,
          role: op.identity.role,
          position: 0,
          record_json: JSON.stringify(op),
        },
      });
    }
  };
  const physical = async () => {
    const source = await query('MATCH (e:Episode {uuid:$id}) RETURN properties(e) AS row', {
      id: fixture.source.uuid,
    });
    const operations = await query(
      'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN properties(op) AS row ORDER BY op.operation_id',
      { namespace: fixture.source.group_id },
    );
    const revision = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS revision",
    );
    return {
      source: source.records.map((r) => r.get('row')),
      operations: operations.records.map((r) => r.get('row')),
      revision: revision.records.map((r) => String(r.get('revision'))),
    };
  };

  it.each([false, true])(
    'preserves native V3 sources and old entities after unrelated write and reopen, operation=%s',
    async (withOperation) => {
      await seed(withOperation);
      const before = await physical();
      expect(await storage.getEpisode(fixture.source.uuid)).toEqual(fixture.source);
      await storage.addEntity({
        group_id: fixture.source.group_id,
        name: 'Unrelated synthetic concept',
        entity_type: 'concept',
      });
      await storage.close();
      storage = new Neo4jStorage(uri, username, password, database);
      await storage.initialize();
      const snapshot = await storage.readExtractionSnapshot(fixture.source.group_id);
      expect(snapshot.episodes).toEqual([fixture.source]);
      for (const entity of fixture.graph.entities)
        expect(snapshot.entities.find((row) => row.uuid === entity.uuid)).toEqual(entity);
      expect(snapshot.edges).toEqual([]);
      expect(snapshot.automatic_operations_v1?.operations ?? []).toEqual(
        withOperation ? [fixture.operation] : [],
      );
      const after = await physical();
      expect(after.source).toEqual(before.source);
      expect(after.operations).toEqual(before.operations);
    },
  );

  it.each([false, true])(
    'V2 control APIs decline without any native mutation, operation=%s',
    async (withOperation) => {
      await seed(withOperation);
      const before = await physical();
      const { preferenceInterpreter: _interpreter, ...common } = fixture.input.request;
      expect(_interpreter).toBe('compositionalV2');
      const request = { ...common, version: 2 as const };
      const locator = {
        version: 2 as const,
        namespace: request.namespace,
        issuer: request.issuer,
        actorReference: request.actorReference,
        turn: request.turn,
        role: 'human' as const,
      };
      const fence = { ...locator, expectedGeneration: 1, attemptIdHash: 'd'.repeat(64) };
      expect(await storage.beginAndClaimAutomaticCaptureV2(request)).toMatchObject({
        kind: 'unsupported_mode',
      });
      expect(await storage.resumeAutomaticCaptureV2(fence)).toEqual({ kind: 'unsupported_mode' });
      expect(await storage.cancelAutomaticCaptureV2(fence)).toMatchObject({
        kind: 'unsupported_mode',
        eligibleFirstCommit: false,
      });
      expect(await storage.getAutomaticCaptureOutcomeV2(locator)).toMatchObject({
        status: 'unsupported_mode',
        sourceId: null,
        should_process: false,
      });
      expect(await physical()).toEqual(before);
    },
  );

  it('does not grant generic imports or a caller supplied trusted boolean V3 creation authority', async () => {
    await seed(false);
    const before = await physical();
    await expect(
      storage.importGraph({ ...fixture.graph, entities: [], edges: [] }),
    ).rejects.toThrow(/owned_source_import_forbidden|binding_restore_unsupported/);
    await expect(storage.appendAutomaticEpisodes([fixture.source])).rejects.toThrow(
      'trusted_capture_writer_required',
    );
    const untyped = storage.appendEpisodes as unknown as (
      rows: unknown[],
      trusted: boolean,
    ) => Promise<unknown>;
    await expect(untyped.call(storage, [fixture.source], true)).rejects.toThrow(
      /trusted_capture_writer_required|reserved/,
    );
    expect(await physical()).toEqual(before);
  });

  it('rejects oversized protected attributes with a late escaped key before JSON.parse', async () => {
    await seed(true);
    const oversized = JSON.stringify({
      padding: 'x'.repeat(512 * 1024),
      ...fixture.source.attributes,
    }).replace('"engram_write_owner_v3"', '"engram_\\u0077rite_owner_v3"');
    await query('MATCH (e:Episode {uuid:$id}) SET e.attributes=$attributes', {
      id: fixture.source.uuid,
      attributes: oversized,
    });
    const before = await physical();
    const original = JSON.parse;
    let oversizedParses = 0;
    const spy = jest
      .spyOn(JSON, 'parse')
      .mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
        if (text === oversized) oversizedParses++;
        return original(text, reviver);
      });
    try {
      await expect(storage.getEpisode(fixture.source.uuid)).rejects.toThrow(
        'native_attributes_too_large',
      );
      await expect(storage.readExtractionSnapshot(fixture.source.group_id)).rejects.toThrow(
        'native_attributes_too_large',
      );
      expect(oversizedParses).toBe(0);
      expect(await physical()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])(
    'rejects raw own __proto__ metadata before normalization without physical changes, operation=%s',
    async (withOperation) => {
      Object.defineProperty(fixture.source.attributes, '__proto__', {
        enumerable: true,
        value: { synthetic: true },
      });
      await seed(withOperation);
      const before = await physical();
      await expect(storage.getEpisode(fixture.source.uuid)).rejects.toThrow(
        /record_normalization|invalid_source_tuple/,
      );
      await expect(storage.readExtractionSnapshot(fixture.source.group_id)).rejects.toThrow(
        /record_normalization|invalid_source_tuple/,
      );
      expect(await physical()).toEqual(before);
    },
  );
});
