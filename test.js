// Run: node test.js
const assert = require('assert')
const {
  planAccessors, associationFields, missingAttributes, planSync, deletedWith, renamedType, planInheritedParams
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
assert.deepStrictEqual(fields.map(f => f.name), ['domicile', 'commande'])
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

// Always nullable: __construct() empty, getDomicile(): ?Adresse, setDomicile(domicile: ?Adresse): void
const assocSpecs = planAccessors(fields, [], { ctor: true })
assert.deepStrictEqual(byName(assocSpecs, '__construct').params, [])
assert.deepStrictEqual(byName(assocSpecs, 'getDomicile').params, [
  { name: '', type: '?Adresse', multiplicity: '', direction: 'return' }
])
assert.deepStrictEqual(byName(assocSpecs, 'setDomicile').params[0], { name: 'domicile', type: '?Adresse', multiplicity: '' })
// No [0..*] copied from the association end
assert.strictEqual(byName(assocSpecs, 'getCommande').params[0].multiplicity, '')

// -domicile: ?Adresse is created unless an attribute already has that name; duplicate roles collapse
assert.deepStrictEqual(missingAttributes([{ name: 'domicile' }], fields).map(f => f.name), ['commande'])
assert.deepStrictEqual(missingAttributes([], [...fields, fields[1]]).map(f => f.name), ['domicile', 'commande'])

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

console.log('ok')
