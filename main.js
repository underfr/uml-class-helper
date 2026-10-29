const { planAccessors, associationFields, missingAttributes, planSync, deletedWith } = require('./accessors')

// Classifier -> { attrs to process, newAttrs to create }: the selected attributes, or every
// attribute of a selected class plus its navigable association ends not yet declared as attributes
function selectedTargets () {
  const targets = new Map()
  for (const elem of app.selections.getSelectedModels()) {
    if (elem instanceof type.UMLAttribute && elem._parent instanceof type.UMLClassifier) {
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

function generate (options) {
  const targets = selectedTargets()
  if (targets.size === 0) {
    app.toast.warning('Sélectionnez une classe ou des attributs.')
    return
  }
  // One builder = one undo step (Ctrl+Z removes everything generated)
  const builder = app.repository.getOperationBuilder()
  builder.begin('generate accessors')
  let count = 0
  for (const [cls, { attrs, newAttrs }] of targets) {
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
  }
  builder.end()
  if (count > 0) {
    app.repository.doOperation(builder.getOperation())
    app.toast.info(`${count} élément(s) généré(s).`)
  } else {
    app.toast.info('Rien à générer (déjà présents).')
  }
}

// New classes start with -id: ?int (separate undo step, created right after the class)
function addIdAttribute (model) {
  if (!(model instanceof type.UMLClass) || model.attributes.some(a => a.name === 'id')) return
  const attr = Object.assign(new type.UMLAttribute(), { _parent: model, name: 'id', visibility: 'private', type: '?int' })
  const builder = app.repository.getOperationBuilder()
  builder.begin('add id')
  builder.insert(attr)
  builder.fieldInsertAt(model, 'attributes', attr, 0)
  builder.end()
  app.repository.doOperation(builder.getOperation())
}

const isClassAttribute = e => e instanceof type.UMLAttribute && e._parent instanceof type.UMLClassifier

// Attribute deletions seen in beforeExecuteOperation, handled once that operation has run
let pendingDelete = null

// When an attribute's name/type/multiplicity is edited, update its getter, setter and __construct param.
// Ops are appended to the user's operation: one undo step, and undo/redo replay them as-is.
// Not emitted for undo/redo, so those never re-trigger it.
function onBeforeOperation (operation) {
  if (operation.bypass) return
  try {
    const removed = new Set(operation.ops.filter(op => op.op === 'R').map(op => op.arg._id)) // 'R' = REMOVE
    const deleted = [...removed].map(id => app.repository.get(id))
      .filter(e => isClassAttribute(e) && !removed.has(e._parent._id))
    pendingDelete = deleted.length > 0 ? { operation, attrs: deleted.map(a => ({ cls: a._parent, name: a.name })) } : null

    const changed = new Map()
    for (const op of operation.ops) {
      if (op.op !== 'a' || !['name', 'type', 'multiplicity'].includes(op.arg.f)) continue // 'a' = FIELD_ASSIGN
      const attr = app.repository.get(op.arg._id)
      if (!isClassAttribute(attr)) continue
      if (!changed.has(attr)) changed.set(attr, {})
      changed.get(attr)[op.arg.f] = op.arg.n
    }
    if (changed.size === 0) return
    // Private builder: the shared one may still belong to the caller
    const builder = new (app.repository.getOperationBuilder().constructor)()
    builder.begin('sync accessors')
    for (const [attr, values] of changed) {
      const cls = attr._parent
      const next = { name: attr.name, type: attr.type, multiplicity: attr.multiplicity, isStatic: attr.isStatic, ...values }
      for (const c of planSync(attr, next, cls.operations, cls.attributes.map(a => a.name))) {
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
    builder.end()
    operation.ops.push(...builder.getOperation().ops)
  } catch (err) {
    // Never block the user's own edit
    console.error('uml-helpers: sync failed', err)
  }
}

// After an attribute is deleted, delete its getter, setter and __construct param.
// Separate operation through the engine, which also removes their views (second undo step).
function onOperationExecuted (operation) {
  if (!pendingDelete || pendingDelete.operation !== operation) return
  const { attrs } = pendingDelete
  pendingDelete = null
  try {
    const orphans = attrs.flatMap(({ cls, name }) => deletedWith({ name }, cls.operations))
    if (orphans.length > 0) app.engine.deleteElements(orphans, [])
  } catch (err) {
    console.error('uml-helpers: delete failed', err)
  }
}

function init () {
  app.factory.on('elementCreated', addIdAttribute)
  app.repository.on('beforeExecuteOperation', onBeforeOperation)
  app.repository.on('operationExecuted', onOperationExecuted)
  app.commands.register('uml-helpers:accessors', () => generate({ ctor: true, getters: true, setters: true }), 'Generate Constructor, Getters & Setters')
  app.commands.register('uml-helpers:constructor', () => generate({ ctor: true, getters: false, setters: false }), 'Generate Constructor')
  app.commands.register('uml-helpers:getters', () => generate({ getters: true, setters: false }), 'Generate Getters')
  app.commands.register('uml-helpers:setters', () => generate({ getters: false, setters: true }), 'Generate Setters')
}

exports.init = init
