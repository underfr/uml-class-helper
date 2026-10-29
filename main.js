const { planAccessors, associationFields, missingAttributes } = require('./accessors')

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

function init () {
  app.commands.register('uml-helpers:accessors', () => generate({ ctor: true, getters: true, setters: true }), 'Generate Constructor, Getters & Setters')
  app.commands.register('uml-helpers:constructor', () => generate({ ctor: true, getters: false, setters: false }), 'Generate Constructor')
  app.commands.register('uml-helpers:getters', () => generate({ getters: true, setters: false }), 'Generate Getters')
  app.commands.register('uml-helpers:setters', () => generate({ getters: false, setters: true }), 'Generate Setters')
}

exports.init = init
