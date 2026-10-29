import { createHash } from 'crypto';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalFramingV1OwnedDataSchema as OwnedDataSchema,
  AutonomousPersonalFramingV1Schema as Schema,
  compileAutonomousPersonalFramingV1 as compile,
  type AutonomousPersonalFramingV1 as FramingReport,
} from '../../../src/schemas/AutonomousPersonalFramingV1.schema';
import {
  compileAutonomousPersonalSourceScanV1,
  type AutonomousPersonalSourceScanV1 as ScanReport,
} from '../../../src/schemas/AutonomousPersonalSourceScanV1.schema';
import {
  compileAutonomousSourceGeometryV3,
  type AutonomousSourceGeometryInputV3,
} from '../../../src/schemas/AutonomousSourceGeometryV3.schema';

const invalidCode = 'invalid_autonomous_framing_data';
const sensitivityOrder = [
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
];

const makeInput = (
  rawContent: string,
  mapping: AutonomousSourceGeometryInputV3['mapping'] = { mode: 'full_body' },
  quoteRegions: AutonomousSourceGeometryInputV3['quoteRegions'] = [],
): AutonomousSourceGeometryInputV3 => ({ rawContent, mapping, quoteRegions });

function fixedFailure(error: unknown, sentinel = 'private-source-sentinel'): void {
  expect(error).toMatchObject({
    issues: [{ code: 'custom', path: [], message: invalidCode }],
  });
  const value = error as { issues: Array<{ path: unknown[]; message: string }> };
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(value.issues)).toBe(true);
  expect(Object.isFrozen(value.issues[0])).toBe(true);
  expect(Object.isFrozen(value.issues[0]?.path)).toBe(true);
  expect(JSON.stringify(value.issues)).not.toContain(sentinel);
}

function expectCompileFailure(value: unknown, sentinel?: string): void {
  let caught: unknown;
  try {
    compile(value);
  } catch (error) {
    caught = error;
  }
  fixedFailure(caught, sentinel);
}

function expectFacadeFailure(value: unknown, sentinel?: string): void {
  let caught: unknown;
  try {
    Schema.parse(value);
  } catch (error) {
    caught = error;
  }
  fixedFailure(caught, sentinel);
  const result = Schema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) fixedFailure(result.error, sentinel);
}

function deepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) deepFrozen(child);
}

function compileRaw(
  rawContent: string,
  mapping?: AutonomousSourceGeometryInputV3['mapping'],
  quoteRegions?: AutonomousSourceGeometryInputV3['quoteRegions'],
): FramingReport {
  return compile(makeInput(rawContent, mapping, quoteRegions));
}

function expectHead(
  rawContent: string,
  headCode: FramingReport['units'][number]['headCode'],
): void {
  const report = compileRaw(rawContent);
  expect(report.scanStatus).toBe('complete');
  expect(report.units[0]?.headCode).toBe(headCode);
}

function expectSensitivity(rawContent: string, family: string): void {
  const report = compileRaw(rawContent);
  expect(report.scanStatus).toBe('complete');
  expect(report.units).toHaveLength(1);
  expect(report.units[0]?.sensitivityCodes).toContain(family);
}

