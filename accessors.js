// Pure logic (no StarUML API) so it can be tested with plain node.

const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const lcfirst = s => s.charAt(0).toLowerCase() + s.slice(1)
const typeName = t => (typeof t === 'string' ? t : (t && t.name) || '')
const baseName = name => (name || '').replace(/^_+/, '') // _age -> age
const param = (name, attr) => ({ name, type: attr.type, multiplicity: attr.multiplicity })
const getterPrefix = t => (/^\??bool(ean)?$/i.test(typeName(t)) ? 'is' : 'get')
// array<Produit> -> Produit, else null
const elementType = t => { const m = /^array<(.+)>$/.exec(typeName(t)); return m ? m[1] : null }
// shortcut: regular plurals only (journal -> journaux but bal -> baux, tuyaux -> tuyal); name the role for exceptions
const plural = s => /[sxz]$/.test(s) ? s : /(eau|au|eu)$/.test(s) ? s + 'x' : /al$/.test(s) ? s.slice(0, -2) + 'aux' : s + 's'
const singular = s => /(eau|eu)x$/.test(s) ? s.slice(0, -1) : /aux$/.test(s) ? s.slice(0, -3) + 'al' : /s$/.test(s) ? s.slice(0, -1) : s
// addProduit(produit: Produit): void / removeProduit(...) for an array<Produit> attribute named `base`
const itemSpec = (verb, base, item, isStatic) => ({
  name: verb + cap(singular(base)),
  isStatic: !!isStatic,
  atStart: false,
  params: [{ name: singular(base), type: item, multiplicity: '' }, { name: '', type: 'void', direction: 'return' }]
})
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
 * attribute-like and typed `array<Class>` when the held end is many (0..*, 1..*), `?Class` otherwise (1, 0..1),
 * `Class` in a composition (never null).
 * Arrows first, then the diamond, then multiplicities decide; otherwise both sides.
 * An unnamed role defaults to the class name (Adresse -> adresse, plural when many: produits).
 */
