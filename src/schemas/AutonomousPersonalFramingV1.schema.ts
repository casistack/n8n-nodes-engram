import { z } from 'zod';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { tokenizeMappedBody } from '../extraction/AutonomousSourceLexerV1';
import { isAutonomousWhitespaceCodePointV1 } from '../extraction/AutonomousUnicodeV1';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  compileAutonomousSourceGeometryV3,
  hashAutonomousSourceGeometryV3,
  type AutonomousSourceGeometryInputV3,
} from './AutonomousSourceGeometryV3.schema';
import { compileAutonomousPersonalSourceScanV1 } from './AutonomousPersonalSourceScanV1.schema';
import type { AutonomousSourceLexicalTokenV1 } from './AutonomousSourceLexicalTokenV1.schema';

const MAX_BYTES = 64 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const index = z.number().int().min(0).max(127);
const observationCodes = [
  'question_terminal',
  'geometry_quote_overlap',
  'paired_text_quote_overlap',
  'report_complement',
  'instruction_memory_pattern',
  'conditional_uncertainty_token',
  'neutral_greeting_shape',
] as const;
const sensitivityCodes = [
  'credential_label',
  'email',
  'telephone',
  'precise_address_or_location',
  'financial_or_account',
  'health_or_medical',
  'religion',
  'sexual_orientation_or_gender_identity',
  'political_affiliation',
  'race_or_ethnicity_self_identification',
] as const;
const scopeCodes = [
  'report_example_header',
  'ambiguous_report_example_prefix',
  'retroactive_frame',
  'ambiguous_retroactive_frame',
] as const;
const headSchema = z.enum([
  'direct_i',
  'contracted_i_am',
  'contracted_i_have',
  'remember_prefix_i',
  'remember_prefix_i_am',
  'remember_prefix_i_have',
  'unsupported_i_contraction',
  'incomplete_i_head',
  'no_supported_head',
]);
const failureSchema = z.enum([
  'unmatched_quote',
  'mismatched_quote',
  'unmatched_bracket',
  'mismatched_bracket',
  'unsupported_quote_escape',
  'nesting_limit',
  'ambiguous_period_boundary',
  'lexical_token_limit',
  'unit_limit',
]);
const unitSchema = z
  .object({
    unitIndex: index,
    headCode: headSchema,
    observationCodes: z.array(z.enum(observationCodes)).max(observationCodes.length),
    sensitivityCodes: z.array(z.enum(sensitivityCodes)).max(sensitivityCodes.length),
  })
  .strict();
const findingSchema = z
  .object({
    code: z.enum(scopeCodes),
    fromUnitIndex: index,
    scope: z.enum(['unit_through_eof', 'whole_source']),
  })
  .strict();

function ordered<T extends string>(values: readonly T[], order: readonly T[]): boolean {
  return values.every((value, position) =>
    position === 0 ? true : order.indexOf(values[position - 1]) < order.indexOf(value),
  );
}

/** Structural DATA only; source, identity, usefulness and acceptance are not established. */
export const AutonomousPersonalFramingV1OwnedDataSchema = z
  .object({
    version: z.literal(1),
    scannerVersion: z.literal(1),
    unicodeVersion: z.literal('16.0.0'),
    rawContentHash: hash,
    mappedContentHash: hash,
    geometryHash: hash,
    sourceScanHash: hash,
    scanStatus: z.enum(['complete', 'indeterminate', 'resource_limit']),
    scanFailureCode: failureSchema.nullable(),
    sourceScopeFindings: z.array(findingSchema).max(4),
    units: z.array(unitSchema).max(128),
  })
  .strict()
  .superRefine((report, context) => {
    const bad = () =>
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid framing report' });
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_BYTES) bad();
    if (report.scanStatus === 'complete') {
      if (report.scanFailureCode !== null) bad();
    } else {
      if (report.units.length || report.sourceScopeFindings.length || !report.scanFailureCode)
        bad();
      const resource =
        report.scanFailureCode === 'unit_limit' || report.scanFailureCode === 'lexical_token_limit';
      if ((report.scanStatus === 'resource_limit') !== resource) bad();
    }
    report.units.forEach((unit, position) => {
      if (
        unit.unitIndex !== position ||
        !ordered(unit.observationCodes, observationCodes) ||
        !ordered(unit.sensitivityCodes, sensitivityCodes)
      )
        bad();
    });
    const seen = new Set<string>();
    report.sourceScopeFindings.forEach((finding, position) => {
      if (seen.has(finding.code) || finding.fromUnitIndex >= report.units.length) bad();
      seen.add(finding.code);
      const whole =
        finding.code === 'retroactive_frame' || finding.code === 'ambiguous_retroactive_frame';
      if ((finding.scope === 'whole_source') !== whole) bad();
      const prior = report.sourceScopeFindings[position - 1];
      if (
        prior &&
        (prior.fromUnitIndex > finding.fromUnitIndex ||
          (prior.fromUnitIndex === finding.fromUnitIndex &&
            scopeCodes.indexOf(prior.code) >= scopeCodes.indexOf(finding.code)))
      )
        bad();
    });
  });
