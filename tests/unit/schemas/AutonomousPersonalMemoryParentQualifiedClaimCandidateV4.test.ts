import {
  AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema,
  type AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data,
} from '../../../src/schemas/AutonomousPersonalMemoryParentQualifiedClaimCandidateV4.schema';
import { CompositionalAutomaticClaimMeaningV2Schema } from '../../../src/schemas/CompositionalAutomaticMemory.schema';
import { AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema } from '../../../src/schemas/AutonomousPersonalQualifiedClaimV4.schema';
import { autonomousPersonalQualifiedClaimFixtureV4 } from '../../helpers/autonomousPersonalQualifiedClaimV4';

// The fixture terminal is constructed synthetic DATA; these schema tests do not authenticate a
// stored receipt, native origin, or permission to read/write a parent.
jest.setTimeout(30_000);

const HASH = 'a'.repeat(64);
const UUID = '00000000-0000-4000-8000-000000000001';

type Fixture = Awaited<ReturnType<typeof autonomousPersonalQualifiedClaimFixtureV4>>;

function candidateData(
  fixture: Fixture,
  options: {
    proofReviewState?: 'accepted' | 'proposed' | 'rejected';
    creationReviewState?: 'accepted' | 'proposed';
    terminalAt?: string;
  } = {},
): AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data {
  if (fixture.candidate.kind !== 'candidate') throw new Error('Expected synthetic Claim3 DATA');
  const claim = fixture.candidate.claim;
  const proofReviewState = options.proofReviewState ?? 'accepted';
  const proof = {
    storeHash: fixture.request.storeHash,
    namespace: fixture.request.namespace,
    subjectId: fixture.subject.uuid,
    claimId: fixture.edge.uuid,
    valueId: fixture.value.uuid,
    sourceId: fixture.source.uuid,
    operationId: fixture.operation.operationId,
    key: claim.key,
    kind: claim.kind,
    unitIndex: 0,
    unitId: claim.evidence.unitId,
    rawSpan: claim.evidence.rawSpan,
    mappedSpan: claim.evidence.mappedSpan,
    sourceHash: claim.sourceHash,
    descriptorHash: claim.descriptorHash,
    evidenceHash: claim.evidence.evidenceHash,
    meaningHash: fixture.candidate.reference.meaningHash,
    dependencies: fixture.candidate.reference.dependencies,
    createdAt: fixture.createdAt,
    sourceEventTime: new Date(Date.parse(fixture.source.reference_time)).toISOString(),
    reviewState: proofReviewState,
  };
  const common = {
    version: 4 as const,
    rowHash: HASH,
    proof,
    terminalAt:
      options.terminalAt ?? new Date(Date.parse(fixture.createdAt) + 60_000).toISOString(),
    creationReviewState: options.creationReviewState ?? 'accepted',
    confidence: null,
    source: {
      sourceMessageId: fixture.source.source_message_id,
      conversationId: fixture.source.conversation_id,
      senderId: fixture.source.sender_id,
      senderName: fixture.source.sender_name,
      episodeKind: fixture.source.episode_kind,
      trustLevel: fixture.source.trust_level,
      reviewStatus: 'accepted' as const,
      referenceTime: fixture.source.reference_time,
      sourceWorkflowId: fixture.source.source_workflow_id,
      sourceExecutionId: fixture.source.source_execution_id,
    },
  };

  if (claim.kind === 'typed_preference') {
    return AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.parse({
      ...common,
      kind: 'typed_preference',
      meaning: claim.meaning,
    });
  }
  return AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.parse({
    ...common,
    kind: 'source_statement_record',
    statementLiteral: claim.evidence.literal,
    sourceEventTime: claim.sourceEventTime,
  });
}

function remapMeaningPath(path: string, copyIndex: number, roots: readonly string[]): string {
  const rootIndex = roots.findIndex((root) => path === root || path.startsWith(`${root}.`));
  if (rootIndex < 0) throw new Error('Meaning path has no declared root');
  return path.replace(/^p\d+/u, `p${copyIndex * roots.length + rootIndex}`);
}