function heldFields (assoc) {
  const nullable = assoc.end1.aggregation !== 'composite' && assoc.end2.aggregation !== 'composite' ? '?' : ''
  const held = []
  for (const [own, other, from] of [[assoc.end1, assoc.end2, 'end2'], [assoc.end2, assoc.end1, 'end1']]) {
    if (!holds(own, other)) continue
    held.push({
      holder: own.reference,
      from,
      field: {
        name: other.name || (isMany(other) ? plural : x => x)(lcfirst(typeName(other.reference))),
        // Plain string (needed for `?`/`array<>`); renamedType keeps it in line when the class is renamed
        type: isMany(other) ? `array<${typeName(other.reference)}>` : nullable + typeName(other.reference),
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
      add({
        name: getterPrefix(attr.type) + cap(base),
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
      const item = elementType(attr.type)
      if (item) for (const verb of ['add', 'remove']) add(itemSpec(verb, base, item, attr.isStatic))
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
  const many = base && elementType(attr.type)
  return {
    base,
    getter,
    setter,
    adder: many && find('add' + cap(singular(base))),
    remover: many && find('remove' + cap(singular(base))),
    setterParam: setter && setter.parameters.find(p => p.direction !== 'return'),
    ctor,
    ctorParam: base && ctor && ctor.parameters.find(p => p.name === base)
  }
}

// Getter, setter, add/remove and __construct param to delete along with an attribute ({ name, type })
function deletedWith (attr, ops) {
  const g = generatedFor(attr, ops)
  return [g.getter, g.setter, g.adder, g.remover, g.ctorParam].filter(Boolean)
}

/**
 * Changes that keep generated operations in line with an edited attribute (name, type, multiplicity, static).
 * `attr` is the attribute now, `next` as it will be, `ops` the class operations, `attrNames` its attribute names in order.
 * A rename onto a name another operation (or constructor param) already has is skipped and reported as `warn`.
 * @return {Array} {assign: elem, field, value} | {remove: param, from: op} | {add: param, to: op, index}
 *   | {removeOp: op} | {createOp: spec, in: cls} | {warn: name}
 */
function planSync (attr, next, ops, attrNames) {
  const g = generatedFor(attr, ops)
  const nextBase = baseName(next.name)
  if (!g.base || !nextBase) return []
  const changes = []
  const set = (elem, field, value) => {
    if (elem && elem[field] !== value) changes.push({ assign: elem, field, value })
  }
  const rename = (elem, name, siblings) => {
    if (!elem || elem.name === name) return
    if (siblings.some(o => o !== elem && o.name === name)) changes.push({ warn: name })
    else set(elem, 'name', name)
  }
  const restatic = op => {
    if (op && !!op.isStatic !== !!next.isStatic) changes.push({ assign: op, field: 'isStatic', value: !!next.isStatic })
  }
  const retype = p => {
    set(p, 'type', next.type)
    set(p, 'multiplicity', next.multiplicity)
  }
  if (g.getter) {
    rename(g.getter, getterPrefix(next.type) + cap(nextBase), ops)
    retype(g.getter.parameters.find(p => p.direction === 'return'))
    restatic(g.getter)
  }
  rename(g.setter, 'set' + cap(nextBase), ops)
  restatic(g.setter)
  retype(g.setterParam)
  set(g.setterParam, 'name', nextBase)
  // add/remove exist only while the type is array<T>
  const nextItem = elementType(next.type)
  for (const [verb, op] of [['add', g.adder], ['remove', g.remover]]) {
    if (op && nextItem) {
      rename(op, verb + cap(singular(nextBase)), ops)
      restatic(op)
      const p = op.parameters.find(q => q.direction !== 'return')
      set(p, 'type', nextItem)
      set(p, 'name', singular(nextBase))
    } else if (op) {
      changes.push({ removeOp: op })
    } else if (nextItem && g.setter) {
      changes.push({ createOp: itemSpec(verb, nextBase, nextItem, next.isStatic), in: g.setter._parent })
    }
  }
  if (g.ctor) {
    const wanted = !next.isStatic && !optional(next)
    if (g.ctorParam && wanted) {
      retype(g.ctorParam)
      rename(g.ctorParam, nextBase, g.ctor.parameters)
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

// Copy of an operation (interface or abstract method) as a spec for a concrete class
const opSpec = op => ({
  name: op.name,
  isStatic: !!op.isStatic,
  atStart: false,
  params: op.parameters.map(p => ({ name: p.name, type: p.type, multiplicity: p.multiplicity, direction: p.direction }))
})
const signature = op => JSON.stringify([!!op.isStatic, op.parameters.map(p => [p.name, typeName(p.type), p.multiplicity, p.direction])])

/**
 * Interface and abstract methods a concrete class must have but doesn't: those of the `interfaces` it
 * implements and the abstract ones of its `ancestors`, unless the class or a parent has a concrete one.
 */
function requiredOps (cls, ancestors, interfaces) {
  if (cls.isAbstract) return []
  const done = new Set([cls, ...ancestors].flatMap(c => c.operations.filter(o => !o.isAbstract).map(o => o.name)))
  const required = []
  for (const op of [...interfaces.flatMap(i => i.operations), ...ancestors.flatMap(a => a.operations.filter(o => o.isAbstract))]) {
    if (!done.has(op.name)) {
      done.add(op.name)
      required.push(op)
    }
  }
  return required
}

// Changes making `impl` match its interface/abstract `source` again (name, static, parameters)
function syncImplementation (source, impl) {
  const changes = []
  if (impl.name !== source.name) changes.push({ assign: impl, field: 'name', value: source.name })
  if (signature(impl) !== signature(source)) changes.push({ replaceParams: impl, params: opSpec(source).params })
  return changes
}

/**
 * Problems in a class: [{ elem, message }]. `inherited`: parents' attributes; `contractNames`: names of the
 * operations of parents and implemented interfaces (their getters/setters have no attribute here).
 */
function lintClass (cls, inherited, contractNames, required) {
  const problems = []
  const warn = (elem, message) => problems.push({ elem, message })
  const where = `${cls.name} :`
  if (!/^[A-Z][A-Za-z0-9]*$/.test(cls.name)) warn(cls, `${where} nom de classe en PascalCase attendu`)
  for (const a of cls.attributes) {
    if (!/^_?[a-z][A-Za-z0-9]*$/.test(a.name)) warn(a, `${where} attribut « ${a.name} » : camelCase attendu`)
    if (!typeName(a.type)) warn(a, `${where} attribut « ${a.name} » sans type`)
  }
  const all = [...inherited, ...cls.attributes]
  const bases = new Set(all.map(a => baseName(a.name)))
  const items = new Set(all.filter(a => elementType(a.type)).map(a => singular(baseName(a.name))))
  for (const o of cls.operations) {
    if (!/^(__)?[a-z][A-Za-z0-9]*$/.test(o.name)) warn(o, `${where} méthode « ${o.name} » : camelCase attendu`)
    if (contractNames.includes(o.name)) continue
    const acc = /^(get|is|set)([A-Z]\w*)$/.exec(o.name)
    if (acc && !bases.has(lcfirst(acc[2]))) warn(o, `${where} « ${o.name} » sans attribut « ${lcfirst(acc[2])} »`)
    const item = /^(add|remove)([A-Z]\w*)$/.exec(o.name)
    if (item && !items.has(lcfirst(item[2]))) warn(o, `${where} « ${o.name} » sans attribut array<…> correspondant`)
  }
  for (const op of required) warn(cls, `${where} méthode « ${op.name} » de « ${op._parent ? op._parent.name : '?'} » non implémentée`)
  return problems
}

// Problems in an association: missing multiplicity, attribute generated on both sides
function lintAssociation (assoc) {
  const names = `${typeName(assoc.end1.reference)} — ${typeName(assoc.end2.reference)}`
  const problems = []
  for (const end of [assoc.end1, assoc.end2]) {
    if (!(end.multiplicity || '').trim()) {
      problems.push({ elem: assoc, message: `Association ${names} : multiplicité manquante côté ${typeName(end.reference)}` })
    }
  }
  if (heldFields(assoc).length === 2 && assoc.end1.reference !== assoc.end2.reference) {
    problems.push({ elem: assoc, message: `Association ${names} : attribut généré des deux côtés (ajoute une flèche ou un losange si un seul côté doit l'avoir)` })
  }
  return problems
}

module.exports = {
  planAccessors, associationFields, heldFields, planAssocUpdate, missingAttributes, planSync, deletedWith,
  renamedType, planInheritedParams, droppedInheritedParams, plural, singular,
  opSpec, requiredOps, syncImplementation, lintClass, lintAssociation
}
