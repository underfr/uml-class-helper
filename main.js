const {
  planAccessors, associationFields, heldFields, roleClashes, ownsField, planAssocUpdate, missingAttributes, planSync, deletedWith,
  orderedOps, renamedType, planInheritedParams, droppedInheritedParams, normalType, opSpec, requiredOps, syncImplementation,
  COPY_TAG, copySource, staleCopies, lintClass, lintAssociation, lintRoleClashes
} = require('./accessors')

const ALL = { ctor: true, getters: true, setters: true, implement: true, toStringOp: true }
const isClassAttribute = e => e instanceof type.UMLAttribute && e._parent instanceof type.UMLClassifier
const ctorOnly = cls => cls.operations.filter(o => o.name === '__construct')

// Inheritance between classes (PHP: single parent, the first generalization wins)
const generalizations = (cls, side) => app.repository.getRelationshipsOf(cls, r =>
  r instanceof type.UMLGeneralization && r[side] === cls && r.source instanceof type.UMLClass && r.target instanceof type.UMLClass)
// Parents, nearest first
function ancestorsOf (cls) {
  const chain = []
  const seen = new Set([cls])
  for (let g = generalizations(cls, 'source')[0]; g && !seen.has(g.target); g = generalizations(g.target, 'source')[0]) {
    seen.add(g.target)
    chain.push(g.target)
  }
  return chain
}
// Parents' attributes, root first
const inheritedAttrs = cls => ancestorsOf(cls).reverse().flatMap(p => p.attributes)
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
// Same, with the attributes about to be added to each class (`pendingOf`) after its own
const ctorNamesWith = (cls, pendingOf) =>
  [...ancestorsOf(cls).reverse(), cls].flatMap(c => [...c.attributes, ...pendingOf(c)]).map(a => a.name)

// Interfaces a class implements (with the interfaces they extend), and classes that must copy the methods
// of an interface / abstract class
const realizations = (elem, side) => app.repository.getRelationshipsOf(elem, r =>
  r instanceof type.UMLInterfaceRealization && r[side] === elem && r.source instanceof type.UMLClass && r.target instanceof type.UMLInterface)
const superInterfaces = i => app.repository.getRelationshipsOf(i, r =>
  r instanceof type.UMLGeneralization && r.source === i && r.target instanceof type.UMLInterface).map(r => r.target)
function interfacesOf (cls) {
  const all = []
  const visit = i => {
    if (all.includes(i)) return
    all.push(i)
    superInterfaces(i).forEach(visit)
  }
  realizations(cls, 'source').forEach(r => visit(r.target))
  return all
}
const implementersOf = owner => owner instanceof type.UMLInterface
  ? app.repository.getInstancesOf(['UMLClass']).filter(c => interfacesOf(c).includes(owner))
  : descendantsOf(owner).filter(c => !c.isAbstract)
// Methods whose copies `cls` may hold: its interfaces' ones and its parents' abstract ones
const contractSources = cls =>
  [...interfacesOf(cls).flatMap(i => i.operations), ...ancestorsOf(cls).flatMap(a => a.operations.filter(o => o.isAbstract))]
// An interface method, or an abstract method of a class: copied into implementers
const isContract = op => op instanceof type.UMLOperation &&
  (op._parent instanceof type.UMLInterface || (op._parent instanceof type.UMLClass && op.isAbstract))

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

// One builder = one operation (its own undo step unless joined, see joinUndoStep); returns it
function runOperation (name, build) {
  const builder = app.repository.getOperationBuilder()
  builder.begin(name)
  build(builder)
  builder.end()
  const operation = builder.getOperation()
  app.repository.doOperation(operation) // no-op when empty
  return operation
}

// shortcut: StarUML has no API to group operations, so this edits its private undo stack; if that changes, extra steps come back
const undoStack = () => (app.repository._undoStack && Array.isArray(app.repository._undoStack.stack) ? app.repository._undoStack.stack : null)
const lastUndoStep = () => { const stack = undoStack(); return stack ? stack[stack.length - 1] : null }

// Runs `fn`; the operations it executes (cascades included) join `root`'s undo step: one Ctrl+Z undoes it all
function joinUndoStep (root, fn) {
  const stack = undoStack()
  if (!root || !stack || !stack.includes(root)) return fn()
  const executed = [] // in execution order (beforeExecuteOperation), which redo replays
  const collect = op => executed.push(op)
  app.repository.on('beforeExecuteOperation', collect)
  try {
    return fn()
  } finally {
    app.repository.removeListener('beforeExecuteOperation', collect)
    for (const op of executed) {
      const i = stack.indexOf(op)
      if (i === -1 || op === root) continue // not undoable, or already joined by a nested call
      stack.splice(i, 1)
      root.ops.push(...op.ops)
    }
  }
}

function insertOperation (builder, cls, spec) {
  const op = new type.UMLOperation()
  op._parent = cls
  op.name = spec.name
  op.visibility = 'public'
  op.isStatic = spec.isStatic
  for (const p of spec.params) {
    op.parameters.push(Object.assign(new type.UMLParameter(), { _parent: op }, p))
  }
  if (spec.source) {
    // Copy of an interface/abstract method: found again by this reference, not by name, so a method of the
    // same name written by hand is never taken for it
    op.tags.push(Object.assign(new type.Tag(), { _parent: op, name: COPY_TAG, kind: 'reference', reference: spec.source, hidden: true }))
  }
  builder.insert(op)
  if (spec.atStart) {
    builder.fieldInsertAt(cls, 'operations', op, 0)
  } else {
    builder.fieldInsert(cls, 'operations', op)
  }
}

