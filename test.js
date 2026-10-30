// Run: node test.js
const assert = require('assert')
const {
  planAccessors, associationFields, heldFields, planAssocUpdate, missingAttributes, planSync, deletedWith,
  renamedType, planInheritedParams, droppedInheritedParams, plural, singular,
  opSpec, requiredOps, syncImplementation, lintClass, lintAssociation
} = require('./accessors')

const names = specs => specs.map(s => s.name)
const byName = (specs, name) => specs.find(s => s.name === name)
const attrs = [
  { name: 'id', type: '?int', multiplicity: '' },
  { name: 'dateDebut', type: 'DateTime', multiplicity: '' },
  { name: '_age', type: 'int', multiplicity: '' },
  { name: 'actif', type: '?bool', multiplicity: '' },
  { name: 'code', type: 'string', multiplicity: '', isReadOnly: true },
  { name: 'compteur', type: 'int', multiplicity: '', isStatic: true },
  { name: 'adresse', type: { name: 'Adresse' }, multiplicity: '' },
  { name: '', type: 'int', multiplicity: '' }
]

const all = planAccessors(attrs, [], { ctor: true })
assert.deepStrictEqual(names(all), [
  'getId', 'setId', 'getDateDebut', 'setDateDebut', 'getAge', 'setAge', 'isActif', 'setActif',
  'getCode', 'getCompteur', 'setCompteur', 'getAdresse', 'setAdresse', '__construct'
])
// __construct(dateDebut: DateTime, age: int, code: string, adresse: Adresse): nullable and static excluded
const ctor = byName(all, '__construct')
assert.deepStrictEqual(ctor.params.map(p => p.name), ['dateDebut', 'age', 'code', 'adresse'])
assert.strictEqual(ctor.atStart, true)
// setId(id: ?int): void
assert.deepStrictEqual(byName(all, 'setId').params, [
  { name: 'id', type: '?int', multiplicity: '' },
  { name: '', type: 'void', direction: 'return' }
])
// getId(): ?int
assert.deepStrictEqual(byName(all, 'getId').params, [{ name: '', type: '?int', multiplicity: '', direction: 'return' }])
assert.strictEqual(byName(all, 'getCompteur').isStatic, true)

// Existing names skipped, options respected
assert.deepStrictEqual(names(planAccessors(attrs, ['getId', '__construct'], { ctor: true, setters: false })), [
  'getDateDebut', 'getAge', 'isActif', 'getCode', 'getCompteur', 'getAdresse'
])
assert.deepStrictEqual(names(planAccessors(attrs.slice(0, 1), [], { getters: false })), ['setId'])
// Same attribute selected twice (class + attribute) yields one getter
assert.deepStrictEqual(names(planAccessors([attrs[1], attrs[1]], [], { setters: false })), ['getDateDebut'])

// Multiplicity with lower bound 0 is optional too: not in the constructor
assert.deepStrictEqual(byName(planAccessors([
  { name: 'note', type: 'int', multiplicity: '0..1' },
  { name: 'tags', type: 'string', multiplicity: '*' },
  { name: 'roles', type: 'string', multiplicity: '1..*' }
], [], { ctor: true }), '__construct').params.map(p => p.name), ['roles'])

// Association ends
const [Personne, Adresse, Commande, Categorie, Produit, Ligne, Ticket, Vendeur] =
  ['Personne', 'Adresse', 'Commande', 'Categorie', 'Produit', 'ProduitTicketQuantite', 'Ticket', 'Vendeur'].map(name => ({ name }))
const end = (reference, multiplicity = '', extra = {}) =>
  ({ reference, multiplicity, navigable: 'unspecified', aggregation: 'none', name: '', isReadOnly: false, ...extra })
const fieldNames = (cls, list) => associationFields(cls, list).map(f => f.name)

