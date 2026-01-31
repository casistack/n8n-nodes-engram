import { v4 as uuidv4 } from 'uuid';

export function generateUuid(): string {
  return uuidv4();
}

/**
 * Validates that a string is a valid UUID v4.
 */
export function isValidUuid(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}
