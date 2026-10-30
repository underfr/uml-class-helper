const {
  planAccessors, associationFields, heldFields, planAssocUpdate, missingAttributes, planSync, deletedWith,
  renamedType, planInheritedParams, droppedInheritedParams
} = require('./accessors')

const ALL = { ctor: true, getters: true, setters: true }
const isClassAttribute = e => e instanceof type.UMLAttribute && e._parent instanceof type.UMLClassifier
const ctorOnly = cls => cls.operations.filter(o => o.name === '__construct')

// Inheritance between classes (PHP: single parent, the first generalization wins)
const generalizations = (cls, side) => app.repository.getRelationshipsOf(cls, r =>
  r instanceof type.UMLGeneralization && r[side] === cls && r.source instanceof type.UMLClass && r.target instanceof type.UMLClass)
// Parents' attributes, root first
function inheritedAttrs (cls) {
  const chain = []
  const seen = new Set([cls])
  for (let g = generalizations(cls, 'source')[0]; g && !seen.has(g.target); g = generalizations(g.target, 'source')[0]) {
    seen.add(g.target)
    chain.unshift(g.target)
  }
  return chain.flatMap(p => p.attributes)
}
// Children, grandchildren...
function descendantsOf (cls, seen = new Set([cls])) {
  for (const g of generalizations(cls, 'target')) {
    if (!seen.has(g.source)) {
      seen.add(g.source)
      descendantsOf(g.source, seen)
    }
  }
  return [...seen].filter(c => c !== cls)
}
// Attribute names in __construct order (inherited first), for param positions
const ctorNames = cls => [...inheritedAttrs(cls), ...cls.attributes].map(a => a.name)

// Classifier -> { attrs to process, newAttrs to create }: the given attributes, or every
// attribute of a given class plus its navigable association ends not yet declared as attributes
function targetsOf (models) {
  const targets = new Map()
  for (const elem of models) {
    if (isClassAttribute(elem)) {
      if (!targets.has(elem._parent)) targets.set(elem._parent, { attrs: [], newAttrs: [] })
      targets.get(elem._parent).attrs.push(elem)
    } else if (elem instanceof type.UMLClassifier) {
      const assocs = app.repository.getRelationshipsOf(elem, r => r instanceof type.UMLAssociation)
      const newAttrs = missingAttributes(elem.attributes, associationFields(elem, assocs))
      targets.set(elem, { attrs: [...elem.attributes, ...newAttrs], newAttrs })
    }
  }
  return targets
}

// One builder = one undo step
function runOperation (name, build) {
  const builder = app.repository.getOperationBuilder()
  builder.begin(name)
  build(builder)
  builder.end()
  app.repository.doOperation(builder.getOperation()) // no-op when empty
}

// Adds the missing attributes and planned operations of `cls` to `builder`; returns how many
function addGenerated (builder, cls, { attrs, newAttrs }, options) {
  let count = 0
  for (const field of newAttrs) {
    const attr = Object.assign(new type.UMLAttribute(), { _parent: cls, visibility: 'private' }, field)
    builder.insert(attr)
    builder.fieldInsert(cls, 'attributes', attr)
    count++
  }
  for (const spec of planAccessors(attrs, cls.operations.map(o => o.name), options, inheritedAttrs(cls))) {
    const op = new type.UMLOperation()
    op._parent = cls
    op.name = spec.name
    op.visibility = 'public'
    op.isStatic = spec.isStatic
    for (const p of spec.params) {
      op.parameters.push(Object.assign(new type.UMLParameter(), { _parent: op }, p))
    }
    builder.insert(op)
    if (spec.atStart) {
      builder.fieldInsertAt(cls, 'operations', op, 0)
    } else {
      builder.fieldInsert(cls, 'operations', op)
    }
    count++
  }
  return count
}