// Adds the missing attributes and planned operations of `cls` to `builder`; returns how many.
// `pendingOf(c)`: attributes the same builder adds to class `c` (parents' ones go into a new __construct)
function addGenerated (builder, cls, { attrs, newAttrs }, options, pendingOf = c => (c === cls ? newAttrs : [])) {
  for (const field of newAttrs) {
    const attr = Object.assign(new type.UMLAttribute(), { _parent: cls, visibility: 'private' }, field)
    builder.insert(attr)
    builder.fieldInsert(cls, 'attributes', attr)
  }
  const inherited = ancestorsOf(cls).reverse().flatMap(p => [...p.attributes, ...pendingOf(p)])
  const classOptions = { ...options, toStringOp: !!options.toStringOp && cls instanceof type.UMLClass }
  const specs = planAccessors(attrs, cls.operations.map(o => o.name), classOptions, inherited)
  for (const spec of specs) insertOperation(builder, cls, spec)
  // planAccessors only creates a missing __construct: new attributes also go into existing ones, subclasses' too
  for (const c of [cls, ...descendantsOf(cls)]) {
    applyChanges(builder, planInheritedParams(newAttrs, ctorOnly(c), ctorNamesWith(c, pendingOf)))
  }
  return newAttrs.length + specs.length
}

// Copies the interface/abstract methods `cls` lacks; returns how many
function addRequired (builder, cls) {
  if (!(cls instanceof type.UMLClass)) return 0
  const required = requiredOps(cls, ancestorsOf(cls), interfacesOf(cls))
  for (const op of required) insertOperation(builder, cls, opSpec(op))
  return required.length
}

// Adds planSync/syncImplementation changes to `builder`; returns the names it refused to take
function applyChanges (builder, changes) {
  const warnings = []
  for (const c of changes) {
    if (c.warn) {
      warnings.push(c.warn)
    } else if (c.assign) {
      builder.fieldAssign(c.assign, c.field, c.value)
    } else if (c.remove) {
      builder.fieldRemove(c.from, 'parameters', c.remove)
      builder.remove(c.remove)
    } else if (c.removeOp) {
      // The class compartment drops the operation's view on its own
      builder.fieldRemove(c.removeOp._parent, 'operations', c.removeOp)
      builder.remove(c.removeOp)
    } else if (c.createOp) {
      insertOperation(builder, c.in, c.createOp)
    } else if (c.replaceParams) {
      for (const p of [...c.replaceParams.parameters]) {
        builder.fieldRemove(c.replaceParams, 'parameters', p)
        builder.remove(p)
      }
      for (const p of c.params) {
        const param = Object.assign(new type.UMLParameter(), { _parent: c.replaceParams }, p)
        builder.insert(param)
        builder.fieldInsert(c.replaceParams, 'parameters', param)
      }
    } else {
      const p = Object.assign(new type.UMLParameter(), { _parent: c.to }, c.add)
      builder.insert(p)
      builder.fieldInsertAt(c.to, 'parameters', p, c.index)
    }
  }
  return warnings
}

function generate (options, models = app.selections.getSelectedModels()) {
  const targets = targetsOf(models)
  if (targets.size === 0) {
    app.toast.warning('Sélectionnez une classe ou des attributs.')
    return
  }
  let count = 0
  const pendingOf = c => (targets.has(c) ? targets.get(c).newAttrs : [])
  // Subclasses first: their parents then insert params into the same constructors at lower indexes
  // (fieldInsertAt indexes are computed before any insert is applied)
  const ordered = [...targets].sort(([a], [b]) => ancestorsOf(b).length - ancestorsOf(a).length)
  const generated = runOperation('generate accessors', builder => {
    for (const [cls, target] of ordered) {
      // Before addGenerated: its __construct goes in last with fieldInsertAt, which later fieldInserts don't see
      if (options.implement) count += addRequired(builder, cls)
      count += addGenerated(builder, cls, target, options, pendingOf)
    }
  })
  joinUndoStep(generated, () => runOperation('reorder methods', builder => {
    for (const cls of targets.keys()) reorderOps(builder, cls)
  }))
  app.toast.info(count > 0 ? `${count} élément(s) généré(s).` : 'Rien à générer (déjà présents).')
}

// Puts the methods of `cls` in reading order (orderedOps), moving as few as possible
function reorderOps (builder, cls) {
  const now = [...cls.operations]
  orderedOps(cls.attributes, now).forEach((op, i) => {
    if (now[i] === op) return
    now.splice(now.indexOf(op), 1)
    now.splice(i, 0, op)
    builder.fieldReorder(cls, 'operations', op, i)
  })
}

