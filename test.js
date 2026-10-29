// Run: node test.js
const assert = require('assert')
const { planAccessors, associationFields, missingAttributes } = require('./accessors')

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

console.log('ok')
