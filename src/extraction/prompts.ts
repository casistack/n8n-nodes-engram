/**
 * LLM prompt templates for entity and relationship extraction.
 * Inspired by Graphiti's extraction patterns.
 */

export const ENTITY_EXTRACTION_SYSTEM = [
  'You are an entity extraction system. Extract entities from the conversation.',
  '',
  'Rules:',
  '- Extract real-world entities mentioned: people, organizations, locations, concepts, events, products, etc.',
  '- Each entity needs: name (string), entity_type (string), summary (one sentence description)',
  '- Use consistent naming: proper nouns as-is, concepts in lowercase',
  '- entity_type should be one of the allowed types provided',
  '- confidence is required and must be a number from 0 to 1 indicating source support',
  '- Return ONLY valid JSON, no extra text',
  '',
  'Output format:',
  '{"entities": [{"name": "Alice", "entity_type": "person", "summary": "A software engineer", "confidence": 0.92}]}',
].join('\n');

export function entityExtractionUser(
  humanMessage: string,
  aiMessage: string,
  entityTypes: string[],
  existingEntities: string[],
): string {
  const typesStr = entityTypes.join(', ');
  const parts = [
    'Extract entities from this conversation turn.',
    '',
    'Allowed entity types: ' + typesStr,
  ];

  if (existingEntities.length > 0) {
    parts.push('Already known entities (avoid duplicates): ' + existingEntities.join(', '));
  }

  parts.push('', 'Human: ' + humanMessage, 'AI: ' + aiMessage);
  return parts.join('\n');
}

export function entityExtractionSourcesUser(
  formattedSources: string,
  entityTypes: string[],
  existingEntities: string[],
): string {
  const parts = [
    'Extract entities only from the selected source records below.',
    '',
    'Allowed entity types: ' + entityTypes.join(', '),
  ];

  if (existingEntities.length > 0) {
    parts.push('Already known entities (avoid duplicates): ' + existingEntities.join(', '));
  }

  parts.push('', formattedSources);
  return parts.join('\n');
}

export const RELATIONSHIP_EXTRACTION_SYSTEM = [
  'You are a relationship extraction system. Extract facts and relationships between entities.',
  '',
  'Rules:',
  '- Extract relationships as factual statements connecting two entities',
  '- source_entity and target_entity must be exact entity names from the provided list',
  '- name should be SCREAMING_SNAKE_CASE (e.g., WORKS_AT, LIVES_IN, KNOWS)',
  '- fact should be a natural language statement of the relationship',
  '- Only extract relationships where both entities exist in the provided list',
  '- confidence is required and must be a number from 0 to 1 indicating source support',
  '- Return ONLY valid JSON, no extra text',
  '',
  'Output format:',
  '{"relationships": [{"source_entity": "Alice", "target_entity": "Acme Corp", "name": "WORKS_AT", "fact": "Alice works at Acme Corp as a senior engineer", "confidence": 0.94}]}',
].join('\n');

export function relationshipExtractionUser(
  humanMessage: string,
  aiMessage: string,
  entities: string[],
): string {
  const parts = [
    'Extract relationships from this conversation turn.',
    '',
    'Available entities: ' + entities.join(', '),
    '',
    'Human: ' + humanMessage,
    'AI: ' + aiMessage,
  ];
  return parts.join('\n');
}

export function relationshipExtractionSourcesUser(
  formattedSources: string,
  entities: string[],
): string {
  return [
    'Extract relationships only from the selected source records below.',
    '',
    'Available entities: ' + entities.join(', '),
    '',
    formattedSources,
  ].join('\n');
}

export const DEDUPLICATION_SYSTEM = [
  'You are an entity deduplication system. Determine if two entities refer to the same real-world thing.',
  '',
  'Rules:',
  '- Consider name variations (Bob/Robert, NYC/New York City)',
  '- Consider context clues from summaries',
  '- Return ONLY valid JSON',
  '',
  'Output format:',
  '{"is_duplicate": true, "merged_summary": "Combined summary of both entities"}',
].join('\n');

export function deduplicationUser(
  entity1: { name: string; summary: string; entity_type: string },
  entity2: { name: string; summary: string; entity_type: string },
): string {
  const parts = [
    'Are these the same entity?',
    '',
    'Entity 1: ' + entity1.name + ' (' + entity1.entity_type + ') - ' + entity1.summary,
    'Entity 2: ' + entity2.name + ' (' + entity2.entity_type + ') - ' + entity2.summary,
  ];
  return parts.join('\n');
}