export type AutonomousPersonalFramingV1 = z.infer<
  typeof AutonomousPersonalFramingV1OwnedDataSchema
>;
type Unit = z.infer<typeof unitSchema>;
type Finding = z.infer<typeof findingSchema>;
type Token = AutonomousSourceLexicalTokenV1;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function invalid(): z.ZodError {
  return freeze(
    new z.ZodError([
      { code: z.ZodIssueCode.custom, path: [], message: 'invalid_autonomous_framing_data' },
    ]),
  );
}
function parseOwned(value: unknown): AutonomousPersonalFramingV1 {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw invalid();
  return freeze(AutonomousPersonalFramingV1OwnedDataSchema.parse(value));
}
export const AutonomousPersonalFramingV1Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalFramingV1 {
    try {
      return parseOwned(cloneBoundedAutomaticCaptureJson(value, 'beginRequest'));
    } catch {
      throw invalid();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalFramingV1> {
    try {
      return {
        success: true,
        data: parseOwned(cloneBoundedAutomaticCaptureJson(value, 'beginRequest')),
      };
    } catch {
      return { success: false, error: invalid() };
    }
  },
});

const lower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const phrases = (values: string) => values.split('|').map((value) => value.split(' '));
function at(words: readonly string[], phrase: readonly string[], start = 0): boolean {
  return phrase.every((word, offset) => words[start + offset] === word);
}
function includes(words: readonly string[], alternatives: readonly (readonly string[])[]): boolean {
  return words.some((_, start) => alternatives.some((phrase) => at(words, phrase, start)));
}
const incomplete = new Set(
  'am are was were be been being have has had do does did can may must shall should will'.split(
    ' ',
  ),
);
const heads = new Map<string, z.infer<typeof headSchema>>([
  ['i', 'direct_i'],
  ["i'm", 'contracted_i_am'],
  ['i’m', 'contracted_i_am'],
  ["i've", 'contracted_i_have'],
  ['i’ve', 'contracted_i_have'],
]);
const subjectWords = new Set([...heads.keys(), 'you', 'he', 'she', 'they', 'someone', 'somebody']);
const reportPredicates = phrases(
  'read|heard|learned|discovered|found out|was told|was informed|was shown',
);
const uncertainty = phrases(
  'if|unless|provided|assuming|supposing|hypothetically|maybe|perhaps|may|might|could|would|when|whenever|while|wonder|possibly|probably|guess|seem|seems|seemed|as if|in case|as long as|on condition|were to|i think|i believe|i suppose|i expect',
);
const neutral =
  /^(?:hi|hello|hey|thanks|thank you|okay|ok|good morning|good afternoon|good evening)[.!]?$/;
