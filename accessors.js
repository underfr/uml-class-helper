// Pure logic (no StarUML API) so it can be tested with plain node.

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const lcfirst = s => s.charAt(0).toLowerCase() + s.slice(1)
const typeName = t => (typeof t === 'string' ? t : (t && t.name) || '')
const baseName = name => (name || '').replace(/^_+/, '') // _age -> age
const param = (name, attr) => ({ name, type: attr.type, multiplicity: attr.multiplicity })
// Left out of __construct: `?int`, or a multiplicity whose lower bound is 0 (0..1, 0..*, *)
const optional = attr => typeName(attr.type).startsWith('?') || /^(0|\*)/.test((attr.multiplicity || '').trim())

const isMany = end => {
  const upper = (end.multiplicity || '').split('..').pop().trim()
  return upper === '*' || Number(upper) > 1
}
const hasDiamond = end => !!end.aggregation && end.aggregation !== 'none'

// Whether the class at `own` holds a reference to the class at `other`
function holds (own, other) {
  if (other.navigable === 'notNavigable') return false
  if (own.navigable === 'navigable' || other.navigable === 'navigable') return other.navigable === 'navigable'
  // Aggregation/composition: the class on the diamond side holds the other one
  if (hasDiamond(own) || hasDiamond(other)) return hasDiamond(own)
  // Plain association: the "many" side holds the "one" side (Produit 0..* -- 1 Categorie)
  if (isMany(own) !== isMany(other)) return isMany(own)
  return true
}

/**
 * Attributes an association gives its classes: [{ holder, from: 'end1'|'end2', field }], `field` being
 * attribute-like and typed `array<Class>` when the held end is many (0..*, 1..*), `?Class` otherwise (1, 0..1).
 * Arrows first, then the diamond, then multiplicities decide; otherwise both sides.
 * An unnamed role defaults to the class name (Adresse -> adresse).
 */
function heldFields (assoc) {
  const held = []
  for (const [own, other, from] of [[assoc.end1, assoc.end2, 'end2'], [assoc.end2, assoc.end1, 'end1']]) {
    if (!holds(own, other)) continue
    held.push({
      holder: own.reference,
      from,
      field: {
        name: other.name || lcfirst(typeName(other.reference)),
        // Plain string (needed for `?`/`array<>`); renamedType keeps it in line when the class is renamed
        type: isMany(other) ? `array<${typeName(other.reference)}>` : '?' + typeName(other.reference),
        multiplicity: '',
        isReadOnly: other.isReadOnly,
        isStatic: false
      }
    })
  }
  return held
}

// Association ends that are properties of `cls`, as attribute-like objects
function associationFields (cls, associations) {
  return associations.flatMap(heldFields).filter(h => h.holder === cls).map(h => h.field)
}

/**
 * How the attributes generated from one association change after it was edited (role, multiplicity,
 * arrow, diamond, class at an end, class renamed). `before` is heldFields from before the edit, each with
 * the generated `attr` found then (or none); `after` is heldFields now.
 * Only an association already generated (one `attr` found) is touched.
 * @return {{updates: Array<{attr, next}>, deletes: Array<{attr}>, creates: Array<{holder, field}>}}
 */
function planAssocUpdate (before, after) {
  const plan = { updates: [], deletes: [], creates: [] }
  if (!before.some(b => b.attr)) return plan
  for (const b of before.filter(x => x.attr)) {
    const a = after.find(x => x.from === b.from && x.holder === b.holder)
    if (!a) {
      plan.deletes.push({ attr: b.attr })
    } else if (a.field.name !== b.field.name || a.field.type !== b.field.type) {
      plan.updates.push({ attr: b.attr, next: a.field })
    }
  }
  // New holder (moved arrow/diamond, changed multiplicity or end class); one the user emptied stays empty
  for (const a of after) {
    if (!before.some(b => b.from === a.from && b.holder === a.holder)) plan.creates.push({ holder: a.holder, field: a.field })
  }
  return plan
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
 * Constructor takes every non-static, non-optional attribute, the `inherited` ones (parents' attributes,
 * root first) before the class's own.
 * @return {Array<{name: string, isStatic: boolean, atStart: boolean, params: Array<Object>}>}
 */
function planAccessors (attrs, existingNames, { ctor = false, getters = true, setters = true } = {}, inherited = []) {
  const taken = new Set(existingNames)
  const specs = []
  const add = spec => {
    if (!taken.has(spec.name)) {
      taken.add(spec.name)
      specs.push(spec)
    }
  }
  const toFields = list => list
    .map(attr => ({ attr, base: baseName(attr.name) }))
    .filter(f => f.base)
  for (const { attr, base } of toFields(attrs)) {
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
      params: toFields([...inherited, ...attrs])
        .filter(f => !f.attr.isStatic && !optional(f.attr))
        .map(f => param(f.base, f.attr))
    })
  }
  return specs
}