export const EDGE_DEDUP_SYSTEM = [
  'You are an edge deduplication system. Determine if a new fact about a relationship between two entities is a duplicate of an existing fact.',
  '',
  'Rules:',
  '- A duplicate means the new fact describes the same relationship, possibly with updated details',
  '- If duplicate, provide a merged_fact that keeps the most current and complete information',
  '- Example: "Alice works at Google as a senior engineer" and "Alice works at Google as VP of Engineering" are duplicates (same employment, role updated). merged_fact: "Alice works at Google as VP of Engineering"',
  '- Example: "Alice lives in London" and "Alice has a flat in London" are duplicates (same residency). merged_fact: "Alice lives in London and has a flat there"',
  '- Example: "Alice knows Python" and "Alice knows Java" are NOT duplicates (different skills)',
  '- Example: "Bob earns 120k" and "Bob earns 250k" are duplicates (same salary relationship, amount updated). merged_fact: "Bob earns 250k"',
  '- Return ONLY valid JSON',
  '',
  'Output format:',
  '{"is_duplicate": true, "merged_fact": "The most current and complete version of the fact"}',
].join('\n');

export function edgeDedupUser(
  existingFact: string,
  newFact: string,
  edgeName: string,
  sourceEntity: string,
  targetEntity: string,
): string {
  const parts = [
    'Is the new fact a duplicate of the existing fact?',
    '',
    'Entities: ' + sourceEntity + ' -> ' + targetEntity,
    'Relationship type: ' + edgeName,
    'Existing fact: ' + existingFact,
    'New fact: ' + newFact,
  ];
  return parts.join('\n');
}

export const CONTRADICTION_SYSTEM = [
  'You are a contradiction detection system. Determine if a new fact contradicts an existing fact between the same entities.',
  '',
  'Rules:',
  '- A contradiction means the new fact makes the old fact no longer true or no longer current',
  '- Consider the relationship types when provided. A change in relationship type between the same entities is a strong signal of contradiction.',
  '- Temporal/status changes count as contradictions: if someone WORKS_AT a place and a new fact says they WORKED_AT that place (past tense), the current employment is contradicted.',
  '- Example: "Alice lives in London" (LIVES_IN) contradicts "Alice lives in Tokyo" (LIVES_IN) — can only live in one place',
  '- Example: "Bob works at Google" (WORKS_AT) is contradicted by "Bob worked at Google before quitting" (WORKED_AT) — present-tense employment is no longer true',
  '- Example: "Alice knows Python" (KNOWS) does NOT contradict "Alice knows JavaScript" (KNOWS) — can know both',
  '- Example: "Alice manages Bob" (MANAGES) does NOT contradict "Alice mentors Bob" (MENTORS) — different coexisting relationships',
  '- When relationship types differ, ask: does the new relationship type imply the old one is no longer active?',
  '- Return ONLY valid JSON',
  '',
  'Output format:',
  '{"is_contradiction": true, "explanation": "The new fact about past employment replaces the current employment status"}',
].join('\n');

export function contradictionUser(
  existingFact: string,
  newFact: string,
  sourceEntity: string,
  targetEntity: string,
  existingEdgeName?: string,
  newEdgeName?: string,
): string {
  const parts = [
    'Does the new fact contradict the existing fact?',
    '',
    'Entities: ' + sourceEntity + ' -> ' + targetEntity,
  ];

  if (existingEdgeName) {
    parts.push('Existing relationship type: ' + existingEdgeName);
  }
  parts.push('Existing fact: ' + existingFact);

  if (newEdgeName) {
    parts.push('New relationship type: ' + newEdgeName);
  }
  parts.push('New fact: ' + newFact);

  return parts.join('\n');
}

export const CROSS_NAME_EDGE_DEDUP_SYSTEM = [
  'You are an edge deduplication system. Determine if two facts about the same entities describe the same underlying relationship, even though they use different relationship names.',
  '',
  'Rules:',
  '- Two edges are duplicates if they describe the SAME core relationship, even with different labels',
  '- Example: "WORKS_AT" and "EMPLOYED_BY" between Person->Company are duplicates (same employment relationship)',
  '- Example: "HAS_ROLE" and "HOLDS_POSITION" between Person->Company are duplicates (same position relationship)',
  '- Example: "WORKS_AT" and "MANAGES" between Person->Company are NOT duplicates (employment vs management are different relationships)',
  '- Example: "LIVES_IN" and "RESIDES_AT" between Person->City are duplicates (same residency relationship)',
  '- Example: "VISITED" and "LIVES_IN" between Person->City are NOT duplicates (visiting vs living are fundamentally different)',
  '- When in doubt, say NOT duplicate — it is safer to keep both edges than to incorrectly merge',
  '- If duplicate, provide a merged_fact combining the most complete and current information from both facts',
  '- Return ONLY valid JSON',
  '',
  'Output format:',
  '{"is_duplicate": true, "merged_fact": "The most current and complete version of the fact"}',
].join('\n');

export function crossNameEdgeDedupUser(
  existingFact: string,
  newFact: string,
  existingEdgeName: string,
  newEdgeName: string,
  sourceEntity: string,
  targetEntity: string,
): string {
  const parts = [
    'Are these two relationships about the same entities duplicates, despite having different names?',
    '',
    'Entities: ' + sourceEntity + ' -> ' + targetEntity,
    'Existing relationship: ' + existingEdgeName + ' — "' + existingFact + '"',
    'New relationship: ' + newEdgeName + ' — "' + newFact + '"',
  ];
  return parts.join('\n');
}