const headerPhrases = phrases(
  "for example|as an example|here is an example|here's an example|here is what follows|here's what follows|example|quote|quoted|report|reported|hypothetical|pretend|suppose|according to",
);
const reportVerbs = new Set(['said', 'wrote', 'told']);
const reportSubjects = new Set(['someone', 'somebody', 'they', 'he', 'she']);
const retroactive = [
  ...['quote', 'quotation', 'example', 'hypothetical'].flatMap((noun) =>
    ['', 'just ', 'only '].map(
      (modifier) => `that was ${modifier}${noun === 'example' ? 'an' : 'a'} ${noun}`,
    ),
  ),
  ...['pretending', 'quoting', 'joking', 'kidding'].flatMap((verb) =>
    ['', 'just ', 'only '].map((modifier) => `i was ${modifier}${verb}`),
  ),
  'that was just pretend',
  'that was only pretend',
].map((value) => value.split(' '));
const retroWords = new Set(
  'quote quotation example hypothetical pretending quoting joking kidding'.split(' '),
);

function head(
  body: string,
  tokens: readonly Token[],
  words: readonly string[],
  wordTokens: readonly Token[],
): { code: Unit['headCode']; wordStart: number | null } {
  let first = 0;
  let prefix = false;
  if (tokens[0]?.start === 0 && lower(body.slice(0, 14)) === 'remember this:') {
    let offset = 14;
    const whitespaceStart = offset;
    while (offset < body.length) {
      const point = body.codePointAt(offset)!;
      if (!isAutonomousWhitespaceCodePointV1(point)) break;
      offset += point > 0xffff ? 2 : 1;
    }
    if (offset > whitespaceStart && wordTokens[2]?.start === offset) {
      first = 2;
      prefix = true;
    }
  }
  if (!prefix && (tokens[0]?.kind !== 'word' || tokens[0] !== wordTokens[0]))
    return { code: 'no_supported_head', wordStart: null };
  const word = words[first];
  if (["i'll", 'i’ll', "i'd", 'i’d'].includes(word))
    return { code: 'unsupported_i_contraction', wordStart: first };
  const code = heads.get(word);
  if (!code) return { code: 'no_supported_head', wordStart: null };
  const remaining = words.slice(first + 1);
  if (
    !remaining.length ||
    (word === 'i' && remaining[0] === 'to') ||
    (remaining.length === 1 && incomplete.has(remaining[0]))
  )
    return { code: 'incomplete_i_head', wordStart: first };
  if (!prefix) return { code, wordStart: first };
  return {
    code:
      code === 'direct_i'
        ? 'remember_prefix_i'
        : code === 'contracted_i_am'
          ? 'remember_prefix_i_am'
          : 'remember_prefix_i_have',
    wordStart: first,
  };
}

function reportComplement(words: readonly string[], first: number | null): boolean {
  if (first === null) return false;
  return reportPredicates.some((predicate) => {
    if (!at(words, predicate, first + 1)) return false;
    const end = first + 1 + predicate.length;
    const complement = (offset: number) =>
      subjectWords.has(words[offset] === 'that' ? words[offset + 1] : words[offset]);
    if (complement(end)) return true;
    return (
      ['from', 'by', 'in', 'on'].includes(words[end]) &&
      [1, 2, 3, 4].some((length) => complement(end + 1 + length))
    );
  });
}

function headerEnd(words: readonly string[]): number | null {
  const fixed = headerPhrases.find((phrase) => at(words, phrase));
  if (fixed) return fixed.length - 1;
  for (const prefix of phrases("here is what|here's what")) {
    if (
      at(words, prefix) &&
      reportSubjects.has(words[prefix.length]) &&
      reportVerbs.has(words[prefix.length + 1])
    )
      return prefix.length + 1;
  }
  if (reportSubjects.has(words[0]) && reportVerbs.has(words[1])) return 1;
  if (['my', 'a', 'an', 'the'].includes(words[0])) {
    for (let length = 1; length <= 4; length++)
      if (reportVerbs.has(words[length + 1])) return length + 1;
  }
  return null;
}