// Several associations giving a class the same attribute (two compositions to User, both `user`): asks a role
// name for each, the association highlighted in the diagram, then names them all in one undo step
async function nameClashingRoles (classes) {
  const named = []
  for (const cls of classes) {
    const chosen = new Set()
    for (const h of roleClashes(cls, associationsOf(cls))) {
      const end = h.assoc[h.from]
      const view = app.repository.getViewsOf(h.assoc).find(v => v._parent instanceof type.Diagram)
      if (view) app.diagrams.selectInDiagram(view)
      const { buttonId, returnValue } = await app.dialogs.showInputDialog(
        `${cls.name} a plusieurs associations vers ${end.reference.name} : nom de l'attribut pour l'association sélectionnée ?`, h.field.name)
      const name = (returnValue || '').trim()
      if (buttonId !== 'ok' || !name) continue
      if (chosen.has(name)) {
        app.toast.warning(`« ${name} » déjà choisi dans ${cls.name} : association non renommée.`)
        continue
      }
      chosen.add(name)
      named.push({ end, name })
    }
  }
  // The role names rename the attributes already generated (onOperationExecuted), then generate adds the others
  return runOperation('name association roles', builder => {
    for (const { end, name } of named) builder.fieldAssign(end, 'name', name)
  })
}

// generate, after asking names for clashing association roles (same undo step); the selection is read first,
// the dialogs change it
async function generateNaming (options, models = app.selections.getSelectedModels()) {
  const naming = await nameClashingRoles(models.filter(m => m instanceof type.UMLClassifier))
  joinUndoStep(naming, () => generate(options, models))
}

const diagramClasses = diagram => diagram.ownedViews.filter(v => v instanceof type.UMLClassView).map(v => v.model)

function generateDiagram () {
  const diagram = app.diagrams.getCurrentDiagram()
  const classes = diagram ? diagramClasses(diagram) : []
  if (classes.length === 0) {
    app.toast.warning('Aucune classe dans le diagramme courant.')
    return
  }
  return generateNaming(ALL, classes)
}

// -id: ?int as first attribute, with its getter/setter
function addId (builder, cls) {
  const id = Object.assign(new type.UMLAttribute(), { _parent: cls, name: 'id', visibility: 'private', type: '?int' })
  builder.insert(id)
  builder.fieldInsertAt(cls, 'attributes', id, 0)
  addGenerated(builder, cls, { attrs: [id], newAttrs: [] }, { getters: true, setters: true })
}

// Right after the user creates an element (same undo step as the creation):
// a class gets -id: ?int with its getter/setter, an attribute gets its getter/setter and constructor param,
// a class implementing an interface or extending an abstract class gets the methods it must have
function onElementCreated (model) {
  if (duplicated()) return
  try {
    // The creation is the last undo step (checked, so nothing joins an unrelated one)
    const last = lastUndoStep()
    const creation = last && last.ops.some(op => op.op === 'I' && op.arg && op.arg._id === model._id) ? last : null
    joinUndoStep(creation, () => {
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
        runOperation('reorder methods', builder => reorderOps(builder, cls))
      } else if (model instanceof type.UMLGeneralization || model instanceof type.UMLInterfaceRealization) {
        onRelationship(model)
      } else if (isContract(model)) {
        // New interface method: copied into the classes implementing it (unless one has a method of that name)
        runOperation('copy interface method', builder => {
          for (const impl of implementersOf(model._parent)) {
            if (!impl.operations.some(o => o.name === model.name)) insertOperation(builder, impl, opSpec(model))
          }
        })
      }
    })
  } catch (err) {
    console.error('uml-helpers: generation on create failed', err)
  }
}

// A relationship drawn or reconnected: inheritance between classes (id, constructor params), and the methods
// of the interfaces / abstract parents now to implement
function onRelationship (rel) {
  if (rel instanceof type.UMLGeneralization && rel.source instanceof type.UMLClass && rel.target instanceof type.UMLClass) {
    onInheritance(rel.source)
  } else if (rel instanceof type.UMLGeneralization && rel.source instanceof type.UMLInterface && rel.target instanceof type.UMLInterface) {
    runOperation('implement interface', builder => implementersOf(rel.source).forEach(cls => addRequired(builder, cls)))
  } else if (rel instanceof type.UMLInterfaceRealization && rel.source instanceof type.UMLClass) {
    runOperation('implement interface', builder => addRequired(builder, rel.source))
  }
}

// `child` now extends a class: drop its own id if a parent has one, add the inherited params to the
// constructors of the child and its subclasses, and the abstract methods they must implement
function onInheritance (child) {
  const ownId = child.attributes.find(a => a.name === 'id')
  if (ownId && inheritedAttrs(child).some(a => a.name === 'id')) {
    app.engine.deleteElements([ownId, ...deletedWith(ownId, child.operations)], [])
  }
  runOperation('add inherited params', builder => {
    for (const cls of [child, ...descendantsOf(child)]) {
      addRequired(builder, cls)
      applyChanges(builder, planInheritedParams(inheritedAttrs(cls), cls.operations, ctorNames(cls)))
    }
  })
}

// State captured in beforeExecuteOperation, reconciled once that operation has run
let pending = null

const associationsOf = cls => app.repository.getRelationshipsOf(cls, r => r instanceof type.UMLAssociation)

// Generated attributes of an association as they are now, each with the attribute found in its holder
// (none when another association of the holder owns that name and type)
const assocSnapshot = assoc => heldFields(assoc).map(h => ({
  ...h,
  attr: ownsField(assoc, h, associationsOf(h.holder))
    ? h.holder.attributes.find(a => a.name === h.field.name && a.type === h.field.type)
    : undefined
}))

