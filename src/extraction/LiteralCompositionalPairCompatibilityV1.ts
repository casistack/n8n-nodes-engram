import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import {
  LiteralCompositionalPairCompatibilityRequestV1Schema,
  LiteralCompositionalPairCompatibilityRuleV1Schema,
  type LiteralCompositionalPairCompatibilityResultV1,
} from '../schemas/LiteralCompositionalPairCompatibilityV1.schema';
import type { CompositionalAutomaticClaimMeaningV2 } from '../schemas/CompositionalAutomaticMemory.schema';
import {
  compositionalCaptureMeaningHashV3,
  compositionalCapturePredicateDependenciesV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import type {
  CompositionalPreferenceV2MeaningNode,
  CompositionalPreferenceV2MeaningEdge,
} from '../schemas/CompositionalPreferenceV2Meaning.schema';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';

type Bundle = CompositionalAutomaticClaimMeaningV2['bundles'][number];
type Node = CompositionalPreferenceV2MeaningNode;
type Edge = CompositionalPreferenceV2MeaningEdge;
type OldShape = 'O_SHORT' | 'O_NOT_LONG' | 'O_SHORT_EXAMPLES';
type NewShape = 'N_LANGUAGE' | 'N_ORDER' | 'N_RICH';
const edgeKey = (edge: Edge) => canonicalAutomaticCaptureV2(edge);
class ShapeMatcher {
  readonly nodes = new Map<string, Node>();
  readonly outgoing = new Map<string, Edge[]>();
  readonly coveredNodes = new Set<string>();
  readonly coveredEdges = new Set<string>();
  constructor(
    readonly bundle: Bundle,
    readonly check: () => void,
  ) {
    for (const node of bundle.nodes) {
      check();
      this.nodes.set(node.path, node);
    }
    for (const edge of bundle.edges) {
      check();
      this.outgoing.set(edge.ownerPath, [...(this.outgoing.get(edge.ownerPath) ?? []), edge]);
    }
  }
  take(path: string): Node | undefined {
    this.check();
    const node = this.nodes.get(path);
    if (node) this.coveredNodes.add(path);
    return node;
  }
  children(path: string, relation: Edge['relation']): Edge[] {
    this.check();
    return (this.outgoing.get(path) ?? []).filter((e) => e.relation === relation);
  }
  child(path: string, relation: Edge['relation']): Node | undefined {
    const edges = this.children(path, relation);
    if (edges.length !== 1) return undefined;
    this.coveredEdges.add(edgeKey(edges[0]));
    return this.take(edges[0].targetPath);
  }
  root(): Extract<Node, { kind: 'preference' }> | undefined {
    if (this.bundle.relation !== 'single' || this.bundle.rootPaths.length !== 1) return undefined;
    const root = this.take(this.bundle.rootPaths[0]);
    return root?.kind === 'preference' ? root : undefined;
  }
  target(root: Extract<Node, { kind: 'preference' }>): Node | undefined {
    const node = this.child(root.path, 'targets');
    return node?.path === root.targetPath ? node : undefined;
  }
  complete(): boolean {
    this.check();
    return (
      this.coveredNodes.size === this.bundle.nodes.length &&
      this.coveredEdges.size === this.bundle.edges.length
    );
  }
  coverage(meaning: CompositionalAutomaticClaimMeaningV2) {
    return {
      nodePaths: [...this.coveredNodes].sort(),
      edgeKeys: [...this.coveredEdges].sort(),
      predicateDependencies: compositionalCapturePredicateDependenciesV3(meaning),
    };
  }
}
const affirmative = (node: Extract<Node, { kind: 'preference' }>) =>
  (node.operator === 'prefer' || node.operator === 'like') &&
  node.polarity === 'affirmed' &&
  node.negation === 'none';
const negativeLong = (node: Extract<Node, { kind: 'preference' }>) =>
  ((node.operator === 'prefer' || node.operator === 'like') &&
    node.polarity === 'negated' &&
    node.negation === 'negative') ||
  (node.operator === 'dislike' && node.polarity === 'affirmed' && node.negation === 'none');
function oldShape(m: ShapeMatcher): OldShape | undefined {
  const p = m.root();
  if (!p) return undefined;
  const target = m.target(p);
  if (target?.kind !== 'output' || target.value !== 'explanation') return undefined;
  const length = m.child(target.path, 'modifies');
  if (length?.kind !== 'length') return undefined;
  if (length.value === 'long' && negativeLong(p)) return m.complete() ? 'O_NOT_LONG' : undefined;
  if (length.value !== 'short' || !affirmative(p)) return undefined;
  const includes = m.children(target.path, 'includes');
  if (includes.length === 0) return m.complete() ? 'O_SHORT' : undefined;
  const examples = m.child(target.path, 'includes');
  if (examples?.kind !== 'action' || examples.value !== 'examples') return undefined;
  return m.complete() ? 'O_SHORT_EXAMPLES' : undefined;
}
function language(m: ShapeMatcher, node: Node): boolean {
  if (node.kind !== 'language') return false;
  const modifiers = m.children(node.path, 'qualifies');
  if (modifiers.length === 0) return true;
  const use = m.child(node.path, 'qualifies');
  return use?.kind === 'language_use' && ['plain', 'simple', 'clear'].includes(use.value);
}
function ordering(m: ShapeMatcher, node: Node): boolean {
  if (node.kind !== 'ordering' || node.relation !== 'before') return false;
  const edges = m.children(node.path, 'orders');
  if (edges.length !== 2) return false;
  const first = edges.find((e) => e.relation === 'orders' && e.position === 'first');
  const second = edges.find((e) => e.relation === 'orders' && e.position === 'second');
  if (!first || !second) return false;
  m.coveredEdges.add(edgeKey(first));
  m.coveredEdges.add(edgeKey(second));
  const a = m.take(first.targetPath);
  const b = m.take(second.targetPath);
  if (
    a?.kind !== 'action' ||
    a.value !== 'examples' ||
    b?.kind !== 'action' ||
    b.value !== 'terminology'
  )
    return false;
  const count = m.child(a.path, 'counts');
  if (count?.kind !== 'count' || count.value !== 1 || count.mode !== 'as_stated') return false;
  const any = m.child(b.path, 'quantifies');
  if (any?.kind !== 'quantifier' || any.value !== 'any') return false;
  if (m.children(a.path, 'qualifies').length) {
    const qualifier = m.child(a.path, 'qualifies');
    if (
      qualifier?.kind !== 'action_qualifier' ||
      !['practical', 'worked'].includes(qualifier.value)
    )
      return false;
  }
  if (m.children(b.path, 'qualifies').length) {
    const qualifier = m.child(b.path, 'qualifies');
    if (qualifier?.kind !== 'action_qualifier' || qualifier.value !== 'technical') return false;
  }
  return true;
}
function newShape(m: ShapeMatcher): NewShape | undefined {
  const p = m.root();
  if (!p || !affirmative(p)) return undefined;
  const target = m.target(p);
  if (!target) return undefined;
  // Direct language target means L=T: preserve the complete exact atom/tag.
  if (target.kind === 'language')
    return language(m, target) && m.complete() ? 'N_LANGUAGE' : undefined;
  if (target.kind !== 'output' || !['explanation', 'response'].includes(target.value))
    return undefined;
  const languageEdges = m.children(target.path, 'language_of');
  const orderingEdges = m.children(target.path, 'has_ordering');
  if (
    languageEdges.length > 1 ||
    orderingEdges.length > 1 ||
    (!languageEdges.length && !orderingEdges.length)
  )
    return undefined;
  if (languageEdges.length) {
    const l = m.child(target.path, 'language_of');
    if (!l || !language(m, l)) return undefined;
  }
  if (orderingEdges.length) {
    const o = m.child(target.path, 'has_ordering');
    if (!o || !ordering(m, o)) return undefined;
  }
  if (!m.complete()) return undefined;
  return languageEdges.length ? (orderingEdges.length ? 'N_RICH' : 'N_LANGUAGE') : 'N_ORDER';
}
/** Pure conditional pair data. Never substitutes for trusted current eligibility,
 * whole-universe overlap inspection, source evidence, or an acceptance permit. */
export function inspectLiteralCompositionalPairCompatibilityV1(
  input: unknown,
  externalCheck: () => void = () => {},
): LiteralCompositionalPairCompatibilityResultV1 {
  let aborted = false;
  let abort: unknown;
  const check = () => {
    if (aborted) throw abort;
    try {
      externalCheck();
    } catch (error) {
      aborted = true;
      abort = error;
      throw error;
    }
  };
  const common = {
    version: 1 as const,
    checker: 'accepted_literal_compositional_compatibility_v1' as const,
  };
  const unknown = (
    reason: Extract<
      LiteralCompositionalPairCompatibilityResultV1,
      { status: 'unknown_constraints' }
    >['reason'],
  ): LiteralCompositionalPairCompatibilityResultV1 => ({
    ...common,
    status: 'unknown_constraints',
    reason,
  });
  check();
  let snapshot: unknown;
  try {
    snapshot = cloneBoundedAutomaticCaptureJson(input, 'beginRequest');
  } catch {
    return unknown('invalid_input');
  }
  check();
  const parsed = LiteralCompositionalPairCompatibilityRequestV1Schema.safeParse(snapshot);
  check();
  if (!parsed.success) return unknown('invalid_input');
  const { oldMeaning, newMeaning } = parsed.data;
  if (
    oldMeaning.namespace !== newMeaning.namespace ||
    oldMeaning.subjectId !== newMeaning.subjectId
  )
    return unknown('identity_mismatch');
  const oldMatcher = new ShapeMatcher(oldMeaning.bundles[0], check);
  const old = oldShape(oldMatcher);
  if (!old) return unknown('unsupported_old_shape');
  const newMatcher = new ShapeMatcher(newMeaning.bundles[0], check);
  const next = newShape(newMatcher);
  if (!next) return unknown('unsupported_new_shape');
  const rule = LiteralCompositionalPairCompatibilityRuleV1Schema.safeParse(`${old}:${next}`);
  if (!rule.success) return unknown('unsupported_pair');
  const oldCoverage = oldMatcher.coverage(oldMeaning);
  const newCoverage = newMatcher.coverage(newMeaning);
  if (
    oldCoverage.predicateDependencies.length !== 1 ||
    newCoverage.predicateDependencies.length !== 1 ||
    !oldMatcher.complete() ||
    !newMatcher.complete()
  )
    return unknown('incomplete_coverage');
  check();
  return {
    ...common,
    status: 'compatible_constraints',
    ruleId: rule.data,
    oldMeaningHash: compositionalCaptureMeaningHashV3(oldMeaning),
    newMeaningHash: compositionalCaptureMeaningHashV3(newMeaning),
    oldCoverage,
    newCoverage,
  };
}