// Aggregations from the reported diagram (StarUML's Aggregation tool puts the diamond on end2):
// the class on the diamond side holds the other one, never the reverse
const shared = { aggregation: 'shared' }
const diagram = [
  { end1: end(Categorie, '1'), end2: end(Produit, '0..*', shared) },
  { end1: end(Produit, '1'), end2: end(Ligne, '0..*', shared) },
  { end1: end(Ticket, '1'), end2: end(Ligne, '0..*', shared) },
  { end1: end(Vendeur, '1'), end2: end(Ticket, '0..*', shared) }
]
assert.deepStrictEqual(fieldNames(Produit, diagram), ['categorie'])
assert.deepStrictEqual(fieldNames(Ligne, diagram), ['produit', 'ticket'])
assert.deepStrictEqual(fieldNames(Ticket, diagram), ['vendeur'])
assert.deepStrictEqual(fieldNames(Categorie, diagram), [])
assert.deepStrictEqual(fieldNames(Vendeur, diagram), [])
assert.deepStrictEqual(fieldNames(Produit, [{ end1: end(Categorie), end2: end(Produit, '', { aggregation: 'composite' }) }]), ['categorie'])

// Arrows win: Personne --> Adresse "domicile", Personne --> Commande 0..*, Personne x-- Adresse
const assocs = [
  { end1: end(Personne), end2: end(Adresse, '1', { navigable: 'navigable', name: 'domicile' }) },
  { end1: end(Personne), end2: end(Commande, '0..*', { navigable: 'navigable' }) },
  { end1: end(Personne), end2: end(Adresse, '', { navigable: 'notNavigable', name: 'ancienne' }) }
]
const fields = associationFields(Personne, assocs)
assert.deepStrictEqual(fields.map(f => f.name), ['domicile', 'commandes'])
assert.strictEqual(fields[0].type, '?Adresse')
assert.deepStrictEqual(associationFields(Adresse, assocs.slice(0, 1)), [])
// Only the crossed side is blocked
assert.deepStrictEqual(fieldNames(Adresse, assocs.slice(2)), ['personne'])

// Plain association: the many side holds the one side; 1--1 goes both ways
const plain = [{ end1: end(Commande, '0..*'), end2: end(Personne, '1') }]
assert.deepStrictEqual(fieldNames(Commande, plain), ['personne'])
assert.deepStrictEqual(fieldNames(Personne, plain), [])
assert.deepStrictEqual(fieldNames(Personne, [{ end1: end(Personne, '1'), end2: end(Adresse, '1') }]), ['adresse'])
// Self-association: both ends belong to the class
assert.deepStrictEqual(fieldNames(Personne, [
  { end1: end(Personne, '', { name: 'parent' }), end2: end(Personne, '', { name: 'enfant' }) }
]), ['enfant', 'parent'])

// ?Adresse stays out of the constructor, array<Commande> goes in; getDomicile(): ?Adresse, setDomicile(domicile: ?Adresse): void
const assocSpecs = planAccessors(fields, [], { ctor: true })
assert.deepStrictEqual(byName(assocSpecs, '__construct').params.map(p => p.name), ['commandes'])
assert.deepStrictEqual(byName(assocSpecs, 'getDomicile').params, [
  { name: '', type: '?Adresse', multiplicity: '', direction: 'return' }
])
assert.deepStrictEqual(byName(assocSpecs, 'setDomicile').params[0], { name: 'domicile', type: '?Adresse', multiplicity: '' })
// No [0..*] copied from the association end
assert.strictEqual(byName(assocSpecs, 'getCommandes').params[0].multiplicity, '')

// -domicile: ?Adresse is created unless an attribute already has that name; duplicate roles collapse
assert.deepStrictEqual(missingAttributes([{ name: 'domicile' }], fields).map(f => f.name), ['commandes'])
assert.deepStrictEqual(missingAttributes([], [...fields, fields[1]]).map(f => f.name), ['domicile', 'commandes'])