function repeatMeaningForest<T extends { bundles: Array<unknown> }>(meaning: T, copies: number): T {
  const expanded = structuredClone(meaning) as T;
  const source = (meaning as unknown as { bundles: Array<Record<string, unknown>> }).bundles[0];
  const bundle = (expanded as unknown as { bundles: Array<Record<string, unknown>> }).bundles[0];
  if (!source || !bundle) throw new Error('Expected one candidate meaning bundle');
  const roots = source.rootPaths as string[];
  const nodes = source.nodes as Array<Record<string, unknown>>;
  const edges = source.edges as Array<Record<string, unknown>>;
  if (roots.length === 0) throw new Error('Expected a rooted candidate meaning');

  const expandedRoots: string[] = [];
  const expandedNodes: Array<Record<string, unknown>> = [];
  const expandedEdges: Array<Record<string, unknown>> = [];
  for (let copyIndex = 0; copyIndex < copies; copyIndex += 1) {
    for (const root of roots) {
      const rootIndex = roots.indexOf(root);
      expandedRoots.push(`p${copyIndex * roots.length + rootIndex}`);
    }
    for (const node of nodes) {
      const copiedNode: Record<string, unknown> = {
        ...node,
        path: remapMeaningPath(String(node.path), copyIndex, roots),
      };
      if (typeof node.targetPath === 'string') {
        copiedNode.targetPath = remapMeaningPath(node.targetPath, copyIndex, roots);
      }
      expandedNodes.push({
        ...copiedNode,
      });
    }
    for (const edge of edges) {
      if (edge.relation === 'all_of') continue;
      expandedEdges.push({
        ...edge,
        ownerPath: remapMeaningPath(String(edge.ownerPath), copyIndex, roots),
        targetPath: remapMeaningPath(String(edge.targetPath), copyIndex, roots),
      });
    }
  }
  for (let rootIndex = 1; rootIndex < expandedRoots.length; rootIndex += 1) {
    expandedEdges.push({
      ownerPath: expandedRoots[0],
      targetPath: expandedRoots[rootIndex],
      relation: 'all_of',
    });
  }
  bundle.rootPaths = expandedRoots;
  bundle.nodes = expandedNodes;
  bundle.edges = expandedEdges;
  if (copies > 1 || source.relation === 'allOf') {
    bundle.relation = 'allOf';
    bundle.coupling = 'coupled';
  }
  return expanded;
}