// Adds planSync changes to `builder`
function applyChanges (builder, changes) {
  for (const c of changes) {
    if (c.assign) {
      builder.fieldAssign(c.assign, c.field, c.value)
    } else if (c.remove) {
      builder.fieldRemove(c.from, 'parameters', c.remove)
      builder.remove(c.remove)
    } else {
      const p = Object.assign(new type.UMLParameter(), { _parent: c.to }, c.add)
      builder.insert(p)
      builder.fieldInsertAt(c.to, 'parameters', p, c.index)
    }
  }
}

function generate (options, models = app.selections.getSelectedModels()) {
  const targets = targetsOf(models)
  if (targets.size === 0) {
    app.toast.warning('Sélectionnez une classe ou des attributs.')
    return
  }
  let count = 0
  runOperation('generate accessors', builder => {
    for (const [cls, target] of targets) count += addGenerated(builder, cls, target, options)
  })
  app.toast.info(count > 0 ? `${count} élément(s) généré(s).` : 'Rien à générer (déjà présents).')
}

function generateDiagram () {
  const diagram = app.diagrams.getCurrentDiagram()
  const classes = diagram ? diagram.ownedViews.filter(v => v instanceof type.UMLClassView).map(v => v.model) : []
  if (classes.length === 0) {
    app.toast.warning('Aucune classe dans le diagramme courant.')
    return
  }
  generate(ALL, classes)
}

// -id: ?int as first attribute, with its getter/setter
function addId (builder, cls) {
  const id = Object.assign(new type.UMLAttribute(), { _parent: cls, name: 'id', visibility: 'private', type: '?int' })
  builder.insert(id)
  builder.fieldInsertAt(cls, 'attributes', id, 0)
  addGenerated(builder, cls, { attrs: [id], newAttrs: [] }, { getters: true, setters: true })
}

// Right after the user creates an element (separate undo step):
// a class gets -id: ?int with its getter/setter, an attribute gets its getter/setter and constructor param
function onElementCreated (model) {
  try {
    if (model instanceof type.UMLClass && !model.attributes.some(a => a.name === 'id')) {
      runOperation('add id', builder => addId(builder, model))
    } else if (isClassAttribute(model)) {
      const cls = model._parent
      runOperation('add accessors', builder => {
        addGenerated(builder, cls, { attrs: [model], newAttrs: [] }, { getters: true, setters: true })
        // Only adds the param to existing constructors, in the class and its subclasses
        applyChanges(builder, planSync(model, model, cls.operations, ctorNames(cls)))
        for (const child of descendantsOf(cls)) {
          applyChanges(builder, planSync(model, model, ctorOnly(child), ctorNames(child)))
        }
      })
    } else if (model instanceof type.UMLGeneralization &&
      model.source instanceof type.UMLClass && model.target instanceof type.UMLClass) {
      onInheritance(model.source)
    }
  } catch (err) {
    console.error('uml-helpers: generation on create failed', err)
  }
}

// `child` now extends a class: drop its own id if a parent has one, and add the inherited params
// to the constructors of the child and its subclasses
function onInheritance (child) {
  const ownId = child.attributes.find(a => a.name === 'id')
  if (ownId && inheritedAttrs(child).some(a => a.name === 'id')) {
    app.engine.deleteElements([ownId, ...deletedWith(ownId, child.operations)], [])
  }
  runOperation('add inherited params', builder => {
    for (const cls of [child, ...descendantsOf(child)]) {
      applyChanges(builder, planInheritedParams(inheritedAttrs(cls), cls.operations, ctorNames(cls)))
    }
  })
}

// State captured in beforeExecuteOperation, reconciled once that operation has run
let pending = null

// Generated attributes of an association as they are now, each with the attribute found in its holder
const assocSnapshot = assoc => heldFields(assoc).map(h =>
  ({ ...h, attr: h.holder.attributes.find(a => a.name === h.field.name && a.type === h.field.type) }))