// Sync after a type change
const P = (name, t, direction = 'in') => ({ name, type: t, multiplicity: '', direction })
const classOps = () => [
  { name: '__construct', parameters: [P('nom', 'string'), P('ville', 'string')] },
  { name: 'getNom', parameters: [P('', 'string', 'return')] },
  { name: 'setNom', parameters: [P('nom', 'string'), P('', 'void', 'return')] },
  { name: 'getId', parameters: [P('', '?int', 'return')] }
]
const attrNames = ['id', 'nom', 'ville']
const nom = { name: 'nom', type: 'string', multiplicity: '' }
const id = { name: 'id', type: '?int', multiplicity: '' }
const sync = (attr, next, ops = classOps()) => planSync(attr, { ...attr, ...next }, ops, attrNames)
// -nom: string -> -nom: int retypes getter, setter param and constructor param (not the void return)
let ops = classOps()
let changes = sync(nom, { type: 'int' }, ops)
assert.deepStrictEqual(changes.map(c => [c.assign, c.field, c.value]), [
  [ops[1].parameters[0], 'type', 'int'], [ops[2].parameters[0], 'type', 'int'], [ops[0].parameters[0], 'type', 'int']
])
// Unchanged: nothing to do
assert.deepStrictEqual(sync(nom, {}), [])
// -nom: ?string leaves the constructor
ops = classOps()
assert.deepStrictEqual(sync(nom, { type: '?string' }, ops).find(c => c.remove), { remove: ops[0].parameters[0], from: ops[0] })
// -id: int joins the constructor before nom
ops = classOps()
changes = sync(id, { type: 'int' }, ops)
assert.deepStrictEqual(changes.find(c => c.add), { add: { name: 'id', type: 'int', multiplicity: '' }, to: ops[0], index: 0 })
assert.strictEqual(changes.find(c => c.assign).assign, ops[3].parameters[0])
// No constructor in the class: none is created
assert.deepStrictEqual(sync(id, { type: 'int' }, classOps().slice(1)).filter(c => c.add), [])
// -nom renamed -test: getTest, setTest(test), __construct(test, ...)
ops = classOps()
assert.deepStrictEqual(sync(nom, { name: 'test' }, ops).map(c => [c.assign, c.field, c.value]), [
  [ops[1], 'name', 'getTest'], [ops[2], 'name', 'setTest'], [ops[2].parameters[0], 'name', 'test'], [ops[0].parameters[0], 'name', 'test']
])
// isActif keeps its "is" prefix when renamed
const isOps = [{ name: 'isActif', parameters: [P('', 'bool', 'return')] }]
assert.deepStrictEqual(planSync({ name: 'actif', type: 'bool', multiplicity: '' }, { name: 'present', type: 'bool', multiplicity: '' }, isOps, ['actif'])
  .map(c => c.value), ['isPresent'])

// Deleting -nom deletes getNom, setNom and its constructor param, nothing else
ops = classOps()
assert.deepStrictEqual(deletedWith(nom, ops), [ops[1], ops[2], ops[0].parameters[0]])
assert.deepStrictEqual(deletedWith({ name: 'ville' }, ops), [ops[0].parameters[1]])

// New attribute (type '' until edited) joins an existing constructor; nothing else to change
ops = classOps()
const fresh = { name: 'Attribute1', type: '', multiplicity: '' }
assert.deepStrictEqual(planSync(fresh, fresh, ops, [...attrNames, 'Attribute1']),
  [{ add: { name: 'Attribute1', type: '', multiplicity: '' }, to: ops[0], index: 2 }])

// Class rename updates text types only
assert.strictEqual(renamedType('?Categorie', 'Categorie', 'Famille'), '?Famille')
assert.strictEqual(renamedType('Categorie', 'Categorie', 'Famille'), 'Famille')
assert.strictEqual(renamedType('?CategorieMere', 'Categorie', 'Famille'), null)
assert.strictEqual(renamedType({ name: 'Categorie' }, 'Categorie', 'Famille'), null) // real reference: StarUML follows it

// Inheritance: Employe(salaire) extends Personne(id, nom, prenom)
const personne = [
  { name: 'id', type: '?int', multiplicity: '' },
  { name: 'nom', type: 'string', multiplicity: '' },
  { name: 'prenom', type: 'string', multiplicity: '' }
]
const salaire = { name: 'salaire', type: 'float', multiplicity: '' }
const employe = planAccessors([salaire], [], { ctor: true }, personne)
// getters/setters for own attributes only; constructor takes the parent's params first
assert.deepStrictEqual(names(employe), ['getSalaire', 'setSalaire', '__construct'])
assert.deepStrictEqual(byName(employe, '__construct').params.map(p => p.name), ['nom', 'prenom', 'salaire'])