const credential = phrases(
  'password|passcode|passphrase|api key|client secret|secret key|access token|refresh token|private key|authorization|bearer token|recovery code|one time code',
);
const health = phrases(
  "aids|adhd|alzheimer's|anxiety|asthma|autism|autistic|bipolar|cancer|chemotherapy|chronic pain|depression|diabetes|disabled|disability|epilepsy|hiv|insulin|leukemia|lupus|medication|multiple sclerosis|parkinson's|prescription|ptsd|schizophrenia|stroke",
);
const religion = phrases(
  'agnostic|atheist|buddhist|buddhism|catholic|christian|hindu|hinduism|islam|jewish|judaism|mormon|muslim|pagan|protestant|sikh|sikhism|taoist|taoism|wiccan',
);
const sexuality = phrases(
  'asexual|bisexual|gay|intersex|lesbian|nonbinary|pansexual|queer|transgender',
);
const parties = phrases(
  'democratic party|republican party|labour party|conservative party|green party|liberal democrats|snp|plaid cymru|socialist party|communist party|libertarian party',
);
const races = phrases(
  'african american|arab|asian|black|biracial|indigenous|latino|latina|latine|middle eastern|native american|white|mixed race|hispanic',
);

function luhn(value: string): boolean {
  let sum = 0;
  let twice = false;
  for (let position = value.length - 1; position >= 0; position--) {
    let digit = Number(value[position]);
    if (twice) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    twice = !twice;
  }
  return sum % 10 === 0;
}
function iban(value: string): boolean {
  const moved = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const character of moved) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
function valueAfter(
  words: readonly string[],
  labels: readonly (readonly string[])[],
  distance: number,
  value: (word: string) => boolean,
): boolean {
  return words.some((_, start) =>
    labels.some(
      (label) =>
        at(words, label, start) &&
        words.slice(start + label.length, start + label.length + distance).some(value),
    ),
  );
}

function coordinateAfter(
  literal: string,
  wordTokens: readonly Token[],
  labelIndex: number,
  literalStart: number,
): boolean {
  const text = (token: Token) =>
    literal.slice(token.start - literalStart, token.end - literalStart);
  const decimal = (start: number) => {
    const integer = wordTokens[start];
    const fraction = wordTokens[start + 1];
    return (
      integer &&
      fraction &&
      /^[0-9]+$/.test(text(integer)) &&
      /^[0-9]+$/.test(text(fraction)) &&
      literal.slice(integer.end - literalStart, fraction.start - literalStart) === '.'
    );
  };
  // Match token structure rather than searching an arbitrarily long digit
  // string with an unanchored numeric regex. Decimal components stay literal.
  for (let offset = 1; offset <= 4; offset++) {
    const first = labelIndex + offset;
    if (!decimal(first) || !decimal(first + 2)) continue;
    const between = literal.slice(
      wordTokens[first + 1].end - literalStart,
      wordTokens[first + 2].start - literalStart,
    );
    const separator = Array.from(between)
      .filter((character) => !isAutonomousWhitespaceCodePointV1(character.codePointAt(0)!))
      .join('');
    if ([',', '/', ',+', ',-', '/+', '/-'].includes(separator)) return true;
  }
  return false;
}