describe('AutonomousPersonalMemoryParentQualifiedClaimCandidateV4 DATA schema', () => {
  let typedFixture: Fixture;
  let statementFixture: Fixture;

  beforeAll(async () => {
    typedFixture = await autonomousPersonalQualifiedClaimFixtureV4({
      content:
        'For summaries, I usually prefer answers in plain Canadian French with one practical example before any technical definitions.',
    });
    statementFixture = await autonomousPersonalQualifiedClaimFixtureV4({
      content: 'I work as a ceramicist.',
      prefix: 'Speaker 🧭: ',
    });
  });

  it('accepts typed and dated-literal DATA and preserves terminal time separately from creation time', () => {
    const typed = candidateData(typedFixture);
    const statement = candidateData(statementFixture);

    expect(typed.kind).toBe('typed_preference');
    expect(statement.kind).toBe('source_statement_record');
    expect(typed.terminalAt).not.toBe(typed.proof.createdAt);
    expect(statement.terminalAt).not.toBe(statement.proof.createdAt);
    expect(statement.proof.sourceEventTime).not.toBe(statement.proof.createdAt);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        creationReviewState: 'proposed',
      }).success,
    ).toBe(true);
  });

  it('accepts only accepted creator proof while retaining historical proposed or rejected creation states as DATA', () => {
    const acceptedProof = candidateData(typedFixture);
    const proposedCreation = candidateData(typedFixture, { creationReviewState: 'proposed' });

    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(
        acceptedProof,
      ).success,
    ).toBe(true);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(
        proposedCreation,
      ).success,
    ).toBe(true);
    for (const reviewState of ['proposed', 'rejected'] as const) {
      expect(
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
          ...acceptedProof,
          proof: { ...acceptedProof.proof, reviewState },
        }).success,
      ).toBe(false);
    }
  });

  it('rejects wrong-kind and cross-field meaning, subject, and event-time joins', () => {
    const typed = candidateData(typedFixture);
    if (typed.kind !== 'typed_preference') throw new Error('Expected typed candidate DATA');
    const otherKindProof = {
      ...typed.proof,
      kind: 'source_statement_record' as const,
      dependencies: typed.proof.dependencies.slice(0, 1),
    };
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        proof: otherKindProof,
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        meaning: { ...typed.meaning, namespace: 'another-namespace' },
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        meaning: { ...typed.meaning, subjectId: UUID },
      }).success,
    ).toBe(false);

    const statement = candidateData(statementFixture);
    if (statement.kind !== 'source_statement_record')
      throw new Error('Expected dated statement candidate DATA');
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...statement,
        sourceEventTime: '2026-04-02T09:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects extra raw source fields and top-level raw text', () => {
    const typed = candidateData(typedFixture);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        rawContent: 'I prefer concise explanations.',
      }).success,
    ).toBe(false);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        source: { ...typed.source, rawContent: 'I prefer concise explanations.' },
      }).success,
    ).toBe(false);
  });

  it('bounds the fractional reference timestamp and short-circuits oversized literal DATA', () => {
    const typed = candidateData(typedFixture);
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
        ...typed,
        source: {
          ...typed.source,
          referenceTime: `2026-04-01T09:00:00.${'1'.repeat(44)}Z`,
        },
      }).success,
    ).toBe(false);

    const statement = candidateData(statementFixture);
    if (statement.kind !== 'source_statement_record')
      throw new Error('Expected dated statement candidate DATA');
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      expect(
        AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse({
          ...statement,
          statementLiteral: 'x'.repeat(4097),
        }).success,
      ).toBe(false);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('keeps the largest constructed valid candidate below 48 KiB and checks oversized DATA rejection', () => {
    const typed = candidateData(typedFixture);
    if (typed.kind !== 'typed_preference') throw new Error('Expected typed candidate DATA');
    let candidate: Record<string, unknown> = structuredClone(typed);
    let largestBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    const meaning = typed.meaning;

    for (let copies = 2; copies <= 32; copies += 1) {
      const expanded = repeatMeaningForest(meaning, copies);
      const expandedCheck = CompositionalAutomaticClaimMeaningV2Schema.safeParse(expanded);
      if (!expandedCheck.success) break;
      const source = {
        ...typed.source,
        sourceMessageId: '界'.repeat(512),
        conversationId: '界'.repeat(512),
        senderId: '界'.repeat(512),
        senderName: '界'.repeat(512),
        sourceWorkflowId: '界'.repeat(512),
        sourceExecutionId: '界'.repeat(512),
      };
      const proof = {
        ...typed.proof,
        namespace: '界'.repeat(128),
        dependencies: Array.from({ length: 32 }, (_, index) => ({
          index,
          dependencyHash: HASH,
        })),
      };
      const enlargedMeaning = { ...expanded, namespace: proof.namespace };
      const next = {
        ...typed,
        source,
        proof,
        meaning: enlargedMeaning,
      };
      const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (bytes > largestBytes) {
        largestBytes = bytes;
        candidate = next;
      }
    }

    const serializedBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    // Current nested 32 KiB meaning, proof-count, and source-field limits prevent a
    // schema-valid candidate from reaching 48 KiB. The largest generated valid DATA value
    // is pinned here; the aggregate cap remains defensive if those inner limits ever change.
    expect(serializedBytes).toBe(35_474);
    expect(serializedBytes).toBeLessThan(48 * 1024);
    expect(
      AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema.safeParse(candidate['proof']).success,
    ).toBe(true);
    expect(CompositionalAutomaticClaimMeaningV2Schema.safeParse(candidate['meaning']).success).toBe(
      true,
    );
    expect(
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(candidate)
        .success,
    ).toBe(true);

    const overCap = {
      ...candidate,
      source: {
        ...(candidate['source'] as Record<string, unknown>),
        sourceMessageId: '界'.repeat(6000),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(overCap), 'utf8')).toBeGreaterThan(48 * 1024);
    const parsedOverCap =
      AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema.safeParse(overCap);
    expect(parsedOverCap.success).toBe(false);
    if (!parsedOverCap.success) {
      expect(parsedOverCap.error.issues).toContainEqual(
        expect.objectContaining({ message: 'Invalid compact claim candidate DATA' }),
      );
    }
  });
});