// Generalization drawn after the child's constructor exists: inherited params inserted, in order
const childCtor = { name: '__construct', parameters: [P('salaire', 'float')] }
const childOps = [childCtor, { name: 'getNom', parameters: [P('', 'int', 'return')] }]
const inheritChanges = planInheritedParams(personne, childOps, ['id', 'nom', 'prenom', 'salaire'])
assert.ok(inheritChanges.every(c => c.add && c.to === childCtor)) // the child's own getNom is left alone
const applied = childCtor.parameters.map(p => p.name)
for (const c of inheritChanges) applied.splice(c.index, 0, c.add.name) // same order as StarUML applies them
assert.deepStrictEqual(applied, ['nom', 'prenom', 'salaire'])
// Already there: nothing
assert.deepStrictEqual(planInheritedParams(personne, [{ name: '__construct', parameters: [P('nom', 'string'), P('prenom', 'string')] }], ['id', 'nom', 'prenom']), [])

// Held end many -> array<T>, single -> ?T; many-to-many goes to the diamond side only
const Fournisseur = { name: 'Fournisseur' }
const manyToMany = [{ end1: end(Produit, '0..*'), end2: end(Fournisseur, '0..*', shared) }]
assert.deepStrictEqual(associationFields(Fournisseur, manyToMany).map(f => [f.name, f.type]), [['produits', 'array<Produit>']])
assert.deepStrictEqual(associationFields(Produit, manyToMany), [])
assert.strictEqual(associationFields(Produit, diagram)[0].type, '?Categorie') // 0..* -- 1
assert.strictEqual(associationFields(Produit, [{ end1: end(Categorie, '0..1'), end2: end(Produit, '0..*', shared) }])[0].type, '?Categorie')
// array<T> goes in the constructor
const arraySpecs = planAccessors([{ name: 'produit', type: 'array<Produit>', multiplicity: '' }], [], { ctor: true })
assert.deepStrictEqual(byName(arraySpecs, '__construct').params, [{ name: 'produit', type: 'array<Produit>', multiplicity: '' }])
assert.deepStrictEqual(byName(arraySpecs, 'getProduit').params[0].type, 'array<Produit>')
assert.strictEqual(renamedType('array<Produit>', 'Produit', 'Article'), 'array<Article>')

// Edited association: Categorie 1 --<> 0..* Produit, attribute -categorie: ?Categorie already generated
const generatedAttr = { name: 'categorie', type: '?Categorie' }
const edit = change => {
  const assoc = { end1: end(Categorie, '1'), end2: end(Produit, '0..*', shared) }
  const before = heldFields(assoc).map(h => ({ ...h, attr: generatedAttr }))
  change(assoc)
  return planAssocUpdate(before, heldFields(assoc))
}
// Role renamed -> attribute renamed
assert.deepStrictEqual(edit(a => { a.end1.name = 'famille' }).updates.map(u => [u.attr, u.next.name, u.next.type]),
  [[generatedAttr, 'famille', '?Categorie']])
// Multiplicity 1 -> 0..* -> retyped array<Categorie>
assert.deepStrictEqual(edit(a => { a.end1.multiplicity = '0..*' }).updates.map(u => u.next.type), ['array<Categorie>'])
// Diamond moved to Categorie -> removed from Produit, created in Categorie
let moved = edit(a => { a.end1.aggregation = 'shared'; a.end2.aggregation = 'none' })
assert.deepStrictEqual(moved.deletes, [{ attr: generatedAttr }])
assert.deepStrictEqual(moved.creates.map(c => [c.holder, c.field.name, c.field.type]), [[Categorie, 'produits', 'array<Produit>']])
// Nothing relevant changed -> nothing
assert.deepStrictEqual(edit(() => {}), { updates: [], deletes: [], creates: [] })
// Never generated -> left alone
const fresh2 = { end1: end(Categorie, '1'), end2: end(Produit, '0..*', shared) }
const freshBefore = heldFields(fresh2).map(h => ({ ...h, attr: undefined }))
fresh2.end1.name = 'famille'
assert.deepStrictEqual(planAssocUpdate(freshBefore, heldFields(fresh2)), { updates: [], deletes: [], creates: [] })
// 1--1 where the user deleted one side's attribute: editing a role does not bring it back
const oneToOne = { end1: end(Personne, '1'), end2: end(Adresse, '1') }
const partial = heldFields(oneToOne).map(h => ({ ...h, attr: h.holder === Personne ? { name: 'adresse' } : undefined }))
oneToOne.end2.name = 'domicile'
const partialPlan = planAssocUpdate(partial, heldFields(oneToOne))
assert.deepStrictEqual([partialPlan.updates.length, partialPlan.creates.length, partialPlan.deletes.length], [1, 0, 0])