function capture (operation) {
  const removedIds = new Set(operation.ops.filter(op => op.op === 'R').map(op => op.arg._id)) // 'R' = REMOVE
  const removed = [...removedIds].map(id => app.repository.get(id)).filter(Boolean)
  // Attributes deleted on their own (not along with their class)
  const attrs = removed.filter(e => isClassAttribute(e) && !removedIds.has(e._parent._id))
    .map(a => ({ cls: a._parent, name: a.name }))
  // Associations and inheritances deleted, including those owned by a deleted class
  const assocFields = []
  const inheritances = []
  for (const root of removed) {
    root.traverse(e => {
      if (e instanceof type.UMLAssociation) {
        for (const cls of new Set([e.end1.reference, e.end2.reference])) {
          for (const f of associationFields(cls, [e])) assocFields.push({ cls, name: f.name, type: f.type })
        }
      } else if (e instanceof type.UMLGeneralization && e.source instanceof type.UMLClass) {
        inheritances.push({ child: e.source, names: inheritedAttrs(e.source).map(a => a.name) })
      }
    })
  }
  // Associations edited: an end's role/multiplicity/arrow/diamond/class, or a class renamed (default role)
  const edited = new Set()
  for (const op of operation.ops) {
    if (op.op !== 'a') continue // 'a' = FIELD_ASSIGN
    const elem = app.repository.get(op.arg._id)
    if (elem instanceof type.UMLAssociationEnd && elem._parent instanceof type.UMLAssociation &&
      ['name', 'multiplicity', 'navigable', 'aggregation', 'reference'].includes(op.arg.f)) {
      edited.add(elem._parent)
    } else if (elem instanceof type.UMLClassifier && op.arg.f === 'name') {
      for (const r of app.repository.getRelationshipsOf(elem, r => r instanceof type.UMLAssociation)) edited.add(r)
    }
  }
  const assocs = [...edited].filter(a => !removedIds.has(a._id)).map(assoc => ({ assoc, before: assocSnapshot(assoc) }))
  return attrs.length + assocFields.length + inheritances.length + assocs.length > 0
    ? { operation, attrs, assocFields, inheritances, assocs }
    : null
}

// When an attribute's name/type/multiplicity or a class name is edited, update what depends on it.
// Ops are appended to the user's operation: one undo step, and undo/redo replay them as-is.
// Not emitted for undo/redo, so those never re-trigger it.
function onBeforeOperation (operation) {
  if (operation.bypass) return
  try {
    pending = capture(operation)
    const changedAttrs = new Map()
    const renamedClasses = []
    for (const op of operation.ops) {
      if (op.op !== 'a') continue // 'a' = FIELD_ASSIGN
      const elem = app.repository.get(op.arg._id)
      if (isClassAttribute(elem) && ['name', 'type', 'multiplicity'].includes(op.arg.f)) {
        if (!changedAttrs.has(elem)) changedAttrs.set(elem, {})
        changedAttrs.get(elem)[op.arg.f] = op.arg.n
      } else if (elem instanceof type.UMLClassifier && op.arg.f === 'name' && op.arg.o && op.arg.o !== op.arg.n) {
        renamedClasses.push(op.arg)
      }
    }
    if (changedAttrs.size === 0 && renamedClasses.length === 0) return
    // Private builder: the shared one may still belong to the caller
    const builder = new (app.repository.getOperationBuilder().constructor)()
    builder.begin('sync accessors')
    for (const [attr, values] of changedAttrs) {
      const cls = attr._parent
      const next = { name: attr.name, type: attr.type, multiplicity: attr.multiplicity, isStatic: attr.isStatic, ...values }
      applyChanges(builder, planSync(attr, next, cls.operations, ctorNames(cls)))
      // Subclasses: only their constructor carries the inherited attribute
      for (const child of descendantsOf(cls)) {
        applyChanges(builder, planSync(attr, next, ctorOnly(child), ctorNames(child)))
      }
    }
    // `?Categorie` is plain text: rename it everywhere along with the class
    if (renamedClasses.length > 0) {
      for (const e of app.repository.getInstancesOf(['UMLAttribute', 'UMLParameter'])) {
        for (const { o, n } of renamedClasses) {
          const t = renamedType(e.type, o, n)
          if (t !== null) builder.fieldAssign(e, 'type', t)
        }
      }
    }
    builder.end()
    operation.ops.push(...builder.getOperation().ops)
  } catch (err) {
    // Never block the user's own edit
    console.error('uml-helpers: sync failed', err)
  }
}