function capture (operation) {
  const removedIds = new Set(operation.ops.filter(op => op.op === 'R').map(op => op.arg._id)) // 'R' = REMOVE
  const removed = [...removedIds].map(id => app.repository.get(id)).filter(Boolean)
  // Attributes deleted on their own (not along with their class)
  const attrs = removed.filter(e => isClassAttribute(e) && !removedIds.has(e._parent._id))
    .map(a => ({ cls: a._parent, name: a.name, type: a.type }))
  // Associations deleted, including those owned by a deleted class; inheritances and realizations deleted
  const assocFields = []
  const lost = new Set()
  for (const root of removed) {
    root.traverse(e => {
      if (e instanceof type.UMLAssociation) {
        for (const h of assocSnapshot(e).filter(s => s.attr)) assocFields.push({ cls: h.holder, name: h.field.name, type: h.field.type })
      } else if (e instanceof type.UMLGeneralization || e instanceof type.UMLInterfaceRealization) {
        lost.add(e)
      }
    })
  }
  // Associations edited: an end's role/multiplicity/arrow/diamond/class, or a class renamed (default role).
  // Inheritances and realizations reconnected to another class: lost here, drawn again after
  const edited = new Set()
  const relinked = new Set()
  for (const op of operation.ops) {
    if (op.op !== 'a') continue // 'a' = FIELD_ASSIGN
    const elem = app.repository.get(op.arg._id)
    if (elem instanceof type.UMLAssociationEnd && elem._parent instanceof type.UMLAssociation &&
      ['name', 'multiplicity', 'navigable', 'aggregation', 'reference'].includes(op.arg.f)) {
      edited.add(elem._parent)
    } else if (elem instanceof type.UMLClassifier && op.arg.f === 'name') {
      for (const r of app.repository.getRelationshipsOf(elem, r => r instanceof type.UMLAssociation)) edited.add(r)
    } else if ((elem instanceof type.UMLGeneralization || elem instanceof type.UMLInterfaceRealization) &&
      ['source', 'target'].includes(op.arg.f)) {
      lost.add(elem)
      relinked.add(elem)
    }
  }
  const assocs = [...edited].filter(a => !removedIds.has(a._id)).map(assoc => ({ assoc, before: assocSnapshot(assoc) }))
  // What the lost relationships gave: inherited constructor params, and classes whose copies may go stale
  const inheritances = []
  const prune = new Set()
  for (const rel of lost) {
    if (rel instanceof type.UMLGeneralization && rel.source instanceof type.UMLClass) {
      inheritances.push({ child: rel.source, names: inheritedAttrs(rel.source).map(a => a.name) })
      for (const c of [rel.source, ...descendantsOf(rel.source)]) prune.add(c)
    } else if (rel.source instanceof type.UMLInterface) {
      for (const c of implementersOf(rel.source)) prune.add(c)
    } else if (rel.source instanceof type.UMLClass) {
      prune.add(rel.source)
    }
  }
  // Interface/abstract methods deleted or edited (name, static, abstract, parameters): their implementers' copies
  for (const op of removed.filter(e => isContract(e) && !removedIds.has(e._parent._id))) {
    for (const c of implementersOf(op._parent)) prune.add(c)
  }
  const contracts = new Set()
  for (const op of operation.ops) {
    const elem = app.repository.get(op.arg && op.arg._id)
    const owner = elem instanceof type.UMLParameter ? elem._parent : elem
    const edit = (op.op === 'a' && (isContract(owner) || (elem instanceof type.UMLOperation && op.arg.f === 'isAbstract'))) ||
      (['i', 'r'].includes(op.op) && op.arg.f === 'parameters' && isContract(elem)) // FIELD_INSERT / FIELD_REMOVE
    if (edit && owner instanceof type.UMLOperation) contracts.add(owner)
  }
  // A method no longer abstract: its copies go
  for (const op of contracts) for (const c of implementersOf(op._parent)) prune.add(c)
  return attrs.length + assocFields.length + inheritances.length + assocs.length + prune.size + contracts.size + relinked.size > 0
    ? { operation, attrs, assocFields, inheritances, assocs, prune, contracts, relinked }
    : null
}

