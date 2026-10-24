import { createHash } from 'crypto';
import {
  AutomaticActorSchema,
  AutomaticBindingReferenceSchema,
  AutomaticPolicyInputSchema,
  AutomaticPolicySchema,
  AutomaticPreferenceParseResultSchema,
  AutomaticSourceEnvelopeSchema,
  type AutomaticActor,
  type AutomaticBindingReference,
  type AutomaticCaptureFailureReason,
  type AutomaticPolicy,
  type AutomaticPolicyInput,
  type AutomaticPreferenceParseResult,
  type AutomaticReasonCode,
  type AutomaticSourceEnvelope,
} from '../schemas/AutomaticMemory.schema';

type AutomaticPolicyCore = Omit<AutomaticPolicy, 'fingerprint'>;

const POLICY_CORE_BY_PROFILE: Record<AutomaticPolicy['profileId'], AutomaticPolicyCore> = {
  existing: {
    version: 1,
    profileId: 'existing',
    profileVersion: 1,
    policyId: 'legacy',
    policyVersion: 1,
    autoAccept: true,
    requiresExplicitIntent: false,
  },
  conservative: {
    version: 1,
    profileId: 'conservative',
    profileVersion: 1,
    policyId: 'literal-preferences',
    policyVersion: 1,
    autoAccept: true,
    requiresExplicitIntent: false,
  },
  explicit: {
    version: 1,
    profileId: 'explicit',
    profileVersion: 1,
    policyId: 'literal-preferences',
    policyVersion: 1,
    autoAccept: true,
    requiresExplicitIntent: true,
  },
  reviewFirst: {
    version: 1,
    profileId: 'reviewFirst',
    profileVersion: 1,
    policyId: 'literal-preferences',
    policyVersion: 1,
    autoAccept: false,
    requiresExplicitIntent: false,
  },
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalPolicyCore(core: AutomaticPolicyCore): string {
  return JSON.stringify({
    version: core.version,
    profileId: core.profileId,
    profileVersion: core.profileVersion,
    policyId: core.policyId,
    policyVersion: core.policyVersion,
    autoAccept: core.autoAccept,
    requiresExplicitIntent: core.requiresExplicitIntent,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

export function compileAutomaticPolicy(input: AutomaticPolicyInput = {}): AutomaticPolicy {
  const parsed = AutomaticPolicyInputSchema.parse(input);
  const core = POLICY_CORE_BY_PROFILE[parsed.profileId ?? 'existing'];
  const policy = { ...core, fingerprint: sha256(canonicalPolicyCore(core)) };
  return deepFreeze(AutomaticPolicySchema.parse(policy));
}

function isCompiledPolicy(value: unknown): value is AutomaticPolicy {
  const parsed = AutomaticPolicySchema.safeParse(value);
  if (!parsed.success) return false;
  const expected = compileAutomaticPolicy({ profileId: parsed.data.profileId });
  return (
    parsed.data.version === expected.version &&
    parsed.data.profileVersion === expected.profileVersion &&
    parsed.data.policyId === expected.policyId &&
    parsed.data.policyVersion === expected.policyVersion &&
    parsed.data.autoAccept === expected.autoAccept &&
    parsed.data.requiresExplicitIntent === expected.requiresExplicitIntent &&
    parsed.data.fingerprint === expected.fingerprint
  );
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isCodePointBoundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return offset >= 0 && offset <= value.length;
  const left = value.charCodeAt(offset - 1);
  const right = value.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function captureFailure(reason: AutomaticCaptureFailureReason) {
  return { ok: false as const, reason };
}

function isAnchoredRememberWrapper(
  content: string,
  quotes: NonNullable<AutomaticActor['quoteRegions']>,
): boolean {
  const match = /^Remember this:\s+(?=\S)/iu.exec(content);
  if (!match) return false;
  const wrapperEnd = match[0].length;
  return !quotes.some((quote) => quote.start < wrapperEnd && quote.end > 0);
}

export function captureEnvelope(
  content: string,
  rawContent: string,
  actor: AutomaticActor,
  bindingRef: AutomaticBindingReference,
  intent: boolean,
  policy?: AutomaticPolicy,
):
  | { ok: true; envelope: AutomaticSourceEnvelope }
  | { ok: false; reason: AutomaticCaptureFailureReason } {
  if (
    typeof content !== 'string' ||
    typeof rawContent !== 'string' ||
    content.length === 0 ||
    content.length > 65536 ||
    rawContent.length > 65536 ||
    Buffer.byteLength(content, 'utf8') > 65536 ||
    Buffer.byteLength(rawContent, 'utf8') > 65536 ||
    typeof intent !== 'boolean'
  ) {
    return captureFailure('invalid_input');
  }
  if (!isWellFormedUnicode(content) || !isWellFormedUnicode(rawContent)) {
    return captureFailure('invalid_unicode');
  }

  const parsedActor = AutomaticActorSchema.safeParse(actor);
  if (!parsedActor.success) {
    if (parsedActor.error.issues.some((issue) => issue.path[0] === 'humanRegion')) {
      return captureFailure('invalid_region');
    }
    if (parsedActor.error.issues.some((issue) => issue.path[0] === 'quoteRegions')) {
      return captureFailure('invalid_quote_regions');
    }
    return captureFailure('invalid_input');
  }
  const parsedBinding = AutomaticBindingReferenceSchema.safeParse(bindingRef);
  if (!parsedBinding.success) return captureFailure('invalid_binding');

  const effectivePolicy = policy ?? compileAutomaticPolicy();
  if (!isCompiledPolicy(effectivePolicy)) return captureFailure('invalid_policy');

  const quotes = parsedActor.data.quoteRegions;
  if (quotes.length + 1 > 32) return captureFailure('invalid_quote_regions');
  let previousQuoteEnd = -1;
  for (const quote of quotes) {
    if (
      quote.end > content.length ||
      quote.start < previousQuoteEnd ||
      !isCodePointBoundary(content, quote.start) ||
      !isCodePointBoundary(content, quote.end)
    ) {
      return captureFailure('invalid_quote_regions');
    }
    previousQuoteEnd = quote.end;
  }

  let rawStart: number;
  let rawEnd: number;
  let humanRegion: { start: number; end: number };
  let mappingAuthority: 'whole_source' | 'application_region';
  if (rawContent === content) {
    if (
      parsedActor.data.humanRegion &&
      (parsedActor.data.humanRegion.start !== 0 ||
        parsedActor.data.humanRegion.end !== content.length)
    ) {
      return captureFailure('invalid_region');
    }
    rawStart = 0;
    rawEnd = content.length;
    humanRegion = { start: rawStart, end: rawEnd };
    mappingAuthority = 'whole_source';
  } else {
    if (parsedActor.data.applicationOwnedWrapper !== true) {
      return captureFailure('content_not_mapped');
    }
    if (!parsedActor.data.humanRegion) return captureFailure('invalid_region');
    humanRegion = parsedActor.data.humanRegion;
    rawStart = humanRegion.start;
    rawEnd = humanRegion.end;
    if (
      rawEnd > rawContent.length ||
      !isCodePointBoundary(rawContent, rawStart) ||
      !isCodePointBoundary(rawContent, rawEnd)
    ) {
      return captureFailure('invalid_region');
    }
    if (rawContent.slice(rawStart, rawEnd) !== content) {
      return captureFailure('content_not_mapped');
    }
    mappingAuthority = 'application_region';
  }

  const mapping = {
    contentStart: 0,
    contentEnd: content.length,
    rawStart,
    rawEnd,
  };
  const explicitIntent = intent || isAnchoredRememberWrapper(content, quotes);
  const envelope = {
    version: 1 as const,
    namespace: parsedActor.data.namespace,
    issuer: parsedActor.data.issuer,
    actorReference: parsedActor.data.actorReference,
    bindingRef: parsedBinding.data,
    contentHash: sha256(content),
    rawContentHash: sha256(rawContent),
    mappingAuthority,
    humanRegion,
    mappings: [mapping],
    quoteRegions: quotes,
    explicitIntent,
    policy: effectivePolicy,
  };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 16 * 1024) {
    return captureFailure('metadata_too_large');
  }
  const parsedEnvelope = AutomaticSourceEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) return captureFailure('invalid_input');
  return { ok: true, envelope: deepFreeze(parsedEnvelope.data) };
}

const EXPLANATION_ADJECTIVES = [
  'long',
  'short',
  'plain English',
  'plain-English',
  'clear',
  'concise',
  'brief',
  'detailed',
  'thorough',
  'simple',
  'plain-language',
  'step-by-step',
  'technical',
  'nontechnical',
  'beginner-friendly',
  'accessible',
  'practical',
  'high-level',
  'in-depth',
  'succinct',
  'straightforward',
];
const EXPLANATION_NOUNS = [
  'explanation',
  'explanations',
  'answer',
  'answers',
  'response',
  'responses',
  'summary',
  'summaries',
  'instruction',
  'instructions',
];
const FORMAT_VALUES = [
  'bullet points',
  'numbered lists',
  'checklists',
  'short paragraphs',
  'paragraphs',
  'tables',
  'headings',
  'code blocks',
  'inline code',
  'plain text',
  'rich text',
  'markdown',
  'json',
  'csv',
  'yaml',
  'xml',
  'html',
  'latex',
  'diagrams',
  'charts',
  'lists',
  'prose',
  'no emojis',
  'fewer emojis',
];
const PRESENTATION_WORDS = [
  'friendly',
  'professional',
  'warm',
  'neutral',
  'direct',
  'conversational',
  'formal',
  'informal',
  'encouraging',
  'matter-of-fact',
  'concise',
  'polite',
];
const LANGUAGE_NAMES = [
  'English',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Dutch',
  'Swedish',
  'Norwegian',
  'Danish',
  'Finnish',
  'Icelandic',
  'Polish',
  'Czech',
  'Slovak',
  'Ukrainian',
  'Russian',
  'Turkish',
  'Greek',
  'Arabic',
  'Hebrew',
  'Hindi',
  'Bengali',
  'Urdu',
  'Chinese',
  'Japanese',
  'Korean',
  'Thai',
  'Vietnamese',
  'Indonesian',
  'Malay',
  'Swahili',
  'Hausa',
  'Yoruba',
  'Igbo',
  'Akan',
  'Twi',
  'Amharic',
  'Somali',
  'Zulu',
  'Xhosa',
  'Tagalog',
  'Filipino',
  'Romanian',
  'Hungarian',
  'Persian',
  'Farsi',
];
const SENSITIVE_TERMS =
  /\b(?:password|passphrase|passcode|credential|secret|api key|access token|bank account|credit card|debit card|account number|routing number|salary|income|debt|mortgage|financial|medical|health|diagnosis|disease|illness|hiv|cancer|medication|prescription|sexual|sex life|religion|religious|political|politics|vote|voting|party affiliation|biometric|fingerprint|retina|facial recognition)\b/iu;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeValuePattern(values: string[], suffix = ''): RegExp {
  const alternatives = values.map(escapeRegex).join('|');
  return new RegExp(`^(?:${alternatives})${suffix}$`, 'iu');
}

function isLowRiskLiteral(literal: string): boolean {
  const adjectives = EXPLANATION_ADJECTIVES.map(escapeRegex).join('|');
  const nouns = EXPLANATION_NOUNS.map(escapeRegex).join('|');
  const presentations = PRESENTATION_WORDS.map(escapeRegex).join('|');
  const languages = LANGUAGE_NAMES.map(escapeRegex).join('|');
  const explanation = new RegExp(
    `^(?:(?:${adjectives})\\s+)*(?:${nouns})(?:\\s+with\\s+(?:examples|steps))?$`,
    'iu',
  );
  const format = wholeValuePattern(FORMAT_VALUES, '(?:\\s+format)?');
  const presentation = new RegExp(`^(?:${presentations})\\s+(?:tone|style)$`, 'iu');
  const language = new RegExp(
    `^(?:(?:in|plain|simple|clear)\\s+)?(?:${languages})(?:\\s+language)?$`,
    'iu',
  );
  return (
    explanation.test(literal) ||
    format.test(literal) ||
    presentation.test(literal) ||
    language.test(literal)
  );
}

function result(reason?: AutomaticReasonCode): AutomaticPreferenceParseResult {
  return AutomaticPreferenceParseResultSchema.parse({
    claims: [],
    reasons: reason ? [reason] : [],
  });
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isSupportedPolicyEnvelope(envelope: AutomaticSourceEnvelope): boolean {
  return (
    envelope.policy !== undefined &&
    envelope.policy.profileId !== 'existing' &&
    envelope.policy.policyId === 'literal-preferences' &&
    isCompiledPolicy(envelope.policy)
  );
}

function hasQuoteMarks(value: string): boolean {
  return /["“”«»‹›‘’]/u.test(value);
}

function detectUnsupportedReason(value: string): AutomaticReasonCode | undefined {
  if (value.includes('?')) return 'question';
  if (
    /^(?:I might|I may|I could|I would|I think|I believe|maybe\b|perhaps\b|if\b|when\b|unless\b|I wish|I hope)\b/iu.test(
      value,
    )
  ) {
    return 'hypothetical';
  }
  if (
    /^(?:remember to\b|please\b|use\b|always\b|never\b|do not\b|don't\b|try to\b|make sure\b|keep\b)/iu.test(
      value,
    )
  ) {
    return 'instruction';
  }
  const supportedFirstPersonPrefix = /^(?:I prefer|I like|I do not like|I don't like)\s/u.test(
    value,
  );
  if (
    !supportedFirstPersonPrefix &&
    /^(?:(?:my|our|his|her|their|someone|somebody|people)\s+.{0,48}\s+|[A-Z][\p{L}\p{M}'’.-]{0,63}\s+)(?:prefers?|likes?|does not like|doesn't like)\b/iu.test(
      value,
    )
  ) {
    return 'third_party';
  }
  if (
    /\b(?:but|because|although|unless|while|whereas)\b/iu.test(value) ||
    /\b(?:and|or)\s+I\s+(?:prefer|like|do not like|don't like)\b/iu.test(value) ||
    /[;\n\r]/u.test(value) ||
    /[.!?]\s+\S/u.test(value)
  ) {
    return 'mixed_clauses';
  }
  if (SENSITIVE_TERMS.test(value)) return 'sensitive_topic';
  return undefined;
}

export function parseAutomaticPreferences(
  envelope: AutomaticSourceEnvelope,
  content: string,
): AutomaticPreferenceParseResult {
  const parsedEnvelope = AutomaticSourceEnvelopeSchema.safeParse(envelope);
  if (
    !parsedEnvelope.success ||
    typeof content !== 'string' ||
    !isWellFormedUnicode(content) ||
    content.length === 0
  ) {
    return result('invalid_envelope');
  }
  const source = parsedEnvelope.data;
  if (!isSupportedPolicyEnvelope(source)) return result('invalid_envelope');
  if (source.policy?.requiresExplicitIntent && !source.explicitIntent) {
    return result('explicit_intent_required');
  }
  if (sha256(content) !== source.contentHash) return result('content_mismatch');
  const [mapping] = source.mappings;
  if (
    source.mappings.length !== 1 ||
    mapping.contentStart !== 0 ||
    mapping.contentEnd !== content.length ||
    mapping.rawStart !== source.humanRegion.start ||
    mapping.rawEnd !== source.humanRegion.end ||
    mapping.rawEnd - mapping.rawStart !== content.length ||
    (source.mappingAuthority === 'whole_source' && mapping.rawStart !== 0)
  ) {
    return result('incomplete_mapping');
  }
  for (const region of source.quoteRegions) {
    if (
      region.end > content.length ||
      !isCodePointBoundary(content, region.start) ||
      !isCodePointBoundary(content, region.end)
    ) {
      return result('invalid_envelope');
    }
  }

  let clauseStart = 0;
  const wrapper = /^Remember this:\s+(?=\S)/iu.exec(content);
  if (wrapper) clauseStart = wrapper[0].length;
  while (clauseStart < content.length && /\s/u.test(content[clauseStart])) clauseStart += 1;
  let clauseEnd = content.length;
  while (clauseEnd > clauseStart && /\s/u.test(content[clauseEnd - 1])) clauseEnd -= 1;
  if (clauseEnd <= clauseStart) return result('no_preference_clause');

  const exactClause = content.slice(clauseStart, clauseEnd);
  if (codePointLength(exactClause) > 4096) return result('clause_too_long');
  if (source.quoteRegions.some((region) => region.start < clauseEnd && region.end > clauseStart)) {
    return result('quoted_content');
  }
  if (hasQuoteMarks(exactClause)) return result('quoted_content');

  const unsupported = detectUnsupportedReason(exactClause);
  if (unsupported) return result(unsupported);
  const prefixMatch = /^(I prefer|I like|I do not like|I don't like)(\s+)(.+)$/u.exec(exactClause);
  if (!prefixMatch) {
    if (/^I\s+(?:do not|don't)\s+think\b/iu.test(exactClause)) return result('hypothetical');
    return result('unsupported_grammar');
  }
  const prefix = prefixMatch[1];
  const objectStart = clauseStart + prefixMatch[1].length + prefixMatch[2].length;
  let objectEnd = clauseEnd;
  while (objectEnd > objectStart && /\s/u.test(content[objectEnd - 1])) objectEnd -= 1;
  if (objectEnd > objectStart && /[.!]$/u.test(content.slice(objectStart, objectEnd))) {
    objectEnd -= 1;
    while (objectEnd > objectStart && /\s/u.test(content[objectEnd - 1])) objectEnd -= 1;
  }
  const literal = content.slice(objectStart, objectEnd);
  if (literal.length === 0) return result('unsupported_grammar');
  if (codePointLength(literal) > 2048) return result('object_too_long');
  if (literal.includes("'")) return result('quoted_content');
  if (SENSITIVE_TERMS.test(literal)) return result('sensitive_topic');
  if (!isLowRiskLiteral(literal)) return result('unsupported_topic');

  const rawOffset = mapping.rawStart - mapping.contentStart;
  const claim = {
    predicate: 'PREFERS' as const,
    polarity:
      prefix === 'I do not like' || prefix === "I don't like"
        ? ('negative' as const)
        : ('positive' as const),
    literal,
    clause: exactClause,
    clauseSpan: { start: clauseStart, end: clauseEnd },
    objectSpan: { start: objectStart, end: objectEnd },
    rawClauseSpan: { start: clauseStart + rawOffset, end: clauseEnd + rawOffset },
    rawObjectSpan: { start: objectStart + rawOffset, end: objectEnd + rawOffset },
    languageTag: 'und' as const,
  };
  const checked = AutomaticPreferenceParseResultSchema.safeParse({ claims: [claim], reasons: [] });
  return checked.success ? checked.data : result('invalid_envelope');
}
