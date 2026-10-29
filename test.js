// Run: node test.js
const assert = require('assert')
const { planAccessors, associationFields, missingAttributes, planSync, deletedWith } = require('./accessors')

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
const Personne = { name: 'Personne' }
const Adresse = { name: 'Adresse' }
const Commande = { name: 'Commande' }
const end = (reference, navigable = 'unspecified', name = '', multiplicity = '') =>
  ({ reference, navigable, name, multiplicity, isReadOnly: false })
const assocs = [
  // Personne --> Adresse (directed, role "domicile", 1)
  { end1: end(Personne), end2: end(Adresse, 'navigable', 'domicile', '1') },
  // Personne -- Commande (no arrow: both ways, unnamed role, 0..*)
  { end1: end(Commande, 'unspecified', '', '0..*'), end2: end(Personne, 'unspecified', '', '1') },
  // Personne x-- Adresse (notNavigable toward Adresse)
  { end1: end(Personne), end2: end(Adresse, 'notNavigable', 'ancienne') }
]
const fields = associationFields(Personne, assocs)
assert.deepStrictEqual(fields.map(f => f.name), ['domicile', 'commande'])
assert.strictEqual(fields[0].type, '?Adresse')
// Other side of a directed association gets nothing; undirected gets the opposite end
assert.deepStrictEqual(associationFields(Adresse, assocs.slice(0, 1)), [])
assert.deepStrictEqual(associationFields(Commande, assocs).map(f => f.name), ['personne'])
// Self-association: both ends belong to the class
assert.deepStrictEqual(associationFields(Personne, [
  { end1: end(Personne, 'unspecified', 'parent'), end2: end(Personne, 'unspecified', 'enfant') }
]).map(f => f.name), ['enfant', 'parent'])

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

console.log('ok')