// When an attribute's name/type/multiplicity/static or a class name is edited, update what depends on it.
// Ops are appended to the user's operation: one undo step, and undo/redo replay them as-is.
// Not emitted for undo/redo, so those never re-trigger it.
function onBeforeOperation (operation) {
  if (operation.bypass || duplicated()) return
  try {
    pending = capture(operation)
    const changedAttrs = new Map()
    const renamedClasses = []
    for (const op of operation.ops) {
      // Typed `Boolean`, `String`, `Integer`...: stored as PHP spells it (bool, string, int), whether set on its
      // own or with a new element ('I' = INSERT, serialized with its parameters)
      if (op.op === 'I') {
        for (const data of [op.arg, ...(op.arg.parameters || [])]) {
          if (['UMLAttribute', 'UMLParameter'].includes(data._type) && typeof data.type === 'string') data.type = normalType(data.type)
        }
      }
      if (op.op !== 'a') continue // 'a' = FIELD_ASSIGN
      const elem = app.repository.get(op.arg._id)
      if ((elem instanceof type.UMLAttribute || elem instanceof type.UMLParameter) && op.arg.f === 'type' && typeof op.arg.n === 'string') {
        op.arg.n = normalType(op.arg.n)
      }
      if (isClassAttribute(elem) && ['name', 'type', 'multiplicity', 'isStatic'].includes(op.arg.f)) {
        // Two attributes with one name would share their getters/setters: keep the old name
        if (op.arg.f === 'name' && op.arg.n !== op.arg.o && elem._parent.attributes.some(a => a !== elem && a.name === op.arg.n)) {
          app.toast.warning(`« ${op.arg.n} » existe déjà dans ${elem._parent.name} : renommage annulé.`)
          op.arg.n = op.arg.o
          continue
        }
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
    const warnings = []
    for (const [attr, values] of changedAttrs) {
      const cls = attr._parent
      const next = { name: attr.name, type: attr.type, multiplicity: attr.multiplicity, isStatic: attr.isStatic, ...values }
      warnings.push(...applyChanges(builder, planSync(attr, next, cls.operations, ctorNames(cls))))
      // Subclasses: only their constructor carries the inherited attribute
      for (const child of descendantsOf(cls)) {
        warnings.push(...applyChanges(builder, planSync(attr, next, ctorOnly(child), ctorNames(child))))
      }
    }
    if (warnings.length > 0) {
      app.toast.warning(`Déjà pris, non renommé : ${[...new Set(warnings)].join(', ')}`)
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

// After the user's operation, through public APIs whose own events cascade (getters, setters, constructor
// params); everything joins the user's undo step.
function onOperationExecuted (operation) {
  if (!pending || pending.operation !== operation) return
  const { attrs, assocFields, inheritances, assocs, prune, contracts, relinked } = pending
  pending = null // nested operations below capture their own
  const alive = e => !!app.repository.get(e._id)
  try {
    joinUndoStep(operation, () => {
      // Deleted attribute: its getter, setter and constructor params (subclasses too).
      // Deleted association: the attribute it generated, with its methods.
      const orphans = []
      for (const { cls, name, type: t } of assocFields) {
        const attr = alive(cls) && cls.attributes.find(a => a.name === name && a.type === t)
        if (attr) orphans.push(attr, ...deletedWith(attr, cls.operations))
      }
      for (const { cls, name, type: t } of attrs) {
        if (!alive(cls)) continue
        orphans.push(...deletedWith({ name, type: t }, cls.operations))
        for (const child of descendantsOf(cls)) orphans.push(...deletedWith({ name }, ctorOnly(child)))
      }
      // Copies of a method deleted, no longer abstract, or no longer implemented (inheritance or realization
      // deleted or reconnected, interface no longer extended)
      for (const cls of [...prune].filter(alive)) orphans.push(...staleCopies(cls.operations, contractSources(cls)))
      if (orphans.length > 0) app.engine.deleteElements([...new Set(orphans)], [])

      // Edited interface/abstract method: its copies follow (name, static, parameters); new abstract one: copied
      const live = [...contracts].filter(op => alive(op) && isContract(op))
      if (live.length > 0) {
        runOperation('sync implementations', builder => {
          for (const op of live) {
            for (const impl of implementersOf(op._parent)) {
              const copy = impl.operations.find(o => copySource(o) === op)
              if (copy) {
                applyChanges(builder, syncImplementation(op, copy, impl.operations))
              } else if (requiredOps(impl, ancestorsOf(impl), interfacesOf(impl)).includes(op)) {
                insertOperation(builder, impl, opSpec(op))
              }
            }
          }
        })
      }

      // Inheritance deleted or reconnected: params no longer inherited leave the constructors; the child gets its id back
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
      // Reconnected: as if just drawn (new parent's params and id, methods to implement)
      for (const rel of relinked) if (alive(rel)) onRelationship(rel)

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
    })
  } catch (err) {
    console.error('uml-helpers: reconcile failed', err)
  }
}

// Lists the problems of the classes and associations of the current diagram, selects the first one
function checkDiagram () {
  const diagram = app.diagrams.getCurrentDiagram()
  if (!diagram) {
    app.toast.warning('Aucun diagramme ouvert.')
    return
  }
  const problems = []
  for (const cls of new Set(diagramClasses(diagram))) {
    const contracts = [...ancestorsOf(cls), ...interfacesOf(cls)].flatMap(c => c.operations.map(o => o.name))
    const required = requiredOps(cls, ancestorsOf(cls), interfacesOf(cls))
    problems.push(...lintClass(cls, inheritedAttrs(cls), contracts, required), ...lintRoleClashes(cls, associationsOf(cls)))
  }
  for (const assoc of new Set(diagram.ownedViews.filter(v => v instanceof type.UMLAssociationView).map(v => v.model))) {
    problems.push(...lintAssociation(assoc))
  }
  if (problems.length === 0) {
    app.toast.info('Aucun problème trouvé.')
    return
  }
  app.modelExplorer.select(problems[0].elem, true)
  app.dialogs.showTextDialog(`${problems.length} problème(s) :`, problems.map(p => '• ' + p.message).join('\n'))
}

// Runs every automatic behavior on a temporary model of the open project, then deletes it
async function selfTest () {
  if (app.dialogs.showConfirmDialog('Le test crée puis supprime un modèle temporaire dans le projet ouvert ' +
    '(idéalement un projet vide). Continuer ?') !== 'ok') return
  const results = []
  const check = (label, ok) => results.push(`${ok ? '✓' : '✗'} ${label}`)
  const has = (cls, name) => cls.operations.some(o => o.name === name)
  const attr = (cls, name) => cls.attributes.find(a => a.name === name)
  const ctorParams = cls => JSON.stringify((ctorOnly(cls)[0] || { parameters: [] }).parameters.map(p => p.name))
  let root
  try {
    root = app.factory.createModel({ id: 'UMLModel', parent: app.project.getProject() })
    const diagram = app.factory.createDiagram({ id: 'UMLClassDiagram', parent: root })
    const node = (id, x, name) => {
      const view = app.factory.createModelAndView({ id, parent: root, diagram, x1: x, y1: 20, x2: x + 180, y2: 160 })
      app.engine.setProperty(view.model, 'name', name)
      return view
    }
    const edge = (id, tail, head) => app.factory.createModelAndView({
      id, parent: tail.model, diagram, tailView: tail, headView: head, tailModel: tail.model, headModel: head.model
    })
    const newAttr = (cls, name, t) => {
      const a = app.factory.createModel({ id: 'UMLAttribute', parent: cls, field: 'attributes' })
      app.engine.setProperties(a, { name, type: t })
      return a
    }
    const newOp = (owner, name) =>
      app.factory.createModel({ id: 'UMLOperation', parent: owner, field: 'operations', modelInitializer: m => { m.name = name } })

    const pView = node('UMLClass', 20, 'Produit')
    const P = pView.model
    check('Nouvelle classe : -id: ?int, getId(), setId()', attr(P, 'id') && attr(P, 'id').type === '?int' && has(P, 'getId') && has(P, 'setId'))
    const nom = newAttr(P, 'nom', 'string')
    check('Nouvel attribut : getNom(), setNom()', has(P, 'getNom') && has(P, 'setNom') && !has(P, 'getAttribute1'))
    generate(ALL, [P])
    check('__construct(nom), sans id', ctorParams(P) === '["nom"]')
    app.engine.setProperty(nom, 'type', '?string')
    check('?string : sort du constructeur', ctorParams(P) === '[]')
    app.engine.setProperty(nom, 'type', 'string')
    check('string : revient dans le constructeur', ctorParams(P) === '["nom"]')
    app.engine.setProperty(nom, 'name', 'libelle')
    check('Renommage : getLibelle(), setLibelle(), param libelle', has(P, 'getLibelle') && has(P, 'setLibelle') && !has(P, 'getNom') && ctorParams(P) === '["libelle"]')
    const actif = newAttr(P, 'actif', 'string')
    app.engine.setProperty(actif, 'type', 'bool')
    check('Type bool : getActif() devient isActif()', has(P, 'isActif') && !has(P, 'getActif'))
    app.engine.setProperty(actif, 'isStatic', true)
    check('Statique : isActif() devient statique, hors constructeur', P.operations.find(o => o.name === 'isActif').isStatic === true && ctorParams(P) === '["libelle"]')
    const prix = newAttr(P, 'prix', 'float')
    app.engine.setProperty(prix, 'name', 'libelle')
    check('Nom déjà pris : renommage annulé', prix.name === 'prix' && P.operations.filter(o => o.name === 'getLibelle').length === 1)
    app.engine.deleteElements([prix], [])
    check('Suppression : getPrix(), setPrix() et param supprimés', !has(P, 'getPrix') && !has(P, 'setPrix') && ctorParams(P) === '["libelle"]')
    const dispo = newAttr(P, 'dispo', 'Boolean')
    check('Type « Boolean » enregistré « bool » : isDispo()', dispo.type === 'bool' && has(P, 'isDispo'))
    app.engine.deleteElements([dispo], [])
    app.repository.undo()
    check('Un seul Ctrl+Z annule la suppression : attribut, isDispo() et param revenus',
      attr(P, 'dispo') && has(P, 'isDispo') && ctorParams(P) === '["libelle","dispo"]')
    app.engine.deleteElements([attr(P, 'dispo')], [])

    const cView = node('UMLClass', 260, 'Categorie')
    const C = cView.model
    const assoc = edge('UMLAssociation', cView, pView).model
    app.engine.setProperty(assoc.end1, 'multiplicity', '1')
    app.engine.setProperty(assoc.end2, 'multiplicity', '0..*')
    app.engine.setProperty(assoc.end2, 'aggregation', 'shared')
    generate(ALL, [P, C])
    check('Agrégation : -categorie: ?Categorie côté losange seulement', attr(P, 'categorie') && attr(P, 'categorie').type === '?Categorie' && has(P, 'getCategorie') && C.attributes.length === 1)
    check('Méthodes rangées : __construct, accesseurs par attribut, __toString()', P.operations.map(o => o.name).join(', ') ===
      '__construct, getId, setId, getLibelle, setLibelle, isActif, setActif, getCategorie, setCategorie, __toString')
    app.engine.setProperty(assoc.end2, 'aggregation', 'composite')
    check('Composition : -categorie: Categorie sans ?, dans le constructeur', attr(P, 'categorie') && attr(P, 'categorie').type === 'Categorie' && ctorParams(P) === '["libelle","categorie"]')
    app.engine.setProperty(assoc.end2, 'aggregation', 'shared')
    app.engine.setProperty(assoc.end1, 'multiplicity', '0..*')
    check('0..* : -categories: array<Categorie>, addCategorie(), removeCategorie()', attr(P, 'categories') && attr(P, 'categories').type === 'array<Categorie>' && has(P, 'addCategorie') && has(P, 'removeCategorie') && !attr(P, 'categorie'))
    app.engine.setProperty(C, 'name', 'Famille')
    check('Classe renommée : -familles: array<Famille>, addFamille()', attr(P, 'familles') && attr(P, 'familles').type === 'array<Famille>' && has(P, 'addFamille'))
    app.engine.setProperty(assoc.end1, 'multiplicity', '1')
    check('Retour à 1 : -famille: ?Famille, plus de addFamille()', attr(P, 'famille') && attr(P, 'famille').type === '?Famille' && !has(P, 'addFamille'))
    app.engine.deleteElements([assoc], [])
    check('Association supprimée : attribut et méthodes supprimés', !attr(P, 'famille') && !has(P, 'getFamille'))

    // Two compositions Chocoblast ◆── User: one -user until the roles are named
    const uView = node('UMLClass', 980, 'User')
    const kView = node('UMLClass', 1220, 'Chocoblast')
    const K = kView.model
    const blast = () => {
      const a = edge('UMLAssociation', uView, kView).model
      app.engine.setProperty(a.end1, 'multiplicity', '1')
      app.engine.setProperty(a.end2, 'aggregation', 'composite')
      return a
    }
    const [b1, b2] = [blast(), blast()]
    generate(ALL, [K])
    check('2 compositions vers User : un seul -user, 2 rôles à nommer, signalé par Check Diagram', attr(K, 'user') && K.attributes.length === 2 &&
      roleClashes(K, [b1, b2]).length === 2 && lintRoleClashes(K, associationsOf(K)).length === 1)
    // The naming dialog, answered by the test
    const showInputDialog = app.dialogs.showInputDialog
    const answers = ['target', 'blasted']
    app.dialogs.showInputDialog = () => Promise.resolve({ buttonId: 'ok', returnValue: answers.shift() })
    try {
      await generateNaming(ALL, [K])
    } finally {
      app.dialogs.showInputDialog = showInputDialog
    }
    const named = () => attr(K, 'target') && attr(K, 'blasted') && attr(K, 'blasted').type === 'User' && !attr(K, 'user') &&
      has(K, 'getBlasted') && ctorParams(K) === '["target","blasted"]'
    check('Noms demandés : -target: User, -blasted: User, __construct(target, blasted)', named())
    app.repository.undo()
    check('Un seul Ctrl+Z annule noms et génération : -user revenu', attr(K, 'user') && !attr(K, 'target') && !attr(K, 'blasted') && !b1.end1.name)
    app.repository.redo()
    check('Rétablir : -target et -blasted revenus', named())
    app.engine.deleteElements([b2], [])
    check('2e composition supprimée : -blasted supprimé, -target reste', !attr(K, 'blasted') && attr(K, 'target'))

    // Parent and child generated together (Generate for Whole Diagram), both getting an attribute
    const aView = node('UMLClass', 1700, 'Animal')
    const dView = node('UMLClass', 1940, 'Chien')
    const [A, D] = [aView.model, dView.model]
    newAttr(A, 'nom', 'string')
    newAttr(D, 'race', 'string')
    edge('UMLGeneralization', dView, aView)
    generate(ALL, [D])
    for (const [holder, part] of [[aView, cView], [dView, uView]]) {
      const a = edge('UMLAssociation', part, holder).model
      app.engine.setProperty(a.end1, 'multiplicity', '1')
      app.engine.setProperty(a.end2, 'aggregation', 'composite')
    }
    generate(ALL, [A, D])
    check('Parent et fille générés ensemble : Chien::__construct(nom, famille, race, user)',
      ctorParams(D) === '["nom","famille","race","user"]' && ctorParams(A) === '["nom","famille"]')

    const eView = node('UMLClass', 500, 'Employe')
    const E = eView.model
    newAttr(E, 'salaire', 'float')
    const gen = edge('UMLGeneralization', eView, pView).model
    check('Héritage : -id retiré de l\'enfant', !attr(E, 'id') && !has(E, 'getId'))
    generate(ALL, [E])
    check('Enfant : __construct(libelle, salaire)', ctorParams(E) === '["libelle","salaire"]')
    newAttr(P, 'ville', 'string')
    check('Attribut ajouté au parent : param ville dans l\'enfant', ctorParams(E) === '["libelle","ville","salaire"]')
    const compo = edge('UMLAssociation', cView, pView).model
    app.engine.setProperty(compo.end1, 'multiplicity', '1')
    app.engine.setProperty(compo.end2, 'aggregation', 'composite')
    generate(ALL, [P])
    check('Composition générée dans le parent : param famille dans l\'enfant', ctorParams(E) === '["libelle","ville","famille","salaire"]')
    app.engine.deleteElements([compo], [])
    check('Composition supprimée : param famille retiré de l\'enfant', ctorParams(E) === '["libelle","ville","salaire"]')
    const abs = app.factory.createModel({ id: 'UMLOperation', parent: P, field: 'operations' })
    app.engine.setProperties(abs, { name: 'calculer', isAbstract: true })
    check('Méthode abstraite : calculer() copiée dans l\'enfant', has(E, 'calculer'))
    app.engine.setProperty(gen, 'target', C)
    check('Héritage rebranché sur Famille : params de Produit et calculer() retirés',
      ctorParams(E) === '["salaire"]' && !has(E, 'calculer') && !attr(E, 'id'))
    app.engine.setProperty(gen, 'target', P)
    check('Héritage rebranché sur Produit : params et calculer() revenus', ctorParams(E) === '["libelle","ville","salaire"]' && has(E, 'calculer'))
    app.engine.deleteElements([gen], [])
    check('Héritage supprimé : params hérités retirés, id remis', ctorParams(E) === '["salaire"]' && attr(E, 'id') && has(E, 'getId'))

    const iView = node('UMLInterface', 740, 'Affichable')
    const opI = app.factory.createModel({ id: 'UMLOperation', parent: iView.model, field: 'operations' })
    app.engine.setProperty(opI, 'name', 'afficher')
    const real = edge('UMLInterfaceRealization', eView, iView).model
    check('Interface : afficher() copiée', has(E, 'afficher'))
    app.engine.setProperty(opI, 'name', 'imprimer')
    check('Méthode d\'interface renommée : la copie suit', has(E, 'imprimer') && !has(E, 'afficher'))
    app.engine.deleteElements([opI], [])
    check('Méthode d\'interface supprimée : copie supprimée', !has(E, 'imprimer'))
    newOp(E, 'decrire')
    const opD = newOp(iView.model, 'decrire')
    app.engine.setProperty(opD, 'name', 'resumer')
    check('decrire() écrite à la main, même nom qu\'une méthode d\'interface : pas alignée', has(E, 'decrire') && has(E, 'resumer'))
    const xView = node('UMLInterface', 2180, 'Exportable')
    newOp(xView.model, 'exporter')
    const ext = edge('UMLGeneralization', iView, xView).model
    check('Interface qui en étend une autre : exporter() copiée', has(E, 'exporter'))
    app.engine.deleteElements([ext], [])
    check('Extension d\'interface supprimée : exporter() retirée', !has(E, 'exporter'))
    app.engine.deleteElements([real], [])
    check('Flèche « implémente » supprimée : resumer() retirée, decrire() gardée', !has(E, 'resumer') && has(E, 'decrire'))

    const bad = newAttr(E, 'Mauvais', '')
    const problems = lintClass(E, inheritedAttrs(E), [], [])
    check('Vérifier : nom et type manquant signalés', problems.filter(p => p.elem === bad).length === 2)
  } catch (err) {
    check(`Erreur : ${err.message}`, false)
    console.error(err)
  } finally {
    if (root) app.engine.deleteElements([root], [])
  }
  const failed = results.filter(r => r.startsWith('✗')).length
  app.dialogs.showTextDialog(failed > 0 ? `${failed} test(s) en échec` : 'Tous les tests passent', results.join('\n'))
}

// Two copies loaded would make every change twice (duplicate params, methods): the package was named
// staruml.uml-helpers before 0.9.0, so updating through Install From URL keeps the old one too
const warnDuplicate = () => app.dialogs.showAlertDialog('UML Class Helper est installé deux fois (ancien nom : « UML Helpers »). ' +
  'Désinstallez l\'ancienne version dans Tools → Extension Manager → Installed, puis redémarrez StarUML.')
let duplicate
function duplicated () {
  if (duplicate === undefined) {
    // The old copy's listener has the same name; checked at the first change, once every extension is loaded
    duplicate = app.repository.listeners('beforeExecuteOperation').some(f => f.name === 'onBeforeOperation' && f !== onBeforeOperation)
    if (duplicate) warnDuplicate()
  }
  return duplicate
}

function init () {
  // A second copy of this version: the first one loaded does the work
  if (global.umlClassHelperLoaded) return warnDuplicate()
  global.umlClassHelperLoaded = true
  app.factory.on('elementCreated', onElementCreated)
  app.repository.on('beforeExecuteOperation', onBeforeOperation)
  app.repository.on('operationExecuted', onOperationExecuted)
  app.commands.register('uml-helpers:accessors', () => generateNaming(ALL), 'Generate Constructor, Getters & Setters')
  app.commands.register('uml-helpers:constructor', () => generateNaming({ ctor: true, getters: false, setters: false }), 'Generate Constructor')
  app.commands.register('uml-helpers:getters', () => generateNaming({ getters: true, setters: false }), 'Generate Getters')
  app.commands.register('uml-helpers:setters', () => generateNaming({ getters: false, setters: true }), 'Generate Setters')
  app.commands.register('uml-helpers:diagram', generateDiagram, 'Generate for Whole Diagram')
  app.commands.register('uml-helpers:check', checkDiagram, 'Check Diagram')
  app.commands.register('uml-helpers:self-test', selfTest, 'Run Self-Test')
}

exports.init = init
