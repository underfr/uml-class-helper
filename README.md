# UML Class Helper (StarUML)

Génère le constructeur, les getters et les setters d'une classe dans StarUML (≥ 6), au format PHP.

## Installation

StarUML → **Tools → Extension Manager → Install From URL…** → coller :

```
https://github.com/underfr/uml-class-helper
```

Puis redémarrer StarUML.

## Utilisation

Sélectionner une classe (ou seulement certains attributs), puis clic droit → **UML Helpers**, ou `Cmd/Ctrl+Alt+G`.

| Modèle | Généré |
|---|---|
| `-id: ?int` | `+getId(): ?int`, `+setId(id: ?int): void` |
| `-dateDebut: DateTime` | `+__construct(dateDebut: DateTime)`, getter, setter |
| `-actif: bool` | `+isActif(): bool` |
| `-code: string {readOnly}` | getter seulement |
| association vers `Absence` | `-absence: ?Absence`, `+getAbsence(): ?Absence`, `+setAbsence(absence: ?Absence): void` |

- `__construct` : attributs non statiques dont le type ne commence pas par `?` (ni multiplicité `0..`/`*`).
- Associations : flèche respectée ; sans flèche, navigable dans les deux sens ; rôle vide → nom de la classe.
- Rien n'est dupliqué si on relance ; un seul `Ctrl+Z` annule tout.