function localPhoneAfter(
  literal: string,
  words: readonly string[],
  wordTokens: readonly Token[],
  literalStart: number,
): boolean {
  const connected = (left: number, right: number) =>
    /^[ ()\-.]*$/.test(
      literal.slice(wordTokens[left].end - literalStart, wordTokens[right].start - literalStart),
    );
  return words.some((label, labelIndex) => {
    if (!['phone', 'telephone', 'mobile', 'cell', 'tel'].includes(label)) return false;
    for (let offset = 1; offset <= 3; offset++) {
      const start = labelIndex + offset;
      if (!words[start] || !/^[0-9]+$/.test(words[start])) continue;
      // A later digit group is not a new candidate inside an overlong number.
      if (
        start > labelIndex + 1 &&
        /^[0-9]+$/.test(words[start - 1]) &&
        connected(start - 1, start)
      )
        continue;
      let digits = words[start].length;
      let next = start + 1;
      while (
        digits <= 15 &&
        words[next] &&
        /^[0-9]+$/.test(words[next]) &&
        connected(next - 1, next)
      ) {
        digits += words[next].length;
        next++;
      }
      if (digits >= 7 && digits <= 15) return true;
    }
    return false;
  });
}
function sensitivity(
  literal: string,
  words: readonly string[],
  wordTokens: readonly Token[],
  literalStart: number,
): Unit['sensitivityCodes'] {
  const hits = new Set<Unit['sensitivityCodes'][number]>();
  if (
    includes(words, credential) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(literal)
  )
    hits.add('credential_label');
  if (
    /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9._%+-])/.test(
      literal,
    )
  )
    hits.add('email');
  if (
    /(?:^|[^0-9])\+(?:[ ()\-.]*[0-9]){10,15}(?![ ()\-.]*[0-9])/.test(literal) ||
    localPhoneAfter(literal, words, wordTokens, literalStart)
  )
    hits.add('telephone');
  const street = new Set(
    'street st road rd avenue ave boulevard blvd lane ln drive dr court ct place pl way'.split(' '),
  );
  if (
    words.some(
      (word, position) =>
        /^[0-9]{1,6}$/.test(word) &&
        words.slice(position + 1, position + 6).some((next) => street.has(next)),
    ) ||
    valueAfter(
      words,
      phrases('home address|street address|mailing address|postcode|postal code|zip'),
      3,
      () => true,
    ) ||
    words.some((word, position) => {
      if (!['gps', 'coordinates', 'latitude', 'longitude'].includes(word)) return false;
      return coordinateAfter(literal, wordTokens, position, literalStart);
    })
  )
    hits.add('precise_address_or_location');
  const digitRuns = literal.match(/(?<![0-9])[0-9](?:[ -]*[0-9]){11,33}(?![ -]*[0-9])/g) ?? [];
  const cardRuns = literal.match(/(?<![0-9])[0-9](?:[ -]*[0-9]){12,18}(?![ -]*[0-9])/g) ?? [];
  if (
    digitRuns.length ||
    cardRuns.some((run) => luhn(run.replace(/[ -]/g, ''))) ||
    (literal.match(/\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/g) ?? []).some(iban) ||
    valueAfter(
      words,
      phrases('account|account number|sort code|routing number|card number|iban'),
      3,
      (word) => /[0-9]/.test(word) && /^[a-z0-9]+$/.test(word),
    )
  )
    hits.add('financial_or_account');
  if (includes(words, health)) hits.add('health_or_medical');
  if (includes(words, religion)) hits.add('religion');
  if (includes(words, sexuality)) hits.add('sexual_orientation_or_gender_identity');
  if (
    includes(
      words,
      phrases(
        'my political affiliation|my political views|my political party|i vote for|i voted for',
      ),
    ) ||
    words.some((_, start) =>
      phrases('i am a member of|i work for').some(
        (prefix) =>
          at(words, prefix, start) &&
          parties.some((party) =>
            at(
              words,
              party,
              start + prefix.length + (words[start + prefix.length] === 'the' ? 1 : 0),
            ),
          ),
      ),
    )
  )
    hits.add('political_affiliation');
  if (
    words.some((_, start) =>
      phrases('i am|i identify as|my race is|my ethnicity is').some(
        (prefix) =>
          at(words, prefix, start) &&
          [0, 1, 2].some((gap) =>
            races.some((race) => at(words, race, start + prefix.length + gap)),
          ),
      ),
    )
  )
    hits.add('race_or_ethnicity_self_identification');
  return sensitivityCodes.filter((code) => hits.has(code));
}

