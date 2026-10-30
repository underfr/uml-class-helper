# UML Class Helper (StarUML)

Generates the constructor, getters and setters of a class in StarUML (≥ 6), PHP style, and keeps them in sync as the model changes.
The extension's messages (dialogs, Check Diagram, Self-Test) are in French.

## Installation

StarUML → **Tools → Extension Manager → Install From URL…** → paste:

```
https://github.com/underfr/uml-class-helper
```

Then restart StarUML.

**Updating from a version before 0.9.0** (then named "UML Helpers"): first **Extension Manager → Installed → UML Helpers → Uninstall**, then install as above. Otherwise both versions run together; the extension warns about it at the first change.

## Usage

Select a class (or only some of its attributes), then right-click → **UML Class Helper**, or `Cmd/Ctrl+Alt+G`.
**Generate for Whole Diagram** processes every class of the open diagram.
**Check Diagram** lists the problems of the open diagram (names, missing or misspelled types such as `Boolean`, multiplicities, associations giving the same attribute or a name already taken, orphan or unimplemented methods).
**Run Self-Test** (Tools menu) checks every automatic behavior on a temporary model, preferably in an empty project.

| Model | Generated |
|---|---|
| `-id: ?int` | `+getId(): ?int`, `+setId(id: ?int): void` |
| `-startDate: DateTime` | `+__construct(startDate: DateTime)`, getter, setter |
| `-active: bool` | `+isActive(): bool` |
| `-code: string {readOnly}` | getter only |
| any class (Generate Constructor, Getters & Setters) | `+__toString(): string` |
| association to `Address` (`1` or `0..1` end) | `-address: ?Address`, `+getAddress(): ?Address`, `+setAddress(address: ?Address): void` |
| composition to `Engine` (`1` or `0..1` end) | `-engine: Engine` (never null, so no `?` and in `__construct`), getter, setter |
| association to `Product` (`0..*` end) | `-products: array<Product>`, `+getProducts()`, `+setProducts(products: array<Product>): void`, `+addProduct(product: Product): void`, `+removeProduct(product: Product): void` |
| class implementing an interface / extending an abstract class | copies of the interface methods / abstract methods |

- `__construct`: non-static attributes whose type doesn't start with `?` (nor a `0..`/`*` multiplicity).
- Associations: which class gets the attribute?
  1. arrow: the class the arrow starts from;
  2. aggregation/composition: the class on the diamond side (`Product ◇── Category` → `category` in Product);
  3. plain association: the `0..*` side gets the `1` side; otherwise both.

  Empty role → the class name, plural on the `0..*` side (French and English rules: `categories`, `travaux`, `bijoux`, `children`; name the role for a plural not handled).
  Several associations that would give the same attribute (two compositions `Chocoblast ◆── User` → `user`): generation asks a name for each, the association concerned being selected in the diagram (`target`, `blasted`), and saves it as the role name.
- Inheritance (`Employee ──▷ Person`): the child's `__construct` takes the parent's params first (`__construct(lastName, firstName, salary)`); getters/setters only for its own attributes.
- Nothing is duplicated when run again; an existing `__construct` gets the new attributes, subclasses' ones included.
- Methods are ordered: `__construct`, then for each attribute its getter, setter, `add`, `remove`, then the other methods in their order.

## Automatic

Each change and everything it entails is undone with a single `Ctrl+Z`.

- Types are written as PHP spells them: `Boolean` → `bool`, `String` → `string`, `Integer` → `int`, `Array<…>` → `array<…>`, `double` → `float`.
- Every new class gets `-id: ?int` with `getId()`/`setId()`.
- Adding an attribute creates its getter, its setter and its param in the existing `__construct`; renaming/retyping it afterwards updates them all.
- Changing an attribute's type (`-name: string` → `-name: int`) updates its getter, its setter and its `__construct` param. Switching to `?string` removes it from the constructor, back to `string` puts it back.
- Renaming an attribute (`-name` → `-label`) renames `getName`/`setName`/`isName` and the param in the setter and the `__construct`. Onto another attribute's name: renaming cancelled.
- Switching a type to `bool` renames `getX` to `isX` (and back); ticking "static" makes its methods static and removes it from the `__construct`.
- Switching to `array<T>` adds `addX`/`removeX`, back to `?T` removes them.
- Deleting an attribute deletes its getter, its setter and its `__construct` param.
- Deleting an association deletes the attribute it generated (`-category: ?Category`) and its methods, also when the class at the other end is deleted.
- Renaming a class updates the text types `?Old` → `?New` everywhere.
- Drawing an inheritance removes the child's `-id` (the parent already has it) and adds the parent's params to its `__construct` if there is one.
- Adding, renaming, retyping or deleting a parent's attribute also updates the subclasses' `__construct`.
- Editing an association (role name, multiplicity, arrow, diamond, class at one end) renames, retypes or moves the attribute it generated (`?Type` ↔ `array<Type>`, aggregation ↔ composition `?Type` ↔ `Type`, diamond moved to the other side…). An association never generated is left alone.
- Deleting an inheritance removes the inherited params from the child's `__construct` (and its subclasses') and gives it back `-id: ?int`. Reconnecting it to another parent replaces the old parent's params with the new one's.
- Implementing an interface copies its methods into the class, including those of the interfaces it extends; extending a class copies its abstract methods into the concrete subclasses. Renaming, editing or deleting the original method updates the copies; deleting the "implements" arrow, the inheritance or the interface extension removes them.
- A copy keeps a hidden link to its original method: a hand-written method with the same name is never modified or deleted. Copies made before 0.9.0 have no such link: delete them and run Generate again to have them tracked.

## Development

`node test.js` tests the logic; **Run Self-Test** checks the rest inside StarUML.
On every push to `master`, GitHub Actions runs the tests, then creates the `vX.Y.Z` release for the `package.json` version if it doesn't exist yet: bump the version to publish a release.
