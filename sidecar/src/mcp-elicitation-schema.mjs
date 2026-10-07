// Shared by the bridge and the form UI. Unknown constraints fail closed.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const safeKey = k => !['__proto__', 'constructor', 'prototype'].includes(k);
const keys = (v, allowed) => Object.keys(v).every(k => allowed.includes(k));
const text = v => typeof v === 'string' && v.length <= 12000;
const optionalText = v => v == null || text(v);
const bound = v => v == null || (Number.isSafeInteger(v) && v >= 0 && v <= 10000);
const finite = v => v == null || (typeof v === 'number' && Number.isFinite(v));
const optionsValid = a => Array.isArray(a) && a.length > 0 && a.length <= 100 &&
  a.every(o => object(o) && keys(o, ['const', 'title']) && text(o.const) && text(o.title)) &&
  new Set(a.map(o => o.const)).size === a.length;
const enumValid = a => Array.isArray(a) && a.length > 0 && a.length <= 100 && a.every(text) && new Set(a).size === a.length;

export function parseElicitationSchema(schema) {
  if (!object(schema) || JSON.stringify(schema).length > 32000 || schema.type !== 'object' ||
      !keys(schema, ['$schema', 'type', 'properties', 'required', 'additionalProperties', 'title', 'description']) ||
      !optionalText(schema.title) || !optionalText(schema.description) ||
      (schema.additionalProperties != null && schema.additionalProperties !== false) || !object(schema.properties)) return null;
  const names = Object.keys(schema.properties);
  const required = schema.required ?? [];
  if (names.length > 32 || !names.every(k => safeKey(k) && k.length <= 200) ||
      !Array.isArray(required) || !required.every(k => names.includes(k)) || new Set(required).size !== required.length) return null;
  const fields = [];
  for (const name of names) {
    const s = schema.properties[name];
    if (!object(s) || !optionalText(s.title) || !optionalText(s.description)) return null;
    const base = ['type', 'title', 'description', 'default'];
    let options;
    if (s.type === 'boolean') {
      if (!keys(s, base)) return null;
    } else if (s.type === 'number' || s.type === 'integer') {
      if (!keys(s, [...base, 'minimum', 'maximum']) || !finite(s.minimum) || !finite(s.maximum) ||
          (s.minimum != null && s.maximum != null && s.minimum > s.maximum)) return null;
    } else if (s.type === 'string') {
      if (!keys(s, [...base, 'minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf']) ||
          !bound(s.minLength) || !bound(s.maxLength) || (s.minLength != null && s.maxLength != null && s.minLength > s.maxLength) ||
          (s.format != null && !['email', 'uri', 'date', 'date-time'].includes(s.format))) return null;
      if (s.enum != null) {
        if (!enumValid(s.enum) || s.oneOf != null || (s.enumNames != null &&
            (!Array.isArray(s.enumNames) || s.enumNames.length !== s.enum.length || !s.enumNames.every(text)))) return null;
        options = s.enum.map((v, i) => ({ value: v, label: s.enumNames?.[i] ?? v }));
      } else if (s.oneOf != null) {
        if (!optionsValid(s.oneOf) || s.enumNames != null) return null;
        options = s.oneOf.map(o => ({ value: o.const, label: o.title }));
      } else if (s.enumNames != null) return null;
    } else if (s.type === 'array') {
      if (!keys(s, [...base, 'items', 'minItems', 'maxItems']) || !bound(s.minItems) || !bound(s.maxItems) ||
          (s.minItems != null && s.maxItems != null && s.minItems > s.maxItems) || !object(s.items)) return null;
      if (keys(s.items, ['type', 'enum']) && s.items.type === 'string' && enumValid(s.items.enum)) {
        options = s.items.enum.map(v => ({ value: v, label: v }));
      } else if (keys(s.items, ['anyOf']) && optionsValid(s.items.anyOf)) {
        options = s.items.anyOf.map(o => ({ value: o.const, label: o.title }));
      } else return null;
    } else return null;
    // Deliberately omit defaults: opening a form must never pre-authorize it.
    const { default: ignored, ...constraints } = s;
    fields.push({ ...constraints, name, required: required.includes(name), options });
  }
  return fields;
}

export function validateElicitationContent(schema, content) {
  const fields = parseElicitationSchema(schema);
  if (!fields || !object(content) || JSON.stringify(content).length > 32000 ||
      !Object.keys(content).every(k => safeKey(k) && fields.some(f => f.name === k))) return false;
  for (const f of fields) {
    if (!own(content, f.name)) { if (f.required) return false; else continue; }
    const v = content[f.name];
    if (f.type === 'boolean') { if (typeof v !== 'boolean') return false; }
    else if (f.type === 'number' || f.type === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (f.type === 'integer' && !Number.isSafeInteger(v)) ||
          (f.minimum != null && v < f.minimum) || (f.maximum != null && v > f.maximum)) return false;
    } else if (f.type === 'string') {
      if (!text(v) || (f.minLength != null && [...v].length < f.minLength) ||
          (f.maxLength != null && [...v].length > f.maxLength) || (f.options && !f.options.some(o => o.value === v))) return false;
      if (f.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return false;
      if (f.format === 'uri') { try { new URL(v); } catch { return false; } }
      if (f.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)) return false;
      if (f.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v)))) return false;
    } else if (!Array.isArray(v) || new Set(v).size !== v.length ||
        !v.every(x => f.options.some(o => o.value === x)) ||
        (f.minItems != null && v.length < f.minItems) || (f.maxItems != null && v.length > f.maxItems)) return false;
  }
  return true;
}
