// Pure logic (no StarUML API) so it can be tested with plain node.

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const lcfirst = s => s.charAt(0).toLowerCase() + s.slice(1)
const typeName = t => (typeof t === 'string' ? t : (t && t.name) || '')
const param = (name, attr) => ({ name, type: attr.type, multiplicity: attr.multiplicity })
// `?int`, or a multiplicity whose lower bound is 0 (0..1, 0..*, *)
const optional = attr => typeName(attr.type).startsWith('?') || /^(0|\*)/.test((attr.multiplicity || '').trim())

/**
 * Association ends that are properties of `cls`, as attribute-like objects typed `?Class`.
 * Arrows decide when present; an association without arrows is navigable both ways.
 * An unnamed role defaults to the class name (Adresse -> adresse).
 */
function associationFields (cls, associations) {
  const fields = []
  for (const assoc of associations) {
    const directed = assoc.end1.navigable === 'navigable' || assoc.end2.navigable === 'navigable'
    const navigable = end => end.navigable === 'navigable' || (!directed && end.navigable === 'unspecified')
    for (const [own, other] of [[assoc.end1, assoc.end2], [assoc.end2, assoc.end1]]) {
      if (own.reference !== cls || !navigable(other)) continue
      fields.push({
        name: other.name || lcfirst(typeName(other.reference)),
        // shortcut: plain string, so renaming the class won't update it; needed for the `?` prefix
        type: '?' + typeName(other.reference),
        multiplicity: '',
        isReadOnly: other.isReadOnly,
        isStatic: false
      })
    }
  }
  return fields
}

// Association fields not yet declared as attributes, deduped by name
function missingAttributes (attrs, fields) {
  const taken = new Set(attrs.map(a => a.name))
  const missing = []
  for (const f of fields) {
    if (!taken.has(f.name)) {
      taken.add(f.name)
      missing.push(f)
    }
  }
  return missing
}

/**
 * Plan operations for attributes. Names already in `existingNames` are skipped,
 * so running the command twice adds nothing.
 * Constructor takes every non-static, non-optional attribute.
 * @return {Array<{name: string, isStatic: boolean, atStart: boolean, params: Array<Object>}>}
 */
function planAccessors (attrs, existingNames, { ctor = false, getters = true, setters = true } = {}) {
  const taken = new Set(existingNames)
  const specs = []
  const add = spec => {
    if (!taken.has(spec.name)) {
      taken.add(spec.name)
      specs.push(spec)
    }
  }
  const fields = attrs
    .map(attr => ({ attr, base: (attr.name || '').replace(/^_+/, '') }))
    .filter(f => f.base)
  for (const { attr, base } of fields) {
    if (getters) {
      const prefix = /^\??bool(ean)?$/i.test(typeName(attr.type)) ? 'is' : 'get'
      add({
        name: prefix + cap(base),
        isStatic: !!attr.isStatic,
        atStart: false,
        params: [{ ...param('', attr), direction: 'return' }]
      })
    }
    if (setters && !attr.isReadOnly) {
      add({
        name: 'set' + cap(base),
        isStatic: !!attr.isStatic,
        atStart: false,
        params: [param(base, attr), { name: '', type: 'void', direction: 'return' }]
      })
    }
  }
  // Planned last: StarUML's fieldInsertAt(0) doesn't shift the indexes later fieldInsert calls compute
  if (ctor) {
    add({
      name: '__construct',
      isStatic: false,
      atStart: true,
      params: fields
        .filter(f => !f.attr.isStatic && !optional(f.attr))
        .map(f => param(f.base, f.attr))
    })
  }
  return specs
}

module.exports = { planAccessors, associationFields, missingAttributes }