/**
 * Generated operations of an attribute, found by naming convention among the class `ops`.
 */
function generatedFor (attr, ops) {
  const base = baseName(attr.name)
  const find = name => ops.find(o => o.name === name)
  const getter = base && (find('get' + cap(base)) || find('is' + cap(base)))
  const setter = base && find('set' + cap(base))
  const ctor = find('__construct')
  return {
    base,
    getter,
    setter,
    setterParam: setter && setter.parameters.find(p => p.direction !== 'return'),
    ctor,
    ctorParam: base && ctor && ctor.parameters.find(p => p.name === base)
  }
}

// Getter, setter and __construct param to delete along with an attribute
function deletedWith (attr, ops) {
  const g = generatedFor(attr, ops)
  return [g.getter, g.setter, g.ctorParam].filter(Boolean)
}

/**
 * Changes that keep generated operations in line with an edited attribute (name, type, multiplicity).
 * `attr` is the attribute now, `next` as it will be, `ops` the class operations, `attrNames` its attribute names in order.
 * @return {Array} {assign: elem, field, value} | {remove: param, from: op} | {add: param, to: op, index}
 */
function planSync (attr, next, ops, attrNames) {
  const g = generatedFor(attr, ops)
  const nextBase = baseName(next.name)
  if (!g.base || !nextBase) return []
  const changes = []
  const set = (elem, field, value) => {
    if (elem && elem[field] !== value) changes.push({ assign: elem, field, value })
  }
  const retype = p => {
    set(p, 'type', next.type)
    set(p, 'multiplicity', next.multiplicity)
  }
  if (g.getter) {
    set(g.getter, 'name', g.getter.name.slice(0, -g.base.length) + cap(nextBase)) // keeps get/is
    retype(g.getter.parameters.find(p => p.direction === 'return'))
  }
  if (g.setter) set(g.setter, 'name', 'set' + cap(nextBase))
  retype(g.setterParam)
  set(g.setterParam, 'name', nextBase)
  if (g.ctor) {
    const wanted = !next.isStatic && !optional(next)
    if (g.ctorParam && wanted) {
      retype(g.ctorParam)
      set(g.ctorParam, 'name', nextBase)
    } else if (g.ctorParam) {
      changes.push({ remove: g.ctorParam, from: g.ctor })
    } else if (wanted) {
      // Keep attribute order: insert after the params of the attributes declared before it
      const before = new Set(attrNames.slice(0, attrNames.indexOf(attr.name)).map(baseName))
      changes.push({ add: param(nextBase, next), to: g.ctor, index: g.ctor.parameters.filter(q => before.has(q.name)).length })
    }
  }
  return changes
}

/**
 * Changes adding the `inherited` attributes' params missing from the __construct among `ops`.
 * Reversed: each insert index is computed before any of them is applied, so later ones go first.
 */
function planInheritedParams (inherited, ops, ctorNames) {
  const ctorOps = ops.filter(o => o.name === '__construct') // leave the child's own get/set alone
  return [...inherited].reverse().flatMap(attr => planSync(attr, attr, ctorOps, ctorNames))
}

// Constructor param removals for attributes no longer inherited, unless the class declares them itself
function droppedInheritedParams (ctor, beforeNames, afterNames, ownNames) {
  const gone = new Set(beforeNames.filter(n => !afterNames.includes(n) && !ownNames.includes(n)).map(baseName))
  return ctor ? ctor.parameters.filter(p => gone.has(p.name)).map(p => ({ remove: p, from: ctor })) : []
}

// Text type after renaming class `oldName` to `newName` (`?Categorie` -> `?Famille`), or null if unaffected
function renamedType (t, oldName, newName) {
  if (t === oldName) return newName
  if (t === '?' + oldName) return '?' + newName
  if (t === `array<${oldName}>`) return `array<${newName}>`
  return null
}

module.exports = {
  planAccessors, associationFields, heldFields, planAssocUpdate, missingAttributes, planSync, deletedWith,
  renamedType, planInheritedParams, droppedInheritedParams
}
