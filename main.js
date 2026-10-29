const { planAccessors, associationFields, missingAttributes, planSync, deletedWith, renamedType } = require('./accessors')

const ALL = { ctor: true, getters: true, setters: true }
const isClassAttribute = e => e instanceof type.UMLAttribute && e._parent instanceof type.UMLClassifier

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
  for (const spec of planAccessors(attrs, cls.operations.map(o => o.name), options)) {
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

// Right after the user creates an element (separate undo step):
// a class gets -id: ?int with its getter/setter, an attribute gets its getter/setter and constructor param
function onElementCreated (model) {
  try {
    if (model instanceof type.UMLClass && !model.attributes.some(a => a.name === 'id')) {
      const id = Object.assign(new type.UMLAttribute(), { _parent: model, name: 'id', visibility: 'private', type: '?int' })
      runOperation('add id', builder => {
        builder.insert(id)
        builder.fieldInsertAt(model, 'attributes', id, 0)
        addGenerated(builder, model, { attrs: [id], newAttrs: [] }, { getters: true, setters: true })
      })
    } else if (isClassAttribute(model)) {
      const cls = model._parent
      runOperation('add accessors', builder => {
        addGenerated(builder, cls, { attrs: [model], newAttrs: [] }, { getters: true, setters: true })
        // Only adds the param to an existing constructor
        applyChanges(builder, planSync(model, model, cls.operations, cls.attributes.map(a => a.name)))
      })
    }
  } catch (err) {
    console.error('uml-helpers: generation on create failed', err)
  }
}

// Deletions seen in beforeExecuteOperation, cleaned up once that operation has run
let pendingDelete = null

function planDeletes (operation) {
  const removedIds = new Set(operation.ops.filter(op => op.op === 'R').map(op => op.arg._id)) // 'R' = REMOVE
  const removed = [...removedIds].map(id => app.repository.get(id)).filter(Boolean)
  // Attributes deleted on their own (not along with their class)
  const attrs = removed.filter(e => isClassAttribute(e) && !removedIds.has(e._parent._id))
    .map(a => ({ cls: a._parent, name: a.name }))
  // Associations deleted, including those owned by a deleted class: the attribute they generated
  const assocFields = []
  for (const root of removed) {
    root.traverse(e => {
      if (!(e instanceof type.UMLAssociation)) return
      for (const cls of new Set([e.end1.reference, e.end2.reference])) {
        for (const f of associationFields(cls, [e])) assocFields.push({ cls, name: f.name, type: f.type })
      }
    })
  }
  return attrs.length + assocFields.length > 0 ? { operation, attrs, assocFields } : null
}

// When an attribute's name/type/multiplicity or a class name is edited, update what depends on it.
// Ops are appended to the user's operation: one undo step, and undo/redo replay them as-is.
// Not emitted for undo/redo, so those never re-trigger it.
function onBeforeOperation (operation) {
  if (operation.bypass) return
  try {
    pendingDelete = planDeletes(operation)
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
      applyChanges(builder, planSync(attr, next, cls.operations, cls.attributes.map(a => a.name)))
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

// After a deletion: remove the getter, setter and constructor param of deleted attributes, and the
// attribute (with its methods) generated by a deleted association.
// Separate operation through the engine, which also removes their views (second undo step).
function onOperationExecuted (operation) {
  if (!pendingDelete || pendingDelete.operation !== operation) return
  const { attrs, assocFields } = pendingDelete
  pendingDelete = null
  try {
    const alive = cls => app.repository.get(cls._id)
    const orphans = []
    for (const { cls, name, type: t } of assocFields) {
      const attr = alive(cls) && cls.attributes.find(a => a.name === name && a.type === t)
      if (attr) orphans.push(attr, ...deletedWith(attr, cls.operations))
    }
    for (const { cls, name } of attrs) {
      if (alive(cls)) orphans.push(...deletedWith({ name }, cls.operations))
    }
    if (orphans.length > 0) app.engine.deleteElements([...new Set(orphans)], [])
  } catch (err) {
    console.error('uml-helpers: delete failed', err)
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
