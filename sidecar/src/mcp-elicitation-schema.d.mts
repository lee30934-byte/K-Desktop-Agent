export interface ElicitationField {
  name: string; type: 'string' | 'boolean' | 'number' | 'integer' | 'array'; required: boolean;
  title?: string; description?: string; options?: {value: string; label: string}[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; format?: string;
}
export function parseElicitationSchema(schema: unknown): ElicitationField[] | null;
export function validateElicitationContent(schema: unknown, content: unknown): boolean;