// After the user's operation, as separate operations through public APIs whose own events cascade
// (getters, setters, constructor params): extra undo steps.
function onOperationExecuted (operation) {
  if (!pending || pending.operation !== operation) return
  const { attrs, assocFields, inheritances, assocs } = pending
  pending = null // nested operations below capture their own
  const alive = e => !!app.repository.get(e._id)
  try {
    // Deleted attribute: its getter, setter and constructor params (subclasses too).
    // Deleted association: the attribute it generated, with its methods.
    const orphans = []
    for (const { cls, name, type: t } of assocFields) {
      const attr = alive(cls) && cls.attributes.find(a => a.name === name && a.type === t)
      if (attr) orphans.push(attr, ...deletedWith(attr, cls.operations))
    }
    for (const { cls, name } of attrs) {
      if (!alive(cls)) continue
      orphans.push(...deletedWith({ name }, cls.operations))
      for (const child of descendantsOf(cls)) orphans.push(...deletedWith({ name }, ctorOnly(child)))
    }
    if (orphans.length > 0) app.engine.deleteElements([...new Set(orphans)], [])

    // Deleted inheritance: params no longer inherited leave the constructors; the child gets its id back
    const dropped = inheritances.filter(i => alive(i.child))
    if (dropped.length > 0) {
      runOperation('remove inherited params', builder => {
        for (const { child, names } of dropped) {
          const now = inheritedAttrs(child).map(a => a.name)
          for (const cls of [child, ...descendantsOf(child)]) {
            const ctor = ctorOnly(cls)[0]
            applyChanges(builder, droppedInheritedParams(ctor, names, now, cls.attributes.map(a => a.name)))
          }
          if (!child.attributes.some(a => a.name === 'id') && !now.includes('id')) addId(builder, child)
        }
      })
    }

    // Edited association: rename/retype, move or remove the attribute it generated
    for (const { assoc, before } of assocs) {
      if (!alive(assoc)) continue
      const plan = planAssocUpdate(before, heldFields(assoc))
      for (const { attr, next } of plan.updates) {
        if (alive(attr) && (attr.name !== next.name || attr.type !== next.type)) {
          app.engine.setProperties(attr, { name: next.name, type: next.type })
        }
      }
      const gone = plan.deletes.map(d => d.attr).filter(alive)
      if (gone.length > 0) app.engine.deleteElements(gone, [])
      for (const { holder, field } of plan.creates) {
        if (!alive(holder) || holder.attributes.some(a => a.name === field.name)) continue
        // Through the factory so onElementCreated adds its getter, setter and constructor params
        app.factory.createModel({
          id: 'UMLAttribute',
          parent: holder,
          field: 'attributes',
          modelInitializer: m => Object.assign(m, { name: field.name, type: field.type, visibility: 'private' })
        })
      }
    }
  } catch (err) {
    console.error('uml-helpers: reconcile failed', err)
  }
}

function init () {
  app.factory.on('elementCreated', onElementCreated)
  app.repository.on('beforeExecuteOperation', onBeforeOperation)
  app.repository.on('operationExecuted', onOperationExecuted)
  app.commands.register('uml-helpers:accessors', () => generate(ALL), 'Generate Constructor, Getters & Setters')
  app.commands.register('uml-helpers:constructor', () => generate({ ctor: true, getters: false, setters: false }), 'Generate Constructor')
  app.commands.register('uml-helpers:getters', () => generate({ getters: true, setters: false }), 'Generate Getters')
  app.commands.register('uml-helpers:setters', () => generate({ getters: false, setters: true }), 'Generate Setters')
  app.commands.register('uml-helpers:diagram', generateDiagram, 'Generate for Whole Diagram')
}

exports.init = init