/** Recompile mechanical and framing observations from owned source DATA; no authority or acceptance. */
export function compileAutonomousPersonalFramingV1(input: unknown): AutonomousPersonalFramingV1 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<AutonomousSourceGeometryInputV3>(
      input,
      'beginRequest',
    );
    const { geometry, mappedHumanBody } = compileAutonomousSourceGeometryV3(owned);
    const scan = compileAutonomousPersonalSourceScanV1(owned);
    const report: AutonomousPersonalFramingV1 = {
      version: 1,
      scannerVersion: 1,
      unicodeVersion: '16.0.0',
      rawContentHash: scan.rawContentHash,
      mappedContentHash: scan.mappedContentHash,
      geometryHash: scan.geometryHash,
      sourceScanHash: hashAutomaticCaptureV2({
        domain: 'engram-autonomous-source-scan-v1',
        sourceScan: scan,
      }),
      scanStatus: scan.status,
      scanFailureCode:
        scan.status === 'complete'
          ? null
          : scan.status === 'indeterminate'
            ? scan.coverage.indeterminateSpan!.reasonCode
            : scan.resourceReason!.kind,
      sourceScopeFindings: [],
      units: [],
    };
    if (
      geometry.rawContentHash !== scan.rawContentHash ||
      geometry.mappedContentHash !== scan.mappedContentHash ||
      geometry.mappedUtf16Length !== scan.mappedUtf16Length ||
      hashAutonomousSourceGeometryV3(geometry) !== scan.geometryHash
    )
      throw invalid();
    if (scan.status !== 'complete') return parseOwned(report);
    const body = mappedHumanBody;
    if (body !== owned.rawContent.slice(scan.rawHumanRegion.start, scan.rawHumanRegion.end))
      throw invalid();
    const tokens = tokenizeMappedBody(body);
    if (!tokens || tokens.length !== scan.tokenCount) throw invalid();
    const findings = new Map<Finding['code'], Finding>();
    const addFinding = (code: Finding['code'], unitIndex: number) => {
      if (!findings.has(code))
        findings.set(code, {
          code,
          fromUnitIndex: unitIndex,
          scope:
            code === 'retroactive_frame' || code === 'ambiguous_retroactive_frame'
              ? 'whole_source'
              : 'unit_through_eof',
        });
    };
    for (const unit of scan.units) {
      const local = tokens.slice(unit.tokenSpan.start, unit.tokenSpan.end);
      const wordTokens = local.filter((token) => token.kind === 'word');
      const words = wordTokens.map((token) => lower(body.slice(token.start, token.end)));
      const literal = body.slice(unit.mappedSpan.start, unit.mappedSpan.end);
      const surface = head(body, local, words, wordTokens);
      const observations = new Set<Unit['observationCodes'][number]>();
      if (unit.boundaryCode === 'question') observations.add('question_terminal');
      if (unit.observedCueCodes.includes('explicit_geometry_quote_overlap'))
        observations.add('geometry_quote_overlap');
      if (unit.observedCueCodes.includes('paired_text_quote_overlap'))
        observations.add('paired_text_quote_overlap');
      if (reportComplement(words, surface.wordStart)) observations.add('report_complement');
      if (
        surface.wordStart !== null &&
        words[surface.wordStart] === 'i' &&
        ['want', 'need', 'ask', 'tell', 'instruct', 'request'].includes(
          words[surface.wordStart + 1],
        ) &&
        at(words, ['you', 'to'], surface.wordStart + 2)
      )
        observations.add('instruction_memory_pattern');
      if (includes(words, uncertainty)) observations.add('conditional_uncertainty_token');
      if (neutral.test(lower(literal))) observations.add('neutral_greeting_shape');
      const header = local[0]?.kind === 'word' ? headerEnd(words) : null;
      if (header !== null) {
        const ending = wordTokens[header];
        const next = local.find((token) => token.start >= ending.end);
        addFinding(
          next?.codePoint === 0x3a || next?.codePoint === 0x2c
            ? 'report_example_header'
            : 'ambiguous_report_example_prefix',
          unit.index,
        );
      }
      if (includes(words, retroactive)) addFinding('retroactive_frame', unit.index);
      else if (
        words.some((_, start) =>
          phrases('that was|it was|i was').some(
            (prefix) =>
              at(words, prefix, start) &&
              words.slice(start + prefix.length).some((word) => retroWords.has(word)),
          ),
        )
      )
        addFinding('ambiguous_retroactive_frame', unit.index);
      report.units.push({
        unitIndex: unit.index,
        headCode: surface.code,
        observationCodes: observationCodes.filter((code) => observations.has(code)),
        sensitivityCodes: sensitivity(literal, words, wordTokens, unit.mappedSpan.start),
      });
    }
    report.sourceScopeFindings = [...findings.values()].sort(
      (left, right) =>
        left.fromUnitIndex - right.fromUnitIndex ||
        scopeCodes.indexOf(left.code) - scopeCodes.indexOf(right.code),
    );
    return parseOwned(report);
  } catch {
    throw invalid();
  }
}