// Inheritance deleted: Employe loses nom, prenom from its constructor, keeps its own salaire
const empCtor = { name: '__construct', parameters: [P('nom', 'string'), P('prenom', 'string'), P('salaire', 'float')] }
assert.deepStrictEqual(droppedInheritedParams(empCtor, ['id', 'nom', 'prenom'], [], ['salaire']).map(c => c.remove.name), ['nom', 'prenom'])
// Declared again in the child: kept
assert.deepStrictEqual(droppedInheritedParams(empCtor, ['nom'], [], ['nom', 'salaire']), [])
assert.deepStrictEqual(droppedInheritedParams(undefined, ['nom'], [], []), [])

// Plural / singular
assert.deepStrictEqual(['produit', 'journal', 'bureau', 'jeu', 'prix'].map(plural), ['produits', 'journaux', 'bureaux', 'jeux', 'prix'])
assert.deepStrictEqual(['produits', 'journaux', 'bureaux', 'jeux', 'prix'].map(singular), ['produit', 'journal', 'bureau', 'jeu', 'prix'])
assert.strictEqual(heldFields({ end1: end(Categorie, '1'), end2: end(Produit, '0..*', shared) })[0].field.name, 'categorie')
assert.strictEqual(heldFields({ end1: end(Categorie, '0..*'), end2: end(Produit, '0..*', shared) })[0].field.name, 'categories')

// add/remove generated for array<T>
const arr = { name: 'produits', type: 'array<Produit>', multiplicity: '' }
const arrSpecs = planAccessors([arr], [])
assert.deepStrictEqual(names(arrSpecs), ['getProduits', 'setProduits', 'addProduit', 'removeProduit'])
assert.deepStrictEqual(byName(arrSpecs, 'addProduit').params, [
  { name: 'produit', type: 'Produit', multiplicity: '' }, { name: '', type: 'void', direction: 'return' }
])
assert.deepStrictEqual(deletedWith(arr, [{ name: 'addProduit' }, { name: 'removeProduit' }, { name: 'other' }]).map(o => o.name), ['addProduit', 'removeProduit'])
// Not for a plain attribute that happens to share the name
assert.deepStrictEqual(deletedWith({ name: 'produit', type: '?Produit' }, [{ name: 'addProduit' }]), [])

// Sync: ?T -> array<T> creates add/remove; array<T> -> ?T removes them; rename follows
const setterOp = { name: 'setCategorie', parameters: [P('categorie', '?Categorie'), P('', 'void', 'return')], _parent: 'cls' }
const one = { name: 'categorie', type: '?Categorie', multiplicity: '' }
let synced = planSync(one, { ...one, name: 'categories', type: 'array<Categorie>' }, [setterOp], ['categorie'])
assert.deepStrictEqual(synced.filter(c => c.createOp).map(c => [c.createOp.name, c.createOp.params[0].type, c.in]),
  [['addCategorie', 'Categorie', 'cls'], ['removeCategorie', 'Categorie', 'cls']])
const adder = { name: 'addCategorie', parameters: [P('categorie', 'Categorie'), P('', 'void', 'return')] }
const many = { name: 'categories', type: 'array<Categorie>', multiplicity: '' }
synced = planSync(many, { ...many, name: 'categorie', type: '?Categorie' }, [adder], ['categories'])
assert.deepStrictEqual(synced, [{ removeOp: adder }])
synced = planSync(many, { ...many, name: 'familles', type: 'array<Famille>' }, [adder], ['categories'])
assert.deepStrictEqual(synced.map(c => [c.field, c.value]), [['name', 'addFamille'], ['type', 'Famille'], ['name', 'famille']])