function measureJsonShape(value: unknown): { bytes: number; nodes: number; depth: number } {
  const visit = (item: unknown, depth: number): { nodes: number; depth: number } => {
    if (item === null || typeof item !== 'object') return { nodes: 1, depth };
    const keys = Reflect.ownKeys(item);
    let nodes = 1 + keys.length;
    let maxDepth = depth;
    for (const key of keys) {
      const child = visit((item as Record<PropertyKey, unknown>)[key], depth + 1);
      nodes += child.nodes;
      maxDepth = Math.max(maxDepth, child.depth);
    }
    return { nodes, depth: maxDepth };
  };
  const shape = visit(value, 0);
  return { bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'), ...shape };
}

describe('autonomous framing v1 is bounded source-owned DATA', () => {
  test('recomputes geometry and scan hashes and aligns every report row to actual complete scan units', () => {
    const rawContent = '😀 wrapper: I adore jazz. I’m working as a “carpenter”. suffix';
    const body = 'I adore jazz. I’m working as a “carpenter”.';
    const start = rawContent.indexOf(body);
    const quoteStart = body.indexOf('“');
    const input = makeInput(
      rawContent,
      {
        mode: 'application_region',
        humanRegion: { start, end: start + body.length },
        applicationWrapper: { configurationFingerprint: 'a'.repeat(64) },
      },
      [{ start: quoteStart, end: quoteStart + '“carpenter”'.length }],
    );
    const report = compile(input);
    const geometry = compileAutonomousSourceGeometryV3(input);
    const scan: ScanReport = compileAutonomousPersonalSourceScanV1(input);

    expect(report).toMatchObject({
      version: 1,
      scannerVersion: 1,
      unicodeVersion: '16.0.0',
      rawContentHash: scan.rawContentHash,
      mappedContentHash: scan.mappedContentHash,
      geometryHash: geometry.geometryHash,
      scanStatus: 'complete',
      scanFailureCode: null,
    });
    expect(report.sourceScanHash).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-source-scan-v1',
        sourceScan: scan,
      }),
    );
    expect(report.rawContentHash).not.toBe(report.mappedContentHash);
    expect(report.units.map((unit) => unit.unitIndex)).toEqual(
      scan.units.map((unit) => unit.index),
    );
    expect(report.units.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    expect(report.units[0]?.headCode).toBe('direct_i');
    expect(report.units[1]?.headCode).toBe('contracted_i_am');
    expect(report.units[1]?.observationCodes).toContain('geometry_quote_overlap');
    expect(report.units[1]?.observationCodes).toContain('paired_text_quote_overlap');
    expect(Object.keys(report).sort()).toEqual(
      [
        'version',
        'scannerVersion',
        'unicodeVersion',
        'rawContentHash',
        'mappedContentHash',
        'geometryHash',
        'sourceScanHash',
        'scanStatus',
        'scanFailureCode',
        'sourceScopeFindings',
        'units',
      ].sort(),
    );

    const full = compileRaw('same body.');
    const fullScan = compileAutonomousPersonalSourceScanV1(makeInput('same body.'));
    expect(full.rawContentHash).toBe(full.mappedContentHash);
    expect(full.sourceScanHash).toBe(
      hashAutomaticCaptureV2({
        domain: 'engram-autonomous-source-scan-v1',
        sourceScan: fullScan,
      }),
    );
    const empty = compileRaw('');
    expect(empty).toMatchObject({ scanStatus: 'complete', scanFailureCode: null, units: [] });
    expect(empty.sourceScopeFindings).toEqual([]);
    expect(compileRaw(' \t\n')).toMatchObject({
      scanStatus: 'complete',
      scanFailureCode: null,
      units: [],
      sourceScopeFindings: [],
    });
  });

  test('keeps open predicates open and reports exact direct, contracted, prefixed, unsupported, and incomplete heads', () => {
    for (const source of [
      'I adore jazz.',
      'I read novels.',
      'I work as a zorbologist.',
      'I sing.',
      'I bring.',
      'I want to dance.',
    ])
      expectHead(source, 'direct_i');

    expectHead("I'm working as a carpenter.", 'contracted_i_am');
    expectHead('I’m working as a carpenter.', 'contracted_i_am');
    expectHead("I've read novels.", 'contracted_i_have');
    expectHead('I’ve read novels.', 'contracted_i_have');
    expectHead('Remember this: I adore jazz.', 'remember_prefix_i');
    expectHead("Remember this: I'm working.", 'remember_prefix_i_am');
    expectHead('Remember this:\tI’ve read novels.', 'remember_prefix_i_have');
    expectHead("I'll work as a zorbologist.", 'unsupported_i_contraction');
    expectHead('I’ll work as a zorbologist.', 'unsupported_i_contraction');
    expectHead("I'd work as a zorbologist.", 'unsupported_i_contraction');
    expectHead('I’d work as a zorbologist.', 'unsupported_i_contraction');

    for (const source of ['I.', 'I to dance.', "I'm.", "I've.", 'I am.', 'I @.'])
      expectHead(source, 'incomplete_i_head');
    expectHead('Context first. I enjoy pottery.', 'no_supported_head');
    expectHead(' Remember this: I adore jazz.', 'no_supported_head');
    expectHead('Remember this:I adore jazz.', 'no_supported_head');
    expectHead('Hi, I enjoy pottery.', 'no_supported_head');
  });

  test('reports source-scope headers at their matching unit and preserves separate prior units', () => {
    const source = 'I enjoy jazz. Example: I like tea. Later, I prefer coffee.';
    const report = compileRaw(source);
    expect(report.units.map((unit) => unit.unitIndex)).toEqual([0, 1, 2]);
    expect(report.sourceScopeFindings).toEqual([
      { code: 'report_example_header', fromUnitIndex: 1, scope: 'unit_through_eof' },
    ]);

    const fixedHeaders = [
      'For example,',
      'As an example:',
      'Here is an example:',
      "Here's an example:",
      'Here is what follows:',
      "Here's what follows:",
      'Example:',
      'Quote:',
      'Quoted:',
      'Report:',
      'Reported:',
      'Hypothetical:',
      'Pretend:',
      'Suppose:',
      'According to:',
    ];
    for (const header of fixedHeaders) {
      const result = compileRaw(`${header} I enjoy jazz.`);
      expect(result.sourceScopeFindings).toEqual([
        { code: 'report_example_header', fromUnitIndex: 0, scope: 'unit_through_eof' },
      ]);
    }

    const attributionHeaders = [
      'Here is what someone said:',
      "Here's what she told,",
      'Someone said:',
      'Somebody wrote:',
      'They told:',
      'He said:',
      'She wrote:',
      'My manager said:',
      'A project partner told:',
      'An old friend wrote:',
      'The head of marketing said:',
    ];
    for (const header of attributionHeaders) {
      const result = compileRaw(`${header} I work remotely.`);
      expect(result.sourceScopeFindings).toEqual([
        { code: 'report_example_header', fromUnitIndex: 0, scope: 'unit_through_eof' },
      ]);
    }

    for (const sourcePrefix of [
      'Example I enjoy jazz.',
      'My manager said I work remotely.',
      'Here is what someone said I work remotely.',
    ]) {
      const result = compileRaw(sourcePrefix);
      expect(result.sourceScopeFindings).toEqual([
        { code: 'ambiguous_report_example_prefix', fromUnitIndex: 0, scope: 'unit_through_eof' },
      ]);
    }
    expect(compileRaw('Examples: I enjoy jazz.').sourceScopeFindings).toEqual([]);
    expect(compileRaw('The said: I enjoy jazz.').sourceScopeFindings).toEqual([]);
  });

  test('marks only the closed report-complement production and never extracts an inner clause', () => {
    expect(compileRaw('I read novels.').units[0]?.observationCodes).not.toContain(
      'report_complement',
    );
    for (const source of [
      'I read that I work for Acme.',
      'I heard I have a new role.',
      'I heard from my manager that I have a new role.',
      'I read in a book that I work for Acme.',
      'I found out, that she prefers tea.',
      'Remember this: I read that I prefer tea.',
    ]) {
      const report = compileRaw(source);
      expect(report.units).toHaveLength(1);
      expect(report.units[0]?.observationCodes).toContain('report_complement');
      expect(report.units[0]?.headCode).toMatch(/^(direct_i|remember_prefix_i)$/u);
    }
    expect(compileRaw('I have read many novels.').units[0]?.observationCodes).not.toContain(
      'report_complement',
    );
  });

  test('emits retroactive and ambiguous whole-source findings with the actual matching unit index', () => {
    const complete = [
      'that was a quote',
      'that was a quotation',
      'that was an example',
      'that was a hypothetical',
      'that was just a quote',
      'that was only a quotation',
      'that was just an example',
      'that was only a hypothetical',
      'I was pretending',
      'I was quoting',
      'I was joking',
      'I was kidding',
      'I was just pretending',
      'I was only quoting',
      'I was just joking',
      'I was only kidding',
      'that was just pretend',
      'that was only pretend',
    ];
    for (const phrase of complete) {
      const report = compileRaw(`I like tea. ${phrase}.`);
      expect(report.sourceScopeFindings).toContainEqual({
        code: 'retroactive_frame',
        fromUnitIndex: 1,
        scope: 'whole_source',
      });
      expect(report.units.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    }
    expect(compileRaw('That was, only a quote.').sourceScopeFindings).toContainEqual({
      code: 'retroactive_frame',
      fromUnitIndex: 0,
      scope: 'whole_source',
    });
    for (const phrase of [
      'That was a confusing quote.',
      'It was actually an example.',
      'I was probably joking.',
    ])
      expect(compileRaw(phrase).sourceScopeFindings).toContainEqual({
        code: 'ambiguous_retroactive_frame',
        fromUnitIndex: 0,
        scope: 'whole_source',
      });
  });

  test('derives finite per-unit observations for questions, quote geometry, quote text, instructions, uncertainty, and greetings', () => {
    const body = 'I prefer “jazz” maybe?';
    const report = compileRaw(body, { mode: 'full_body' }, [
      { start: body.indexOf('jazz'), end: body.indexOf('jazz') + 4 },
    ]);
    expect(report.units[0]?.observationCodes).toEqual([
      'question_terminal',
      'geometry_quote_overlap',
      'paired_text_quote_overlap',
      'conditional_uncertainty_token',
    ]);

    expect(compileRaw('I want you to remember I like tea.').units[0]?.observationCodes).toContain(
      'instruction_memory_pattern',
    );
    for (const cue of [
      'if',
      'unless',
      'provided',
      'assuming',
      'supposing',
      'hypothetically',
      'maybe',
      'perhaps',
      'may',
      'might',
      'could',
      'would',
      'when',
      'whenever',
      'while',
      'wonder',
      'possibly',
      'probably',
      'guess',
      'seem',
      'seems',
      'seemed',
      'as if',
      'in case',
      'as long as',
      'on condition',
      'were to',
      'I think',
      'I believe',
      'I suppose',
      'I expect',
    ])
      expect(compileRaw(`I enjoy ${cue} music.`).units[0]?.observationCodes).toContain(
        'conditional_uncertainty_token',
      );
    expect(compileRaw('I enjoy as, if the music starts.').units[0]?.observationCodes).toContain(
      'conditional_uncertainty_token',
    );
    expect(compileRaw('I enjoy adjacent jazz.').units[0]?.observationCodes).not.toContain(
      'conditional_uncertainty_token',
    );

    const greetings = [
      'Hi',
      'Hello',
      'Hey',
      'Thanks',
      'Thank you',
      'Okay',
      'OK',
      'Good morning',
      'Good afternoon',
      'Good evening',
    ];
    for (const greeting of greetings) {
      for (const ending of ['', '.', '!']) {
        expect(compileRaw(`${greeting}${ending}`).units[0]?.observationCodes).toContain(
          'neutral_greeting_shape',
        );
      }
    }
    expect(compileRaw('HI! I enjoy pottery.').units.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    expect(compileRaw('HI! I enjoy pottery.').units[0]?.observationCodes).toEqual([
      'neutral_greeting_shape',
    ]);
    expect(compileRaw('Hi there!').units[0]?.observationCodes).not.toContain(
      'neutral_greeting_shape',
    );
    expect(compileRaw('Hi, I enjoy pottery.').units).toHaveLength(1);
    expect(compileRaw('Hi, I enjoy pottery.').units[0]?.headCode).toBe('no_supported_head');
  });

  test('reports all bounded sensitivity families and the documented false positives and negatives', () => {
    const combined = compileRaw(
      'I enjoy API-key design, alice@example.com, +1 (212) 555-1212, 221 Baker Street, 4111 1111 1111 1111, HIV care, Catholic music, bisexual characters, I work for the Green Party, and I identify as Asian.',
    );
    expect(combined.units[0]?.sensitivityCodes).toEqual(sensitivityOrder);

    const credentials = [
      'password',
      'passcode',
      'passphrase',
      'api key',
      'client secret',
      'secret key',
      'access token',
      'refresh token',
      'private key',
      'authorization',
      'bearer token',
      'recovery code',
      'one-time code',
    ];
    for (const label of credentials)
      expectSensitivity(`I mention ${label} here.`, 'credential_label');
    for (const pem of [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ])
      expectSensitivity(`I see ${pem} text`, 'credential_label');
    expectSensitivity('I mention authorization:ABCDEFGH.', 'credential_label');

    const healthTerms = [
      'aids',
      'adhd',
      "alzheimer's",
      'anxiety',
      'asthma',
      'autism',
      'autistic',
      'bipolar',
      'cancer',
      'chemotherapy',
      'chronic pain',
      'depression',
      'diabetes',
      'disabled',
      'disability',
      'epilepsy',
      'hiv',
      'insulin',
      'leukemia',
      'lupus',
      'medication',
      'multiple sclerosis',
      "parkinson's",
      'prescription',
      'ptsd',
      'schizophrenia',
      'stroke',
    ];
    for (const term of healthTerms) expectSensitivity(`I study ${term}.`, 'health_or_medical');
    const religionTerms = [
      'agnostic',
      'atheist',
      'buddhist',
      'buddhism',
      'catholic',
      'christian',
      'hindu',
      'hinduism',
      'islam',
      'jewish',
      'judaism',
      'mormon',
      'muslim',
      'pagan',
      'protestant',
      'sikh',
      'sikhism',
      'taoist',
      'taoism',
      'wiccan',
    ];
    for (const term of religionTerms) expectSensitivity(`I study ${term} music.`, 'religion');
    const sexualityTerms = [
      'asexual',
      'bisexual',
      'gay',
      'intersex',
      'lesbian',
      'nonbinary',
      'pansexual',
      'queer',
      'transgender',
    ];
    for (const term of sexualityTerms)
      expectSensitivity(
        `I write about ${term} characters.`,
        'sexual_orientation_or_gender_identity',
      );

    const parties = [
      'Democratic Party',
      'Republican Party',
      'Labour Party',
      'Conservative Party',
      'Green Party',
      'Liberal Democrats',
      'SNP',
      'Plaid Cymru',
      'Socialist Party',
      'Communist Party',
      'Libertarian Party',
    ];
    for (const party of parties)
      expectSensitivity(`I work for the ${party}.`, 'political_affiliation');
    for (const phrase of [
      'my political affiliation',
      'my political views',
      'my political party',
      'I vote for',
      'I voted for',
    ])
      expectSensitivity(`I think about ${phrase} choices.`, 'political_affiliation');

    const identityPhrases = [
      'I am African American',
      'I identify as Arab',
      'I identify as Asian',
      'I am Black',
      'I am biracial',
      'I am Indigenous',
      'I am Latino',
      'I am Latina',
      'I am Latine',
      'I am Middle Eastern',
      'I am Native American',
      'I am White',
      'my race is mixed race',
      'my ethnicity is Hispanic',
    ];
    for (const phrase of identityPhrases)
      expectSensitivity(
        `${phrase} in this fictional story.`,
        'race_or_ethnicity_self_identification',
      );

    const streetTypes = [
      'street',
      'st',
      'road',
      'rd',
      'avenue',
      'ave',
      'boulevard',
      'blvd',
      'lane',
      'ln',
      'drive',
      'dr',
      'court',
      'ct',
      'place',
      'pl',
      'way',
    ];
    for (const street of streetTypes)
      expectSensitivity(`I map 12 Baker ${street}.`, 'precise_address_or_location');
    for (const label of [
      'home address',
      'street address',
      'mailing address',
      'postcode',
      'postal code',
      'zip',
    ])
      expectSensitivity(`I saved my ${label} N1 9GU.`, 'precise_address_or_location');
    for (const label of ['gps', 'coordinates', 'latitude', 'longitude'])
      expectSensitivity(`I logged ${label} 51.5, -0.1.`, 'precise_address_or_location');
    expectSensitivity('I logged coordinates -12.34 / +56.78.', 'precise_address_or_location');
    expectSensitivity('I logged longitude 12.34,56.78.', 'precise_address_or_location');
    const longNumeric = '9'.repeat(4_096);
    expect(
      compileRaw(`I logged gps ${longNumeric}, 51.5.`).units[0]?.sensitivityCodes,
    ).not.toContain('precise_address_or_location');

    expectSensitivity('I call +1 (212) 555-1212.', 'telephone');
    for (const label of ['phone', 'telephone', 'mobile', 'cell', 'tel'])
      expectSensitivity(`I recorded ${label} number 1234567890.`, 'telephone');
    expectSensitivity('I recorded phone 020 1234 5678.', 'telephone');
    expectSensitivity('I recorded telephone number 020-1234.5678.', 'telephone');
    expectSensitivity('I recorded mobile 1 2 3 4 5 6 7.', 'telephone');
    expectSensitivity('I recorded phone 020 unavailable 1234 567.', 'telephone');
    expectSensitivity('I recorded phone number office 02012345678.', 'telephone');
    expectSensitivity('I recorded phone 020 unavailable 1234567.', 'telephone');
    expectSensitivity('I recorded phone 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5.', 'telephone');
    expect(
      compileRaw('I recorded phone 020 unavailable 1234.').units[0]?.sensitivityCodes,
    ).not.toContain('telephone');
    expect(
      compileRaw('I recorded phone 12345678 12345678.').units[0]?.sensitivityCodes,
    ).not.toContain('telephone');
    expect(
      compileRaw('I recorded phone number office at 02012345678.').units[0]?.sensitivityCodes,
    ).not.toContain('telephone');
    expectSensitivity('I emailed alice@example.co.uk today.', 'email');

    expectSensitivity('I use a card with number 4111 1111 1111 1111.', 'financial_or_account');
    expectSensitivity('I use IBAN GB82WEST12345698765432.', 'financial_or_account');
    expectSensitivity('I received account number ABC123.', 'financial_or_account');
    expectSensitivity(`I received account ${'A'.repeat(2_048)}1.`, 'financial_or_account');
    expectSensitivity('I tracked shipment 123456789012.', 'financial_or_account');
    expect(compileRaw('I recorded account ABCD.').units[0]?.sensitivityCodes).not.toContain(
      'financial_or_account',
    );
    expect(compileRaw('I recorded account number ABCD.').units[0]?.sensitivityCodes).not.toContain(
      'financial_or_account',
    );

    expectSensitivity("I'm building an API-key rotation tool.", 'credential_label');
    expectSensitivity('I work on cancer research.', 'health_or_medical');
    expectSensitivity('I enjoy Christian music.', 'religion');
    expectSensitivity('I have diabetes.', 'health_or_medical');
    expectSensitivity('I work as an HIV clinic coordinator.', 'health_or_medical');
    expectSensitivity('I work for the Green Party.', 'political_affiliation');
    expectSensitivity('I can validate 4111 1111 1111 1111.', 'financial_or_account');
    expectSensitivity('I am based at 221 Baker Street, NW1 6XE.', 'precise_address_or_location');
    expectSensitivity('I am bisexual.', 'sexual_orientation_or_gender_identity');

    expect(compileRaw('I build keyframe animation tools.').units[0]?.sensitivityCodes).toEqual([]);
    expect(compileRaw('I work on the Party Planner app.').units[0]?.sensitivityCodes).toEqual([]);
    expect(compileRaw('I work with black coffee.').units[0]?.sensitivityCodes).toEqual([]);
    expect(compileRaw('I build a street map app.').units[0]?.sensitivityCodes).toEqual([]);
  });

  test('preserves Unicode source mechanics, whole-unit qualifiers, and mapping-only quote evidence', () => {
    const source = 'I prefer musique française and café, but I now sing 😀.';
    const report = compileRaw(source);
    expect(report.units).toHaveLength(1);
    expect(report.units[0]?.headCode).toBe('direct_i');
    expect(report.rawContentHash).toBe(report.mappedContentHash);
    expect(report.rawContentHash).toBe(createHash('sha256').update(source, 'utf8').digest('hex'));

    const quoteText = 'I like jazz.';
    const quoteInput = makeInput(quoteText, { mode: 'full_body' }, [
      { start: 0, end: quoteText.length },
    ]);
    expect(compile(quoteInput).units[0]?.observationCodes).toContain('geometry_quote_overlap');
    expect(compileRaw(quoteText).units[0]?.observationCodes).not.toContain(
      'geometry_quote_overlap',
    );
    expect(compileRaw('I like “jazz”.').units[0]?.observationCodes).toContain(
      'paired_text_quote_overlap',
    );
  });

  test('returns no framing prefix on indeterminate or resource-limited scans', () => {
    for (const [source, reason] of [
      ['I like jazz. “unclosed', 'unmatched_quote'],
      ['I like jazz. “unfinished"', 'mismatched_quote'],
      ['I like jazz. (unclosed', 'unmatched_bracket'],
      ['I like jazz. [unfinished)', 'mismatched_bracket'],
      [String.raw`I like jazz. \\"unfinished`, 'unsupported_quote_escape'],
      [`I like jazz. ${'('.repeat(9)}nested${')'.repeat(9)}`, 'nesting_limit'],
      ['I like jazz. The next is uncertain... maybe later.', 'ambiguous_period_boundary'],
    ] as const) {
      const report = compileRaw(source);
      expect(report.scanStatus).toBe('indeterminate');
      expect(report.scanFailureCode).toBe(reason);
      expect(report.units).toEqual([]);
      expect(report.sourceScopeFindings).toEqual([]);
    }

    const thirtyThreeUnits = Array.from({ length: 33 }, () => 'I enjoy jazz!').join(' ');
    const completeBeyondProviderLimit = compileRaw(thirtyThreeUnits);
    expect(completeBeyondProviderLimit.scanStatus).toBe('complete');
    expect(completeBeyondProviderLimit.units).toHaveLength(33);
    expect(completeBeyondProviderLimit.units.map((unit) => unit.unitIndex)).toEqual(
      Array.from({ length: 33 }, (_, index) => index),
    );
    for (const field of [
      'dispatch',
      'eligible',
      'accepted',
      'safe',
      'providerOutcome',
      'accounted',
    ])
      expect(completeBeyondProviderLimit).not.toHaveProperty(field);

    const oneHundredTwentyNineUnits = Array.from({ length: 129 }, () => 'I enjoy jazz.').join(' ');
    const tooManyUnits = compileRaw(oneHundredTwentyNineUnits);
    expect(tooManyUnits).toMatchObject({
      scanStatus: 'resource_limit',
      scanFailureCode: 'unit_limit',
      sourceScopeFindings: [],
      units: [],
    });

    const tooManyTokens = `I${' x'.repeat(8_191)}?`;
    const tokenLimit = compileRaw(tooManyTokens);
    expect(tokenLimit).toMatchObject({
      scanStatus: 'resource_limit',
      scanFailureCode: 'lexical_token_limit',
      sourceScopeFindings: [],
      units: [],
    });
  });

  test('measures a real 128-unit, 8,192-token report with dense observations and all sensitivity families under 64 KiB', () => {
    const families =
      'API-key alice@example.com +1 (212) 555-1212 221 Baker Street 4111 1111 1111 1111 HIV Catholic bisexual I work for the Green Party I identify as Asian';
    const repeatedBody = `I want you to remember maybe “quoted” ${families}`;
    const initialBodies = Array.from({ length: 128 }, (_, index) => {
      if (index === 0) return `Example: that was a quote “quoted” ${families}`;
      if (index === 1) return `My manager said I was actually quoting “quoted” ${families}`;
      if (index === 2)
        return `I read that I maybe ${repeatedBody.slice('I want you to remember maybe '.length)}`;
      return repeatedBody;
    });
    const initialRaw = initialBodies.map((body) => `${body}?`).join(' ');
    const quoteRegions = [{ start: 0, end: initialRaw.length }];
    const initialInput = makeInput(initialRaw, { mode: 'full_body' }, quoteRegions);
    const initialScan = compileAutonomousPersonalSourceScanV1(initialInput);
    expect(initialScan.status).toBe('complete');
    expect(initialScan.units).toHaveLength(128);
    const maxTokensPerUnit = Math.max(
      ...initialScan.units.map((unit) => unit.tokenSpan.end - unit.tokenSpan.start),
    );
    expect(maxTokensPerUnit).toBeLessThanOrEqual(64);
    const paddedBodies = initialBodies.map((body, unitIndex) => {
      const unit = initialScan.units[unitIndex];
      if (!unit) throw new Error('Synthetic max-report unit missing');
      const tokens = unit.tokenSpan.end - unit.tokenSpan.start;
      return `${body}${' x'.repeat(64 - tokens)}?`;
    });
    const unpaddedRawContent = paddedBodies.join(' ');
    const paddingBytes = 65_536 - Buffer.byteLength(unpaddedRawContent, 'utf8');
    const rawContent = `${unpaddedRawContent}${' '.repeat(paddingBytes)}`;
    const input = makeInput(rawContent, { mode: 'full_body' }, [
      { start: 0, end: rawContent.length },
    ]);
    const actualScan = compileAutonomousPersonalSourceScanV1(input);
    const report = compile(input);
    const reportShape = measureJsonShape(report);

    expect(actualScan.status).toBe('complete');
    expect(actualScan.units).toHaveLength(128);
    expect(actualScan.tokenCount).toBe(8_192);
    expect(Buffer.byteLength(rawContent, 'utf8')).toBe(65_536);
    expect(report.units).toHaveLength(128);
    expect(report.units.map((unit) => unit.unitIndex)).toEqual(
      Array.from({ length: 128 }, (_, index) => index),
    );
    expect(report.sourceScopeFindings.map((finding) => finding.code)).toEqual([
      'report_example_header',
      'retroactive_frame',
      'ambiguous_report_example_prefix',
      'ambiguous_retroactive_frame',
    ]);
    expect(report.units[0]?.observationCodes).toContain('geometry_quote_overlap');
    expect(report.units[2]?.observationCodes).toContain('report_complement');
    expect(report.units[3]?.observationCodes).toContain('instruction_memory_pattern');
    expect(report.units[3]?.sensitivityCodes).toEqual(sensitivityOrder);
    expect(reportShape.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(reportShape.nodes).toBeLessThan(16_384);
    expect(reportShape.depth).toBeLessThanOrEqual(8);
  });

  test('applies raw source and serialized report bounds before parsing and rejects all other compiler fields', () => {
    const maxRaw = 'x'.repeat(65_536);
    expect(compileRaw(maxRaw).scanStatus).toBe('complete');
    expectCompileFailure(makeInput('x'.repeat(65_537)), 'x');
    expectCompileFailure(makeInput('I\uD800.'), '\\ud800');
    expectCompileFailure({ ...makeInput('I enjoy jazz.'), scan: { units: [] } }, 'scan');
    expectCompileFailure(
      { ...makeInput('I enjoy jazz.'), provider: { risk: 'ordinary' } },
      'ordinary',
    );

    const report = compileRaw('I enjoy jazz.');
    const oversized = { ...report, extra: 'x'.repeat(65_536) };
    const parseSpy = jest.spyOn(OwnedDataSchema, 'parse');
    try {
      expectFacadeFailure(oversized, 'x'.repeat(8));
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  test('owns hostile raw values before property access and gives only fixed redacted failures', () => {
    const calls: string[] = [];
    const input = makeInput('private-source-sentinel');
    const getterInput = {
      ...input,
      get rawContent() {
        calls.push('rawContent');
        return 'private-source-sentinel';
      },
    };

    const fakeNameConstructor = function FakeConstructor(): void {};
    Object.defineProperty(fakeNameConstructor, 'name', {
      configurable: true,
      get() {
        calls.push('constructor.name');
        return 'Object';
      },
    });
    const fakePrototypeConstructor = () => undefined;
    Object.defineProperty(fakePrototypeConstructor, 'prototype', {
      configurable: true,
      get() {
        calls.push('constructor.prototype');
        return Object.prototype;
      },
    });
    const fakeConstructors = [fakeNameConstructor, fakePrototypeConstructor].map((constructor) => {
      const value = { ...input };
      Object.defineProperty(value, 'constructor', { value: constructor, enumerable: false });
      return value;
    });
    const nestedGetter = makeInput('private-source-sentinel');
    const nestedMapping = { mode: 'full_body' as const };
    Object.defineProperty(nestedMapping, 'mode', {
      enumerable: true,
      get() {
        calls.push('mapping.mode');
        return 'full_body';
      },
    });
    (nestedGetter as { mapping: unknown }).mapping = nestedMapping;
    const proxy = new Proxy(
      {},
      {
        get() {
          calls.push('proxy.get');
          return undefined;
        },
        ownKeys() {
          calls.push('proxy.ownKeys');
          return [];
        },
        getOwnPropertyDescriptor() {
          calls.push('proxy.descriptor');
          return undefined;
        },
        getPrototypeOf() {
          calls.push('proxy.prototype');
          return Object.prototype;
        },
      },
    );
    const nestedProxy = makeInput('private-source-sentinel');
    (nestedProxy as { quoteRegions: unknown }).quoteRegions = [proxy];
    const thenable = {
      ...input,
      get then() {
        calls.push('then');
        return () => undefined;
      },
    };
    const toJsonGetter = {
      ...input,
      get toJSON() {
        calls.push('toJSON');
        return () => input;
      },
    };
    const cyclic: Record<string, unknown> = { ...input };
    cyclic.cycle = cyclic;

    for (const hostile of [
      getterInput,
      ...fakeConstructors,
      nestedGetter,
      proxy,
      nestedProxy,
      thenable,
      toJsonGetter,
      cyclic,
    ]) {
      expectCompileFailure(hostile, 'private-source-sentinel');
      expectFacadeFailure(hostile, 'private-source-sentinel');
    }
    expect(calls).toEqual([]);
  });

  test('returns detached deeply frozen reports and strict redacted parser errors without I/O', () => {
    const input = makeInput('I enjoy jazz.', { mode: 'full_body' }, []);
    const first = compile(input);
    const second = compile(input);
    expect(second).toEqual(first);
    deepFrozen(first);
    expect(Schema.parse(first)).toEqual(first);
    const safe = Schema.safeParse(first);
    expect(safe.success).toBe(true);
    if (safe.success) deepFrozen(safe.data);

    input.quoteRegions.push({ start: 0, end: 1 });
    expect(first.units[0]?.observationCodes).toEqual([]);
    expect(() => first.units.push(first.units[0]!)).toThrow();

    const malformed = { ...first, surprise: 'private-source-sentinel' };
    expectFacadeFailure(malformed, 'private-source-sentinel');
    const malformedUnit = {
      ...first,
      units: [{ ...first.units[0], surprise: 'private-source-sentinel' }],
    };
    expectFacadeFailure(malformedUnit, 'private-source-sentinel');
    expectFacadeFailure({ ...first, scanStatus: 'indeterminate' }, 'private-source-sentinel');
    expectFacadeFailure(
      { ...first, units: [{ ...first.units[0], unitIndex: 2 }] },
      'private-source-sentinel',
    );
    expectFacadeFailure(
      {
        ...first,
        units: [
          {
            ...first.units[0],
            observationCodes: ['conditional_uncertainty_token', 'question_terminal'],
          },
        ],
      },
      'private-source-sentinel',
    );

    const originalFetch = globalThis.fetch;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected I/O');
    });
    try {
      compileRaw('I adore jazz.');
      Schema.parse(first);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (originalFetch === undefined) delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });
});