// get <-> is follows bool
const getActif = { name: 'getActif', parameters: [P('', 'string', 'return')] }
synced = planSync({ name: 'actif', type: 'string', multiplicity: '' }, { name: 'actif', type: 'bool', multiplicity: '' }, [getActif], ['actif'])
assert.deepStrictEqual(synced.map(c => [c.field, c.value]), [['name', 'isActif'], ['type', 'bool']])
// Static follows
synced = planSync({ name: 'actif', type: 'string', multiplicity: '' }, { name: 'actif', type: 'string', multiplicity: '', isStatic: true }, [getActif], ['actif'])
assert.deepStrictEqual(synced, [{ assign: getActif, field: 'isStatic', value: true }])
// Rename onto a taken method name: refused with a warning
const clash = [{ name: 'getNom', parameters: [P('', 'string', 'return')] }, { name: 'getPrenom', parameters: [] }]
synced = planSync({ name: 'nom', type: 'string', multiplicity: '' }, { name: 'prenom', type: 'string', multiplicity: '' }, clash, ['nom'])
assert.deepStrictEqual(synced, [{ warn: 'getPrenom' }])

// Interfaces and abstract methods
const afficher = { name: 'afficher', isStatic: false, parameters: [P('format', 'string'), P('', 'string', 'return')] }
const iface = { operations: [afficher] }
const calculer = { name: 'calculer', isAbstract: true, parameters: [] }
const base = { operations: [calculer, { name: 'nommer', isAbstract: false, parameters: [] }] }
const concrete = { isAbstract: false, operations: [] }
assert.deepStrictEqual(requiredOps(concrete, [base], [iface]), [afficher, calculer])
assert.deepStrictEqual(requiredOps({ isAbstract: false, operations: [{ name: 'afficher', parameters: [] }] }, [base], [iface]), [calculer])
assert.deepStrictEqual(requiredOps({ isAbstract: true, operations: [] }, [base], [iface]), [])
// Implemented higher up: not required again
assert.deepStrictEqual(requiredOps(concrete, [{ operations: [{ name: 'calculer', isAbstract: false, parameters: [] }] }, base], []), [])
assert.deepStrictEqual(opSpec(afficher).params, [
  { name: 'format', type: 'string', multiplicity: '', direction: 'in' }, { name: '', type: 'string', multiplicity: '', direction: 'return' }
])
const copy = { name: 'afficher', isStatic: false, parameters: [P('format', 'string'), P('', 'string', 'return')] }
assert.deepStrictEqual(syncImplementation(afficher, copy), [])
assert.deepStrictEqual(syncImplementation({ ...afficher, name: 'imprimer', parameters: [P('', 'void', 'return')] }, copy), [
  { assign: copy, field: 'name', value: 'imprimer' },
  { replaceParams: copy, params: [{ name: '', type: 'void', multiplicity: '', direction: 'return' }] }
])

// Check diagram
const lintCls = {
  name: 'produit',
  attributes: [{ name: 'Nom', type: 'string' }, { name: 'prix', type: '' }],
  operations: [{ name: 'getPrix' }, { name: 'getStock' }, { name: 'addLigne' }, { name: 'afficher' }, { name: '__construct' }]
}
const lintMessages = lintClass(lintCls, [], ['afficher'], [{ name: 'calculer', _parent: { name: 'Base' } }]).map(p => p.message)
assert.deepStrictEqual(lintMessages, [
  'produit : nom de classe en PascalCase attendu',
  'produit : attribut « Nom » : camelCase attendu',
  'produit : attribut « prix » sans type',
  'produit : « getStock » sans attribut « stock »',
  'produit : « addLigne » sans attribut array<…> correspondant',
  'produit : méthode « calculer » de « Base » non implémentée'
])
assert.deepStrictEqual(lintClass({ name: 'Ok', attributes: [{ name: 'lignes', type: 'array<Ligne>' }], operations: [{ name: 'addLigne' }, { name: 'getLignes' }] }, [], [], []), [])
assert.deepStrictEqual(lintAssociation({ end1: end(Categorie, '1'), end2: end(Produit, '0..*', shared) }), [])
assert.deepStrictEqual(lintAssociation({ end1: end(Personne, '1'), end2: end(Adresse) }).map(p => p.message), [
  'Association Personne — Adresse : multiplicité manquante côté Adresse',
  "Association Personne — Adresse : attribut généré des deux côtés (ajoute une flèche ou un losange si un seul côté doit l'avoir)"
])

console.log('ok')
